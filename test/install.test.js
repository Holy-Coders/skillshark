import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInstall, runInspect, diffTrees, expiryState } from '../src/install.js';
import { CliError, MSG } from '../src/errors.js';
import { loadInstalls } from '../src/config.js';
import {
  makePackage,
  gistApiResponse,
  fakeFetch,
  silentUi,
  throwingPrompts,
  tmpdir,
  tarEntry,
  makeTgz,
  writeTree,
} from './helpers.js';

const execFileP = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GIST_ID = 'feedfacefeedfacefeedfacefeedface';

async function makeDeps({ routes = {}, cwd = null, home = null } = {}) {
  return {
    fetch: fakeFetch(routes),
    cwd: cwd ?? (await tmpdir('skillshark-cwd-')),
    home: home ?? (await tmpdir('skillshark-home-')),
    env: {},
    isTTY: false,
    configDir: await tmpdir('skillshark-cfg-'),
    ui: silentUi(),
    prompts: throwingPrompts(),
    ghApi: async () => {
      throw new Error('gh invoked by the receive path');
    },
    clipboard: async () => false,
  };
}

function gistRoutes(pkg, id = GIST_ID) {
  return { [`api.github.com/gists/${id}`]: gistApiResponse(id, pkg.tarball) };
}

// --- §8.12 -------------------------------------------------------------------

test('§8.12 advisory expiry: install refuses with exit 1 and the exact message; inspect still displays', async () => {
  const expiresAt = new Date(Date.now() - 3.5 * 86400000).toISOString();
  const pkg = await makePackage({ 'SKILL.md': '# expired' }, { expiresAt, name: 'oldie' });
  const deps = await makeDeps({ routes: gistRoutes(pkg) });

  await assert.rejects(
    () => runInstall(GIST_ID, { yes: true, dir: path.join(deps.cwd, 'out') }, deps),
    (e) => {
      assert.ok(e instanceof CliError);
      assert.equal(e.exitCode, 1);
      assert.equal(
        e.message,
        'The sender marked this share as expired 3 days ago.\n' +
          'The files still exist until they prune — ask for a fresh link:  skillshark share oldie',
      );
      return true;
    },
  );
  assert.ok(!existsSync(path.join(deps.cwd, 'out')), 'nothing written for an expired share');

  // inspect does display expired shares (§4.3)
  const inspectDeps = await makeDeps({ routes: gistRoutes(pkg) });
  await runInspect(GIST_ID, {}, inspectDeps);
  const text = inspectDeps.ui.text();
  assert.match(text, /expired 3 days ago/);
  assert.match(text, /oldie/);
  assert.match(text, /install will refuse/);
});

test('§8.12 expiryState math: live, hour-resolution, and expired', () => {
  const now = Date.UTC(2026, 5, 10);
  assert.equal(expiryState({ expiresAt: null }, now).state, 'none');
  assert.equal(expiryState({ expiresAt: new Date(now + 6.5 * 86400000).toISOString() }, now).days, 6);
  const fresh = expiryState({ expiresAt: new Date(now - 60000).toISOString() }, now);
  assert.deepEqual([fresh.state, fresh.days], ['expired', 1], 'just-expired rounds up to 1 day');
  assert.equal(expiryState({ expiresAt: new Date(now - 2.2 * 86400000).toISOString() }, now).days, 2);
});

// --- §8.13 -------------------------------------------------------------------

test('§8.13 conflict: identical fingerprint → benign no-op, exit 0, nothing rewritten', async () => {
  const pkg = await makePackage({ 'SKILL.md': '# same', 'a.txt': 'a' }, { name: 'samey' });
  const deps = await makeDeps({ routes: gistRoutes(pkg) });
  const dir = path.join(deps.cwd, 'samey');

  const first = await runInstall(GIST_ID, { yes: true, dir }, deps);
  assert.equal(first.status, 'installed');
  const before = await stat(path.join(dir, 'SKILL.md'));

  const again = await runInstall(GIST_ID, { yes: true, dir }, deps);
  assert.equal(again.status, 'identical');
  assert.match(deps.ui.text(), /"samey" is already installed at .* and is identical \([0-9a-f]{4}-[0-9a-f]{4}\)\. Nothing to do\./);
  const after = await stat(path.join(dir, 'SKILL.md'));
  assert.equal(before.mtimeMs, after.mtimeMs, 'identical install must not rewrite files');
});

