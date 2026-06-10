import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import {
  extractTarball,
  hashTree,
  readManifest,
  verifyTreeAgainstManifest,
  ExtractError,
} from '../src/pkg.js';
import { MSG } from '../src/errors.js';
import { tarEntry, makeTgz, tmpdir, makePackage } from './helpers.js';

async function extractInto(tgz, opts) {
  const parent = await tmpdir();
  const root = path.join(parent, 'root');
  await mkdir(root);
  let error = null;
  try {
    await extractTarball(tgz, root, opts);
  } catch (e) {
    error = e;
  }
  return { parent, root, error };
}

test('§8.2 path traversal: tarball with ../evil.txt aborts; nothing written outside the root', async () => {
  const tgz = makeTgz([
    tarEntry('ok.txt', 'fine'),
    tarEntry('../evil.txt', 'evil'),
  ]);
  const { parent, root, error } = await extractInto(tgz);
  assert.ok(error instanceof ExtractError, 'extraction must throw');
  assert.match(error.message, /path traversal/);
  assert.ok(!existsSync(path.join(parent, 'evil.txt')), 'nothing may exist outside the extraction root');
  // all-or-nothing: the valid sibling entry must not have been written either
  assert.equal((await readdir(root)).length, 0, 'aborted extraction must leave the root empty');
});

test('§8.2 nested traversal (a/../../evil) and exact-root escape are rejected', async () => {
  for (const name of ['a/../../evil.txt', 'a/b/../../../evil.txt']) {
    const { parent, error } = await extractInto(makeTgz([tarEntry(name, 'x')]));
    assert.ok(error, `${name} must abort`);
    assert.ok(!existsSync(path.join(parent, 'evil.txt')));
  }
});

test('§8.3 absolute path entry aborts', async () => {
  const { error, root } = await extractInto(makeTgz([tarEntry('/abs/evil.txt', 'x')]));
  assert.ok(error instanceof ExtractError);
  assert.match(error.message, /absolute path/);
  assert.equal((await readdir(root)).length, 0);

  const drive = await extractInto(makeTgz([tarEntry('C:/evil.txt', 'x')]));
  assert.ok(drive.error instanceof ExtractError);
  assert.match(drive.error.message, /drive letter/);
});

test('§8.4 symlink entry aborts (and so do hardlinks, fifos, devices)', async () => {
  const cases = [
    ['2', 'SymbolicLink'],
    ['1', 'Link'],
    ['6', 'FIFO'],
    ['3', 'CharacterDevice'],
  ];
  for (const [type] of cases) {
    const tgz = makeTgz([
      tarEntry('safe.txt', 'ok'),
      tarEntry('evil-link', Buffer.alloc(0), { type, linkname: '/etc/passwd' }),
    ]);
    const { error, root } = await extractInto(tgz);
    assert.ok(error instanceof ExtractError, `type ${type} must abort`);
    // symlinks/hardlinks hit our own type filter; fifo/device headers with a
    // linkname are already rejected by the parser as malformed — both abort
    assert.match(error.message, /not allowed|malformed archive/);
    assert.equal((await readdir(root)).length, 0, 'no partial extraction');
  }
});

test('§8.5 decompression bomb: small .gz expanding past 50 MB aborts mid-stream', async () => {
  const fullSize = 64 * 1024 * 1024; // 64 MB of zeros → tiny gzip
  const tgz = makeTgz([tarEntry('bomb.bin', Buffer.alloc(fullSize))]);
  assert.ok(tgz.length < 1024 * 1024, `fixture gz should be small, got ${tgz.length}`);
  const { error, root } = await extractInto(tgz);
  assert.ok(error instanceof ExtractError, 'bomb must abort');
  assert.match(error.message, /safety limit/);
  assert.ok(error.details?.bytesSeen, 'error carries the byte counter');
  assert.ok(
    error.details.bytesSeen < fullSize,
    `must abort mid-stream, not after full inflation (saw ${error.details.bytesSeen})`,
  );
  assert.equal((await readdir(root)).length, 0);
});

test('§8.6 file-count bomb: >500 entries aborts', async () => {
  const entries = [];
  for (let i = 0; i <= 500; i++) entries.push(tarEntry(`f${i}.txt`, 'x'));
  const { error, root } = await extractInto(makeTgz(entries));
  assert.ok(error instanceof ExtractError);
  assert.match(error.message, /too many files/);
  assert.equal((await readdir(root)).length, 0);
});

