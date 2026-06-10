import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { runShare, runRevoke, parseExpires } from '../src/share.js';
import { CliError } from '../src/errors.js';
import { loadConfig } from '../src/config.js';
import { silentUi, throwingPrompts, tmpdir, writeTree } from './helpers.js';

async function senderDeps() {
  const cwd = await tmpdir('skillshark-sender-');
  return {
    cwd,
    home: await tmpdir('skillshark-senderhome-'),
    env: {},
    isTTY: false,
    configDir: await tmpdir('skillshark-cfg-'),
    ui: silentUi(),
    prompts: throwingPrompts(),
    fetch: async () => {
      throw new Error('share must not use anonymous fetch');
    },
    clipboard: async () => true,
  };
}

async function makeSkill(cwd, name = 'demo') {
  await writeTree(
    {
      [`.claude/skills/${name}/SKILL.md`]: `---\nname: ${name}\ndescription: Demo skill.\n---\n# ${name}\n`,
      [`.claude/skills/${name}/scripts/hello.sh`]: { content: '#!/bin/sh\necho hi\n', mode: 0o755 },
      [`.claude/skills/${name}/.env`]: 'SECRET=1',
    },
    cwd,
  );
}

test('integration: share builds the exact gist JSON body (description format, public:false, three files)', async () => {
  const deps = await senderDeps();
  await makeSkill(deps.cwd, 'demo');

  let capturedBody = null;
  let capturedArgs = null;
  deps.ghApi = async (args) => {
    capturedArgs = args;
    const inputIdx = args.indexOf('--input');
    capturedBody = JSON.parse(await readFile(args[inputIdx + 1], 'utf8'));
    return JSON.stringify({ id: 'feedfacefeedfacefeedfacefeedface', history: [{ version: 'deadbeefrev' }] });
  };

  const res = await runShare('demo', { noClipboard: true, noEncrypt: true }, deps);

  // the gh call shape
  assert.deepEqual(capturedArgs.slice(0, 3), ['gists', '--method', 'POST']);
  // the body
  assert.equal(capturedBody.public, false, 'must be a secret gist');
  const fp8 = res.fingerprint.slice(0, 8);
  assert.equal(capturedBody.description, `skillshark: demo (claude-code skill) · fp ${fp8}`);
  const fileNames = Object.keys(capturedBody.files).sort();
  assert.deepEqual(fileNames, ['SKILL.md', 'SKILLSHARK.json', 'package.tgz.b64']);

  // SKILLSHARK.json is the manifest verbatim
  const manifest = JSON.parse(capturedBody.files['SKILLSHARK.json'].content);
  assert.equal(manifest.name, 'demo');
  assert.equal(manifest.type, 'skill');
  assert.equal(manifest.agent, 'claude-code');
  assert.equal(manifest.fingerprint, res.fingerprint);
  // .env excluded; hello.sh executable recorded
  const paths = manifest.files.map((f) => f.path);
  assert.deepEqual(paths, ['SKILL.md', 'scripts/hello.sh']);
  assert.equal(manifest.files.find((f) => f.path === 'scripts/hello.sh').executable, true);

  // payload is a valid gzip of a tar containing skillshark.json
  const tarball = Buffer.from(capturedBody.files['package.tgz.b64'].content, 'base64');
  assert.equal(tarball[0], 0x1f);
  assert.equal(tarball[1], 0x8b);
  assert.ok(gunzipSync(tarball).includes('skillshark.json'));

  // canonical link + share record
  assert.equal(res.url, `https://gist.github.com/feedfacefeedfacefeedfacefeedface#fp=${fp8}`);
  const cfg = await loadConfig(deps.configDir);
  assert.equal(cfg.shares[0].id, 'feedfacefeedfacefeedfacefeedface');
  assert.equal(cfg.shares[0].revision, 'deadbeefrev');

  // warning surfaced for the skipped .env
  assert.match(deps.ui.text(), /Skipped \.env \(secret pattern\) — pass --force to include/);
});

test('share --dry-run uploads nothing and prints the file list + fingerprint', async () => {
  const deps = await senderDeps();
  await makeSkill(deps.cwd, 'dry');
  deps.ghApi = async () => {
    throw new Error('dry-run must not call gh');
  };
  const res = await runShare('dry', { dryRun: true }, deps);
  assert.equal(res.status, 'dry-run');
  assert.match(deps.ui.text(), /SKILL\.md/);
  assert.match(deps.ui.text(), /nothing uploaded/);
});