test('§8.13 conflict: differing content computes correct added/changed/removed sets', async () => {
  const existing = [
    { path: 'SKILL.md', sha256: 'aaa' },
    { path: 'old-helper.md', sha256: 'bbb' },
    { path: 'same.md', sha256: 'ccc' },
  ];
  const incoming = [
    { path: 'SKILL.md', sha256: 'NEW' },
    { path: 'scripts/new.sh', sha256: 'ddd' },
    { path: 'same.md', sha256: 'ccc' },
  ];
  assert.deepEqual(diffTrees(existing, incoming), {
    added: ['scripts/new.sh'],
    changed: ['SKILL.md'],
    removed: ['old-helper.md'],
  });
});

test('§8.13 conflict: non-TTY differing target without --force exits 1; --force overwrites', async () => {
  const v1 = await makePackage({ 'SKILL.md': '# v1' }, { name: 'thing' });
  const v2 = await makePackage({ 'SKILL.md': '# v2', 'new.md': 'n' }, { name: 'thing' });
  const deps = await makeDeps();
  const dir = path.join(deps.cwd, 'thing');

  deps.fetch = fakeFetch(gistRoutes(v1));
  await runInstall(GIST_ID, { yes: true, dir }, deps);

  deps.fetch = fakeFetch(gistRoutes(v2));
  await assert.rejects(
    () => runInstall(GIST_ID, { yes: true, dir }, deps),
    (e) => e instanceof CliError && e.exitCode === 1 && /already exists/.test(e.message) && /--force/.test(e.message),
  );
  assert.equal(await readFile(path.join(dir, 'SKILL.md'), 'utf8'), '# v1', 'refused overwrite leaves v1');

  await runInstall(GIST_ID, { yes: true, force: true, dir }, deps);
  assert.equal(await readFile(path.join(dir, 'SKILL.md'), 'utf8'), '# v2');
  assert.equal(await readFile(path.join(dir, 'new.md'), 'utf8'), 'n');
});

// --- §8.14 -------------------------------------------------------------------

test('§8.14 atomic abort: injected failure after staging, before rename → target absent, no debris', async () => {
  const pkg = await makePackage({ 'SKILL.md': '# atom', 'sub/file.txt': 'x' }, { name: 'atom' });
  const deps = await makeDeps({ routes: gistRoutes(pkg) });
  const dir = path.join(deps.cwd, 'atom');
  deps.beforeRename = () => {
    throw new Error('injected failure between staging and rename');
  };
  await assert.rejects(() => runInstall(GIST_ID, { yes: true, dir }, deps), /injected failure/);
  assert.ok(!existsSync(dir), 'target must not exist after an aborted install');
  const leftovers = (await readdir(deps.cwd)).filter((n) => n.includes('skillshark'));
  assert.deepEqual(leftovers, [], 'staging dir must be cleaned up');
});

test('§8.14 atomic abort over an existing target leaves the old version untouched', async () => {
  const v1 = await makePackage({ 'SKILL.md': '# v1' }, { name: 'keep' });
  const v2 = await makePackage({ 'SKILL.md': '# v2' }, { name: 'keep' });
  const deps = await makeDeps();
  const dir = path.join(deps.cwd, 'keep');
  deps.fetch = fakeFetch(gistRoutes(v1));
  await runInstall(GIST_ID, { yes: true, dir }, deps);

  deps.fetch = fakeFetch(gistRoutes(v2));
  deps.beforeRename = () => {
    throw new Error('boom');
  };
  await assert.rejects(() => runInstall(GIST_ID, { yes: true, force: true, dir }, deps), /boom/);
  assert.equal(await readFile(path.join(dir, 'SKILL.md'), 'utf8'), '# v1', 'old version survives the abort');
});

// --- §8.15 -------------------------------------------------------------------