test('§8.7 sha256 mismatch between manifest and content aborts; target untouched', async () => {
  // a self-consistent-looking package whose manifest lies about SKILL.md's hash
  const manifest = {
    skillshark: '2',
    name: 'liar',
    type: 'skill',
    agent: 'claude-code',
    files: [{ path: 'SKILL.md', size: 5, sha256: 'f'.repeat(64), mode: '0644', executable: false }],
    fingerprint: null,
  };
  const tgz = makeTgz([
    tarEntry('skillshark.json', JSON.stringify(manifest)),
    tarEntry('SKILL.md', 'hello'),
  ]);
  const { root, error } = await extractInto(tgz);
  assert.equal(error, null, 'extraction itself succeeds; verification is the gate');
  const m = await readManifest(root);
  const actual = await hashTree(root);
  assert.throws(() => verifyTreeAgainstManifest(actual, m), (e) => e.message === MSG.downloadIntegrity);
});

test('§8.7 extra file smuggled next to a valid manifest also fails verification', async () => {
  const { tarball, manifest } = await makePackage({ 'SKILL.md': '# ok' });
  // re-make the tarball with one extra file the manifest does not declare
  const root = path.join(await tmpdir(), 'r');
  await mkdir(root);
  await extractTarball(tarball, root);
  const m = await readManifest(root);
  const actual = await hashTree(root);
  // sanity: untampered verifies
  assert.equal(verifyTreeAgainstManifest(actual, m), manifest.fingerprint);
  // now an extra undeclared file appears
  const tampered = [...actual, { path: 'extra.sh', size: 1, sha256: 'a'.repeat(64), executable: false }];
  assert.throws(() => verifyTreeAgainstManifest(tampered, m), (e) => e.message === MSG.downloadIntegrity);
  // and a manifest whose own fingerprint disagrees with its files
  const lying = { ...m, fingerprint: '0'.repeat(64) };
  assert.throws(() => verifyTreeAgainstManifest(actual, lying), (e) => e.message === MSG.downloadIntegrity);
});

test('§8.8 exec bits: 0755 entry extracts with the bit, hashTree reports it (install strips by default)', async () => {
  const tgz = makeTgz([
    tarEntry('scripts/hello.sh', '#!/bin/sh\necho hi\n', { mode: 0o755 }),
    tarEntry('SKILL.md', '# x'),
  ]);
  const root = path.join(await tmpdir(), 'r');
  await mkdir(root);
  await extractTarball(tgz, root);
  const sh = await stat(path.join(root, 'scripts', 'hello.sh'));
  assert.ok(sh.mode & 0o111, 'extraction to the temp dir preserves the bit for staging to decide');
  const tree = await hashTree(root);
  const entry = tree.find((f) => f.path === 'scripts/hello.sh');
  assert.equal(entry.executable, true);
  const md = tree.find((f) => f.path === 'SKILL.md');
  assert.equal(md.executable, false);
});

test('round trip: buildTarball → extractTarball → verifyTreeAgainstManifest', async () => {
  const { tarball, manifest, fingerprint } = await makePackage({
    'SKILL.md': '---\nname: j\n---\n# j\n',
    'scripts/jump.sh': { content: '#!/bin/sh\n', executable: true },
    'README.md': 'readme',
  });
  const root = path.join(await tmpdir(), 'r');
  await mkdir(root);
  await extractTarball(tarball, root);
  const m = await readManifest(root);
  assert.equal(m.name, 'fixture');
  const actual = await hashTree(root);
  assert.equal(verifyTreeAgainstManifest(actual, m), fingerprint);
  assert.equal((await readFile(path.join(root, 'SKILL.md'), 'utf8')), '---\nname: j\n---\n# j\n');
});

test('corrupt gzip aborts cleanly', async () => {
  const { error } = await extractInto(Buffer.from('definitely not gzip'));
  assert.ok(error instanceof ExtractError);
  assert.match(error.message, /gzip/);
});

test('truncated tar stream aborts instead of resolving', async () => {
  const whole = makeTgz([tarEntry('a.txt', 'x'.repeat(5000))]);
  const inner = Buffer.from('x'.repeat(5000));
  const truncated = gzipSync(tarEntry('a.txt', inner).subarray(0, 600)); // header + partial body, no terminator
  const { error } = await extractInto(truncated);
  assert.ok(error, 'truncated archive must error');
  assert.ok(whole.length > 0);
});
