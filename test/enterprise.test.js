// v0.3 features: paste-and-go clipboard one-liner and GitHub Enterprise
// support. The enterprise privacy property: receiving an enterprise link goes
// ONLY through the receiver's gh auth — no anonymous request touches the host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { runInstall } from '../src/install.js';
import { runShare, runRevoke } from '../src/share.js';
import { CliError } from '../src/errors.js';
import { loadInstalls, loadConfig, addShareRecord } from '../src/config.js';
import {
  makePackage,
  gistApiResponse,
  fakeFetch,
  silentUi,
  throwingPrompts,
  tmpdir,
  writeTree,
  tarEntry,
  makeTgz,
} from './helpers.js';

const GIST_ID = 'feedfacefeedfacefeedfacefeedface';
const GHES = 'ghe.corp.com';

async function makeDeps({ routes = {}, env = {} } = {}) {
  return {
    fetch: fakeFetch(routes),
    cwd: await tmpdir('skillshark-cwd-'),
    home: await tmpdir('skillshark-home-'),
    env,
    isTTY: false,
    configDir: await tmpdir('skillshark-cfg-'),
    ui: silentUi(),
    prompts: throwingPrompts(),
    ghApi: async () => {
      throw new Error('gh invoked unexpectedly');
    },
    clipboard: async () => false,
  };
}

async function senderDeps() {
  const deps = await makeDeps();
  await writeTree(
    { '.claude/skills/demo/SKILL.md': '---\nname: demo\ndescription: Demo.\n---\n# demo\n' },
    deps.cwd,
  );
  return deps;
}

// --- paste-and-go clipboard -------------------------------------------------------

test('clipboard gets the full install one-liner, not just the URL', async () => {
  const deps = await senderDeps();
  deps.ghApi = async () => JSON.stringify({ id: GIST_ID, history: [{ version: 'r1' }] });
  let copied = null;
  deps.clipboard = async (text) => {
    copied = text;
    return true;
  };
  const res = await runShare('demo', {}, deps);
  const fp8 = res.fingerprint.slice(0, 8);
  assert.equal(copied, `npx skillshark install 'https://gist.github.com/${GIST_ID}#fp=${fp8}'`);
  assert.equal(res.installCommand, copied);
  assert.match(deps.ui.text(), /Install one-liner copied to clipboard/);
  assert.match(deps.ui.text(), /npx skillshark install '/);
});

test('share --json includes installCommand; -q still prints only the URL (scripting contract)', async () => {
  const deps = await senderDeps();
  deps.ghApi = async () => JSON.stringify({ id: GIST_ID, history: [{ version: 'r1' }] });
  await runShare('demo', { json: true, noClipboard: true }, deps);
  const out = JSON.parse(deps.ui.lines.at(-1));
  assert.equal(out.installCommand, `npx skillshark install '${out.url}'`);

  const deps2 = await senderDeps();
  deps2.ghApi = async () => JSON.stringify({ id: GIST_ID, history: [{ version: 'r1' }] });
  await runShare('demo', { quiet: true, noClipboard: true }, deps2);
  assert.match(deps2.ui.lines.at(-1), /^https:\/\/gist\.github\.com\/[0-9a-f]+#fp=[0-9a-f]{8}$/);
});

// --- enterprise share ----------------------------------------------------------------

test('enterprise share: gh gets --hostname, link uses the host html_url, record carries the host', async () => {
  const deps = await senderDeps();
  let args = null;
  deps.ghApi = async (a) => {
    args = a;
    return JSON.stringify({
      id: GIST_ID,
      history: [{ version: 'r1' }],
      html_url: `https://${GHES}/gist/${GIST_ID}`,
    });
  };
  const res = await runShare('demo', { host: GHES, noClipboard: true }, deps);
  assert.deepEqual(args.slice(0, 2), ['--hostname', GHES]);
  const fp8 = res.fingerprint.slice(0, 8);
  assert.equal(res.url, `https://${GHES}/gist/${GIST_ID}#fp=${fp8}`);
  assert.equal(res.installCommand, `npx skillshark install 'https://${GHES}/gist/${GIST_ID}#fp=${fp8}'`);
  const cfg = await loadConfig(deps.configDir);
  assert.equal(cfg.shares[0].host, GHES);
});

test('enterprise share: GH_HOST env routes the same way', async () => {
  const deps = await senderDeps();
  deps.env = { GH_HOST: GHES };
  let args = null;
  deps.ghApi = async (a) => {
    args = a;
    return JSON.stringify({ id: GIST_ID, history: [{ version: 'r1' }], html_url: `https://${GHES}/gist/${GIST_ID}` });
  };
  await runShare('demo', { noClipboard: true }, deps);
  assert.deepEqual(args.slice(0, 2), ['--hostname', GHES]);
});

test('enterprise share: payloads past the inline cap are refused with repo guidance', async () => {
  const deps = await makeDeps();
  const { randomBytes } = await import('node:crypto');
  const dir = path.join(deps.cwd, '.claude', 'skills', 'big');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), '# big');
  await writeFile(path.join(dir, 'blob.bin'), randomBytes(1024 * 1024));
  deps.ghApi = async () => {
    throw new Error('oversized enterprise share must not reach gh');
  };
  await assert.rejects(
    () => runShare('big', { host: GHES, noClipboard: true }, deps),
    (e) => e instanceof CliError && e.exitCode === 2 && /enterprise/.test(e.message) && new RegExp(GHES).test(e.message),
  );
});