test('§8.15 #fp= mismatch aborts with the exact integrity message; nothing written', async () => {
  const pkg = await makePackage({ 'SKILL.md': '# tampered' }, { name: 'tamper' });
  const deps = await makeDeps({ routes: gistRoutes(pkg) });
  const dir = path.join(deps.cwd, 'out');
  await assert.rejects(
    () => runInstall(`https://gist.github.com/${GIST_ID}#fp=deadbeef`, { yes: true, dir }, deps),
    (e) => e instanceof CliError && e.exitCode === 1 && e.message === MSG.linkIntegrity,
  );
  assert.ok(!existsSync(dir));
});

test('§8.15 matching #fp= verifies and reports "matches" in inspect', async () => {
  const pkg = await makePackage({ 'SKILL.md': '# good' }, { name: 'good' });
  const deps = await makeDeps({ routes: gistRoutes(pkg) });
  const link = `https://gist.github.com/${GIST_ID}#fp=${pkg.fingerprint.slice(0, 8)}`;
  await runInspect(link, {}, deps);
  assert.match(deps.ui.text(), /matches the link/);
});

// --- §8.16 -------------------------------------------------------------------

test('§8.16 exec spy: gist install+inspect never invoke execFile/gh (recorded fixture, stub throws)', async (t) => {
  const pkg = await makePackage({ 'SKILL.md': '# pure', 'tool.sh': { content: '#!/bin/sh\n', executable: true } }, { name: 'pure' });
  let exploded = false;
  const deps = await makeDeps({ routes: gistRoutes(pkg) });
  deps.ghApi = async () => {
    exploded = true;
    throw new Error('gh invoked by the receive path');
  };
  await runInstall(GIST_ID, { yes: true, dir: path.join(deps.cwd, 'pure') }, deps);
  await runInspect(GIST_ID, { cat: 'SKILL.md' }, deps);
  assert.equal(exploded, false, 'gh must never be called for a public gist receive');
});

test('§8.16 exec spy: repo install via codeload never invokes execFile/gh', async () => {
  const sha = '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d';
  const repoTgz = makeTgz([
    tarEntry(`Hello-World-${sha}/`, Buffer.alloc(0), { type: '5' }),
    tarEntry(`Hello-World-${sha}/README`, 'Hello World!\n'),
  ]);
  const deps = await makeDeps({
    routes: { [`codeload.github.com/octocat/Hello-World/tar.gz/${sha}`]: new Response(repoTgz) },
  });
  let exploded = false;
  deps.ghApi = async () => {
    exploded = true;
    throw new Error('gh invoked by the receive path');
  };
  const dir = path.join(deps.cwd, 'hw');
  await runInstall(`gh:octocat/Hello-World@${sha}`, { yes: true, dir }, deps);
  assert.equal(await readFile(path.join(dir, 'README'), 'utf8'), 'Hello World!\n');
  // pinned SHA install needs no api.github.com call at all — codeload only
  assert.ok(deps.fetch.calls.every((u) => u.includes('codeload.github.com')), deps.fetch.calls.join(','));
  await runInspect(`gh:octocat/Hello-World@${sha}`, {}, deps);
  assert.equal(exploded, false, 'gh must never be called for a public repo receive');
});