test('share rejects payloads over the 5 MB gist limit with the exact guidance', async () => {
  const deps = await senderDeps();
  const big = 'x'.repeat(6 * 1024 * 1024); // incompressible enough? no — repeat compresses well
  // use random bytes so gzip cannot save us
  const { randomBytes } = await import('node:crypto');
  const dir = path.join(deps.cwd, 'bigskill');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), '# big');
  await writeFile(path.join(dir, 'blob.bin'), randomBytes(5 * 1024 * 1024));
  deps.ghApi = async () => {
    throw new Error('oversized share must not reach gh');
  };
  await assert.rejects(
    () => runShare(dir, {}, deps),
    (e) => e instanceof CliError && e.exitCode === 2 && /gist limit ~5 MB/.test(e.message) && /gh:owner\/repo\/path/.test(e.message),
  );
  assert.ok(big);
});

test('--expires accepts exactly 30m|6h|24h|7d|30d and rejects everything else with exit 2', () => {
  for (const [v, ms] of [['30m', 1800000], ['6h', 21600000], ['24h', 86400000], ['7d', 604800000], ['30d', 2592000000]]) {
    assert.equal(parseExpires(v).ms, ms);
  }
  assert.equal(parseExpires(undefined).key, '7d');
  for (const bad of ['1d', '7', 'never', '0m', '']) {
    assert.throws(() => parseExpires(bad), (e) => e instanceof CliError && e.exitCode === 2);
  }
});

test('share of an unknown name exits 2 with suggestions; ambiguous non-TTY exits 2 listing matches', async () => {
  const deps = await senderDeps();
  await makeSkill(deps.cwd, 'jump');
  await assert.rejects(
    () => runShare('jmp', {}, deps),
    (e) => e instanceof CliError && e.exitCode === 2 && /jump/.test(e.message),
  );
  // same name as both a skill and a command → ambiguous in non-TTY
  await writeTree({ '.claude/commands/jump.md': 'cmd' }, deps.cwd);
  await assert.rejects(
    () => runShare('jump', {}, deps),
    (e) => e instanceof CliError && e.exitCode === 2 && /ambiguous/.test(e.message),
  );
});

test('share --force includes secret-shaped files and warns about nothing', async () => {
  const deps = await senderDeps();
  await makeSkill(deps.cwd, 'leaky');
  let manifest = null;
  deps.ghApi = async (args) => {
    const body = JSON.parse(await readFile(args[args.indexOf('--input') + 1], 'utf8'));
    manifest = JSON.parse(body.files['SKILLSHARK.json'].content);
    return JSON.stringify({ id: 'a'.repeat(32), history: [{ version: 'r' }] });
  };
  await runShare('leaky', { force: true, noClipboard: true, noEncrypt: true }, deps);
  assert.ok(manifest.files.some((f) => f.path === '.env'), '--force must include .env');
});

test('revoke by id calls gh DELETE and prunes the share record', async () => {
  const deps = await senderDeps();
  const calls = [];
  deps.ghApi = async (args) => {
    calls.push(args);
    return '';
  };
  const id = 'feedfacefeedfacefeedfacefeedface';
  const { addShareRecord } = await import('../src/config.js');
  await addShareRecord(deps.configDir, { id, name: 'demo', url: 'u', revision: 'r', expiresAt: null });

  await runRevoke(id, { yes: true }, deps);
  assert.deepEqual(calls, [['--method', 'DELETE', `gists/${id}`]]);
  const cfg = await loadConfig(deps.configDir);
  assert.equal(cfg.shares.length, 0);
});

test('revoke by name resolves through the local share cache', async () => {
  const deps = await senderDeps();
  const calls = [];
  deps.ghApi = async (args) => {
    calls.push(args);
    return '';
  };
  const id = 'beefbeefbeefbeefbeefbeefbeefbeef';
  const { addShareRecord } = await import('../src/config.js');
  await addShareRecord(deps.configDir, { id, name: 'mything', url: 'u', revision: 'r', expiresAt: null });
  await runRevoke('mything', { yes: true }, deps);
  assert.deepEqual(calls, [['--method', 'DELETE', `gists/${id}`]]);
});