// --- enterprise receive (the privacy property) -----------------------------------------

test('enterprise install: fetched ONLY via gh auth — zero anonymous requests to the host', async () => {
  const pkg = await makePackage({ 'SKILL.md': '# ent' }, { name: 'ent' });
  const deps = await makeDeps();
  const ghCalls = [];
  deps.ghApi = async (args) => {
    ghCalls.push(args);
    return JSON.stringify(gistApiResponse(GIST_ID, pkg.tarball, { login: 'corp-user' }));
  };
  const dir = path.join(deps.cwd, 'ent');
  const url = `https://gist.${GHES}/${GIST_ID}#fp=${pkg.fingerprint.slice(0, 8)}`;
  await runInstall(url, { yes: true, dir }, deps);

  assert.equal(deps.fetch.calls.length, 0, 'no anonymous fetch may touch an enterprise host');
  assert.deepEqual(ghCalls, [['--hostname', GHES, `gists/${GIST_ID}`]]);
  assert.ok(existsSync(path.join(dir, 'SKILL.md')));
  const records = await loadInstalls(deps.configDir);
  assert.equal(records[0].source.startsWith(`gist:${GHES}:${GIST_ID}@`), true);
});

test('enterprise install: #fp integrity and 404 mapping still apply through the gh path', async () => {
  const pkg = await makePackage({ 'SKILL.md': '# ent2' }, { name: 'ent2' });
  const deps = await makeDeps();
  deps.ghApi = async () => JSON.stringify(gistApiResponse(GIST_ID, pkg.tarball));
  await assert.rejects(
    () => runInstall(`https://${GHES}/gist/${GIST_ID}#fp=deadbeef`, { yes: true, dir: path.join(deps.cwd, 'x') }, deps),
    (e) => e instanceof CliError && e.exitCode === 1 && /integrity/i.test(e.message),
  );

  const deps404 = await makeDeps();
  deps404.ghApi = async () => {
    throw new CliError('GitHub returned 404 for that id.', 1);
  };
  await assert.rejects(
    () => runInstall(`https://${GHES}/gist/${GIST_ID}`, { yes: true, dir: path.join(deps404.cwd, 'x') }, deps404),
    (e) => e instanceof CliError && /deleted by the sender/.test(e.message),
  );
});

test('enterprise install: unauthenticated gh produces the gh auth login --hostname guidance', async () => {
  const { makeGhApi } = await import('../src/gh.js');
  const deps = await makeDeps();
  deps.ghApi = makeGhApi(async () => {
    const err = new Error('gh failed');
    err.stderr = 'HTTP 401: Must authenticate to access this API';
    throw err;
  });
  await assert.rejects(
    () => runInstall(`https://gist.${GHES}/${GIST_ID}`, { yes: true, dir: path.join(deps.cwd, 'x') }, deps),
    (e) => e instanceof CliError && e.exitCode === 2 && new RegExp(`gh auth login --hostname ${GHES}`).test(e.message),
  );
});

test('enterprise repo install: metadata and tarball ride gh (binary), nothing anonymous', async () => {
  const sha = 'abc123abc123abc123abc123abc123abc123abc1';
  const repoTgz = makeTgz([
    tarEntry(`skills-${sha.slice(0, 7)}/review/SKILL.md`, '---\nname: review\ndescription: R.\n---\n'),
  ]);
  const deps = await makeDeps({ env: { GH_HOST: GHES } });
  const ghCalls = [];
  deps.ghApi = async (args, opts = {}) => {
    ghCalls.push(args);
    if (args.at(-1).includes('/tarball/')) {
      assert.equal(opts.binary, true, 'tarball must be requested as binary');
      return repoTgz;
    }
    if (args.at(-1).includes('/commits/')) return JSON.stringify({ sha });
    return JSON.stringify({ default_branch: 'main' });
  };
  const dir = path.join(deps.cwd, 'review');
  await runInstall('gh:acme/skills/review', { yes: true, dir }, deps);
  assert.equal(deps.fetch.calls.length, 0, 'no anonymous fetch for enterprise repos');
  assert.ok(ghCalls.every((a) => a[0] === '--hostname' && a[1] === GHES));
  assert.ok(existsSync(path.join(dir, 'SKILL.md')));
});

test('enterprise revoke: uses the host recorded with the share', async () => {
  const deps = await makeDeps();
  const calls = [];
  deps.ghApi = async (args) => {
    calls.push(args);
    return '';
  };
  await addShareRecord(deps.configDir, { id: GIST_ID, name: 'corp-thing', url: 'u', revision: 'r', expiresAt: null, host: GHES });
  await runRevoke('corp-thing', { yes: true }, deps);
  assert.deepEqual(calls, [['--hostname', GHES, '--method', 'DELETE', `gists/${GIST_ID}`]]);
});

test('github.com receive still never touches gh (privacy boundary is per-host)', async () => {
  const pkg = await makePackage({ 'SKILL.md': '# pub' }, { name: 'pub' });
  const deps = await makeDeps({ routes: { [`api.github.com/gists/${GIST_ID}`]: gistApiResponse(GIST_ID, pkg.tarball) } });
  // env points at an enterprise, but the URL pins github.com — anonymous wins
  deps.env = { GH_HOST: GHES };
  await runInstall(`https://gist.github.com/${GIST_ID}`, { yes: true, dir: path.join(deps.cwd, 'pub') }, deps);
  assert.ok(deps.fetch.calls.some((u) => u.includes('api.github.com')));
});