test('§8.16 static guarantee: no child_process import anywhere in the receive path', async () => {
  const receiveModules = [
    'src/install.js',
    'src/pkg.js',
    'src/fingerprint.js',
    'src/source.js',
    'src/discover.js',
    'src/config.js',
    'src/ui.js',
    'src/errors.js',
    'src/transports/gist.js',
    'src/transports/repo.js',
  ];
  for (const rel of receiveModules) {
    const text = await readFile(path.join(ROOT, rel), 'utf8');
    assert.ok(!text.includes('child_process'), `${rel} must not touch child_process`);
    assert.ok(!/\beval\s*\(/.test(text), `${rel} must not eval`);
  }
});

// --- §8.17 -------------------------------------------------------------------

test('§8.17 non-TTY install without --yes exits 2 with guidance, without hanging or fetching', async () => {
  // through the pipeline directly: rejects before any fetch
  const deps = await makeDeps();
  let fetched = false;
  deps.fetch = async () => {
    fetched = true;
    throw new Error('network must not be touched');
  };
  await assert.rejects(
    () => runInstall(GIST_ID, {}, deps),
    (e) => e instanceof CliError && e.exitCode === 2 && /--yes/.test(e.message),
  );
  assert.equal(fetched, false);

  // and through the real binary with piped stdio (no TTY): exit 2, fast
  const child = execFileP(process.execPath, [path.join(ROOT, 'bin', 'skillshark.js'), 'install', GIST_ID], {
    timeout: 10000,
    env: { ...process.env, SKILLSHARK_CONFIG_DIR: await tmpdir() },
  });
  const err = await child.then(
    () => null,
    (e) => e,
  );
  assert.ok(err, 'must exit non-zero');
  assert.equal(err.code, 2);
  assert.match(String(err.stderr), /--yes/);
});

// --- integration ----------------------------------------------------------------

test('integration: recorded gist response → end-to-end install into a temp project (scope detection via .git)', async () => {
  const pkg = await makePackage(
    {
      'SKILL.md': '---\nname: demo\ndescription: A demo.\n---\n# demo\n',
      'scripts/hello.sh': { content: '#!/bin/sh\necho hello\n', executable: true },
    },
    { name: 'demo', type: 'skill', agent: 'claude-code' },
  );
  const deps = await makeDeps({ routes: gistRoutes(pkg) });
  await mkdir(path.join(deps.cwd, '.git'), { recursive: true }); // looks like a project

  const res = await runInstall(GIST_ID, { yes: true }, deps);
  const expected = path.join(deps.cwd, '.claude', 'skills', 'demo');
  assert.equal(res.target, expected);
  assert.equal(await readFile(path.join(expected, 'SKILL.md'), 'utf8'), '---\nname: demo\ndescription: A demo.\n---\n# demo\n');

  // §8.8 — exec bit stripped by default
  const mode = (await stat(path.join(expected, 'scripts', 'hello.sh'))).mode & 0o777;
  assert.equal(mode, 0o644, `hello.sh must not be executable, got ${mode.toString(8)}`);

  // install record written
  const records = await loadInstalls(deps.configDir);
  assert.equal(records.length, 1);
  assert.equal(records[0].name, 'demo');
  assert.match(records[0].source, new RegExp(`^gist:${GIST_ID}@`));

  // §8.8 — preserved with --allow-exec
  const deps2 = await makeDeps({ routes: gistRoutes(pkg) });
  const dir2 = path.join(deps2.cwd, 'demo2');
  await runInstall(GIST_ID, { yes: true, allowExec: true, dir: dir2 }, deps2);
  const mode2 = (await stat(path.join(dir2, 'scripts', 'hello.sh'))).mode & 0o777;
  assert.equal(mode2, 0o755, '--allow-exec must preserve the bit');
});

test('integration: non-TTY --yes outside a project without scope flags exits 2', async () => {
  const pkg = await makePackage({ 'SKILL.md': '# x' }, { name: 'scopeless' });
  const deps = await makeDeps({ routes: gistRoutes(pkg) });
  await assert.rejects(
    () => runInstall(GIST_ID, { yes: true }, deps),
    (e) => e instanceof CliError && e.exitCode === 2 && /--project, --global, or --dir/.test(e.message),
  );
});

test('integration: command package installs as .claude/commands/<name>.md (single file)', async () => {
  const pkg = await makePackage(
    { 'review.md': '---\ndescription: Review.\n---\nDo a review.\n' },
    { name: 'review', type: 'command', agent: 'claude-code' },
  );
  const deps = await makeDeps({ routes: gistRoutes(pkg) });
  await mkdir(path.join(deps.cwd, '.claude'), { recursive: true });
  const res = await runInstall(GIST_ID, { yes: true }, deps);
  assert.equal(res.target, path.join(deps.cwd, '.claude', 'commands', 'review.md'));
  assert.match(await readFile(res.target, 'utf8'), /Do a review/);
  // identical re-install is a no-op for single files too
  const again = await runInstall(GIST_ID, { yes: true }, deps);
  assert.equal(again.status, 'identical');
});

test('integration: deleted gist (404) → exit 1 "deleted by the sender"', async () => {
  const deps = await makeDeps({ routes: {} }); // no routes → 404
  await assert.rejects(
    () => runInstall(GIST_ID, { yes: true, dir: path.join(deps.cwd, 'x') }, deps),
    (e) => e instanceof CliError && e.exitCode === 1 && e.message === MSG.gistDeleted,
  );
});

test('integration: bundle/prompt types require --dir', async () => {
  const pkg = await makePackage({ 'notes.md': 'hi', 'data.txt': 'x' }, { name: 'misc', type: 'bundle', agent: '' });
  const deps = await makeDeps({ routes: gistRoutes(pkg) });
  await assert.rejects(
    () => runInstall(GIST_ID, { yes: true }, deps),
    (e) => e instanceof CliError && e.exitCode === 2 && /--dir/.test(e.message),
  );
});

test('integration: repo install with branch ref resolves to a SHA and records it', async () => {
  const sha = 'abc123abc123abc123abc123abc123abc123abc1';
  const repoTgz = makeTgz([
    tarEntry(`skills-${sha.slice(0, 7)}/review/SKILL.md`, '---\nname: review\ndescription: Reviews code.\n---\n'),
    tarEntry(`skills-${sha.slice(0, 7)}/unrelated.txt`, 'not in subtree'),
  ]);
  const deps = await makeDeps({
    routes: {
      'api.github.com/repos/acme/skills/commits/main': { sha },
      [`codeload.github.com/acme/skills/tar.gz/${sha}`]: new Response(repoTgz),
    },
  });
  const dir = path.join(deps.cwd, 'review');
  await runInstall('gh:acme/skills/review@main', { yes: true, dir }, deps);
  assert.ok(existsSync(path.join(dir, 'SKILL.md')));
  assert.ok(!existsSync(path.join(dir, 'unrelated.txt')), 'subtree extraction must exclude siblings');
  const records = await loadInstalls(deps.configDir);
  assert.equal(records[0].source, `gh:acme/skills/review@${sha}`);
  // inferred from the tree, not from any manifest
  assert.equal(records[0].name, 'review');
});

test('integration: sha mismatch in a hand-tampered gist payload aborts with the download-integrity message', async () => {
  const manifest = {
    skillshark: '2',
    name: 'evil',
    type: 'skill',
    agent: 'claude-code',
    files: [{ path: 'SKILL.md', size: 4, sha256: 'a'.repeat(64), mode: '0644', executable: false }],
    totalSize: 4,
    fingerprint: null,
  };
  const tgz = makeTgz([
    tarEntry('skillshark.json', JSON.stringify(manifest)),
    tarEntry('SKILL.md', 'oops'),
  ]);
  const deps = await makeDeps({ routes: { [`api.github.com/gists/${GIST_ID}`]: gistApiResponse(GIST_ID, tgz) } });
  const dir = path.join(deps.cwd, 'evil');
  await assert.rejects(
    () => runInstall(GIST_ID, { yes: true, dir }, deps),
    (e) => e instanceof CliError && e.exitCode === 1 && e.message === MSG.downloadIntegrity,
  );
  assert.ok(!existsSync(dir), 'target untouched');
});

test('integration: truncated gist file is fetched via raw_url', async () => {
  const pkg = await makePackage({ 'SKILL.md': '# raw' }, { name: 'rawy' });
  const api = gistApiResponse(GIST_ID, pkg.tarball);
  const b64 = api.files['package.tgz.b64'].content;
  api.files['package.tgz.b64'].content = b64.slice(0, 100); // simulated truncation
  api.files['package.tgz.b64'].truncated = true;
  const deps = await makeDeps({
    routes: {
      [`api.github.com/gists/${GIST_ID}`]: api,
      [`gist.githubusercontent.com/x/${GIST_ID}/raw/package.tgz.b64`]: () => new Response(b64),
    },
  });
  const dir = path.join(deps.cwd, 'rawy');
  await runInstall(GIST_ID, { yes: true, dir }, deps);
  assert.equal(await readFile(path.join(dir, 'SKILL.md'), 'utf8'), '# raw');
});
