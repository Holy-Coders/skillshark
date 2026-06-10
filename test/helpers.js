// Shared test utilities: raw tar crafting (for malicious fixtures the real
// builder would refuse to produce), package fixtures, and a fake fetch.
import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { buildTarball } from '../src/pkg.js';
import { sha256hex, treeFingerprint } from '../src/fingerprint.js';
import { VERSION } from '../src/version.js';

// One raw ustar entry (512-byte header + padded content).
export function tarEntry(name, content = Buffer.alloc(0), { type = '0', mode = 0o644, linkname = '' } = {}) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8);
  h.write('0000000\0', 108, 8);
  h.write('0000000\0', 116, 8);
  h.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 12);
  h.write('0000000\0', 136, 12);
  h.write('        ', 148, 8);
  h.write(type, 156, 1);
  h.write(linkname, 157, 100);
  h.write('ustar\0', 257, 6);
  h.write('00', 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  const pad = Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length);
  return Buffer.concat([h, body, pad]);
}

// Gzipped tarball from raw entries.
export function makeTgz(entries) {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

export async function tmpdir(prefix = 'skillshark-test-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

// Materialize { 'rel/path': content | {content, mode} } under a fresh temp dir.
export async function writeTree(spec, root = null) {
  const dir = root ?? (await tmpdir());
  for (const [rel, val] of Object.entries(spec)) {
    const abs = path.join(dir, ...rel.split('/'));
    await mkdir(path.dirname(abs), { recursive: true });
    const content = typeof val === 'object' && !Buffer.isBuffer(val) ? val.content : val;
    await writeFile(abs, content);
    if (typeof val === 'object' && val.mode) await chmod(abs, val.mode);
  }
  return dir;
}

// A valid SkillShark package built through the real builder.
// spec: { 'rel/path': content | {content, executable} }
export async function makePackage(spec, manifestOverrides = {}) {
  const dir = await tmpdir('skillshark-fixture-');
  const files = [];
  for (const [rel, val] of Object.entries(spec)) {
    const isObj = typeof val === 'object' && !Buffer.isBuffer(val);
    const content = isObj ? val.content : val;
    const abs = path.join(dir, ...rel.split('/'));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
    const buf = Buffer.from(content);
    files.push({
      path: rel,
      abs,
      size: buf.length,
      sha256: sha256hex(buf),
      mode: isObj && val.executable ? '0755' : '0644',
      executable: Boolean(isObj && val.executable),
    });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const fingerprint = treeFingerprint(files);
  const manifest = {
    skillshark: '2',
    name: 'fixture',
    type: 'skill',
    agent: 'claude-code',
    description: 'A test fixture skill.',
    files: files.map(({ abs, ...rest }) => rest),
    totalSize: files.reduce((n, f) => n + f.size, 0),
    createdAt: '2026-06-01T00:00:00.000Z',
    expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    tool: { name: 'skillshark', version: VERSION },
    dependencies: [],
    fingerprint,
    ...manifestOverrides,
  };
  const { tarball, manifestJson } = await buildTarball(
    files.map((f) => ({ path: f.path, abs: f.abs, executable: f.executable })),
    manifest,
  );
  return { tarball, manifest, manifestJson, fingerprint, files, sourceDir: dir };
}

// Recorded-style gist API response wrapping a tarball.
export function gistApiResponse(id, tarball, { login = 'fixture-user', description = 'skillshark: fixture' } = {}) {
  return {
    id,
    description,
    public: false,
    owner: { login },
    history: [{ version: 'cafebabecafebabecafebabecafebabecafebabe' }],
    files: {
      'SKILLSHARK.json': { filename: 'SKILLSHARK.json', truncated: false, content: '{}' },
      'package.tgz.b64': {
        filename: 'package.tgz.b64',
        truncated: false,
        content: tarball.toString('base64'),
        raw_url: `https://gist.githubusercontent.com/x/${id}/raw/package.tgz.b64`,
      },
    },
  };
}

// fetch stub: routes[urlSubstring] = Response | () => Response. Records calls.
export function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    for (const [key, val] of Object.entries(routes)) {
      if (String(url).includes(key)) {
        const v = typeof val === 'function' ? val(url) : val;
        if (v instanceof Response) {
          // Response bodies can only be consumed once; clone per call
          return v.clone();
        }
        return new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response('not found', { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

// execFile stub that fails the test if the receive path ever shells out.
export function explodingExecFile() {
  const fn = async (...args) => {
    throw new Error(`execFile was invoked by the receive path: ${JSON.stringify(args[0])} ${JSON.stringify(args[1])}`);
  };
  return fn;
}

// Silent UI + prompt stubs for driving the pipeline in tests.
export function silentUi() {
  const lines = [];
  const push = (s = '') => lines.push(String(s));
  return {
    lines,
    colors: new Proxy({}, { get: () => (s) => s }),
    out: push,
    raw: push,
    err: push,
    ok: push,
    warn: push,
    info: push,
    fail: push,
    text: () => lines.join('\n'),
  };
}

export function throwingPrompts() {
  const boom = async () => {
    throw new Error('interactive prompt invoked in a non-interactive test');
  };
  return { select: boom, confirm: boom };
}
