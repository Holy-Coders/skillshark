// v0.2 features: rename-on-install (--name) and cross-agent installs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { runInstall, runInspect } from '../src/install.js';
import { runShare } from '../src/share.js';
import { parseGeminiToml } from '../src/agents.js';
import { CliError } from '../src/errors.js';
import { loadInstalls } from '../src/config.js';
import {
  makePackage,
  gistApiResponse,
  fakeFetch,
  silentUi,
  throwingPrompts,
  tmpdir,
  writeTree,
} from './helpers.js';

const GIST_ID = 'feedfacefeedfacefeedfacefeedface';

async function makeDeps({ routes = {} } = {}) {
  return {
    fetch: fakeFetch(routes),
    cwd: await tmpdir('skillshark-cwd-'),
    home: await tmpdir('skillshark-home-'),
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

const SKILL_PKG = () =>
  makePackage(
    {
      'SKILL.md': '---\nname: jump\ndescription: Jump to a recent directory.\n---\n\nWhen asked, jump.\n',
      'scripts/jump.sh': { content: '#!/bin/sh\necho jump\n', executable: true },
    },
    { name: 'jump', type: 'skill', agent: 'claude-code' },
  );

// --- rename (--name) ----------------------------------------------------------

test('rename: --name installs under the new name and rewrites the frontmatter name', async () => {
  const pkg = await SKILL_PKG();
  const deps = await makeDeps({ routes: gistRoutes(pkg) });
  await mkdir(path.join(deps.cwd, '.claude'), { recursive: true });

  const res = await runInstall(GIST_ID, { yes: true, name: 'leap' }, deps);
  assert.equal(res.target, path.join(deps.cwd, '.claude', 'skills', 'leap'));
  const skillMd = await readFile(path.join(res.target, 'SKILL.md'), 'utf8');
  assert.match(skillMd, /^---\nname: leap\n/, 'frontmatter name must be rewritten');
  assert.match(skillMd, /When asked, jump\./, 'body untouched');
  assert.ok(existsSync(path.join(res.target, 'scripts', 'jump.sh')), 'bundled files still travel on native installs');

  const records = await loadInstalls(deps.configDir);
  assert.equal(records[0].name, 'leap');

  // identical re-install under the same rename is a benign no-op
  const again = await runInstall(GIST_ID, { yes: true, name: 'leap' }, deps);
  assert.equal(again.status, 'identical');
  // and the original name is untouched territory — installs fresh
  const orig = await runInstall(GIST_ID, { yes: true }, deps);
  assert.equal(orig.status, 'installed');
  assert.equal(orig.target, path.join(deps.cwd, '.claude', 'skills', 'jump'));
});

test('rename: --name renames single-file commands via the filename', async () => {
  const pkg = await makePackage(
    { 'review.md': '---\ndescription: Review.\n---\nDo a review.\n' },
    { name: 'review', type: 'command', agent: 'claude-code' },
  );
  const deps = await makeDeps({ routes: gistRoutes(pkg) });
  await mkdir(path.join(deps.cwd, '.claude'), { recursive: true });
  const res = await runInstall(GIST_ID, { yes: true, name: 'review-strict' }, deps);
  assert.equal(res.target, path.join(deps.cwd, '.claude', 'commands', 'review-strict.md'));
  assert.match(await readFile(res.target, 'utf8'), /Do a review/);
});

test('rename: bad names exit 2 before any network fetch', async () => {
  const deps = await makeDeps();
  let fetched = false;
  deps.fetch = async () => {
    fetched = true;
    throw new Error('no');
  };
  for (const bad of ['has space', '../up', '-lead']) {
    await assert.rejects(
      () => runInstall(GIST_ID, { yes: true, name: bad }, deps),
      (e) => e instanceof CliError && e.exitCode === 2 && /--name/.test(e.message),
    );
  }
  assert.equal(fetched, false);
});

// --- cross-agent installs -------------------------------------------------------

test('cross-agent: claude skill → cursor command (plain md, scripts dropped with a warning)', async () => {
  const pkg = await SKILL_PKG();
  const deps = await makeDeps({ routes: gistRoutes(pkg) });
  await mkdir(path.join(deps.cwd, '.cursor'), { recursive: true });

  const res = await runInstall(GIST_ID, { yes: true, agent: 'cursor', project: true }, deps);
  assert.equal(res.target, path.join(deps.cwd, '.cursor', 'commands', 'jump.md'));
  const content = await readFile(res.target, 'utf8');
  assert.equal(content, 'When asked, jump.\n', 'cursor commands carry the body only — no frontmatter');
  assert.match(deps.ui.text(), /Converting Claude Code skill → Cursor command/);
  assert.match(deps.ui.text(), /scripts\/jump\.sh/, 'dropped files are named in the warning');

  const records = await loadInstalls(deps.configDir);
  assert.equal(records[0].agent, 'cursor');
  assert.equal(records[0].convertedFrom, 'claude-code');

  // converted identical re-install is also a no-op
  const again = await runInstall(GIST_ID, { yes: true, agent: 'cursor', project: true }, deps);
  assert.equal(again.status, 'identical');
});

test('cross-agent: claude skill → gemini TOML command with prompt round-trip', async () => {
  const pkg = await SKILL_PKG();
  const deps = await makeDeps({ routes: gistRoutes(pkg) });
  const res = await runInstall(GIST_ID, { yes: true, agent: 'gemini', global: true }, deps);
  assert.equal(res.target, path.join(deps.home, '.gemini', 'commands', 'jump.toml'));
  const toml = await readFile(res.target, 'utf8');
  const parsed = parseGeminiToml(toml);
  assert.equal(parsed.description, 'Jump to a recent directory.');
  assert.equal(parsed.body, 'When asked, jump.');
});

test('cross-agent: codex is global-only — lands in ~/.codex/prompts even with project cwd, refuses --project', async () => {
  const pkg = await SKILL_PKG();
  const deps = await makeDeps({ routes: gistRoutes(pkg) });
  await mkdir(path.join(deps.cwd, '.git'), { recursive: true });
  const res = await runInstall(GIST_ID, { yes: true, agent: 'codex' }, deps);
  assert.equal(res.target, path.join(deps.home, '.codex', 'prompts', 'jump.md'));
  assert.match(await readFile(res.target, 'utf8'), /^---\ndescription: Jump to a recent directory\.\n---\n/);

  const deps2 = await makeDeps({ routes: gistRoutes(pkg) });
  await assert.rejects(
    () => runInstall(GIST_ID, { yes: true, agent: 'codex', project: true }, deps2),
    (e) => e instanceof CliError && e.exitCode === 2 && /home directory only/.test(e.message),
  );
});

test('cross-agent: copilot prompt files are project-scoped .prompt.md', async () => {
  const pkg = await SKILL_PKG();
  const deps = await makeDeps({ routes: gistRoutes(pkg) });
  await mkdir(path.join(deps.cwd, '.git'), { recursive: true });
  const res = await runInstall(GIST_ID, { yes: true, agent: 'copilot' }, deps);
  assert.equal(res.target, path.join(deps.cwd, '.github', 'prompts', 'jump.prompt.md'));
});

test('cross-agent: foreign rule → claude-code becomes a skill with synthesized SKILL.md', async () => {
  const pkg = await makePackage(
    { 'style.mdc': '---\ndescription: Use tabs, not spaces.\nalwaysApply: false\n---\nAlways use tabs.\n' },
    { name: 'style', type: 'rule', agent: 'cursor' },
  );
  const deps = await makeDeps({ routes: gistRoutes(pkg) });
  await mkdir(path.join(deps.cwd, '.claude'), { recursive: true });
  const res = await runInstall(GIST_ID, { yes: true, agent: 'claude-code', project: true }, deps);
  assert.equal(res.target, path.join(deps.cwd, '.claude', 'skills', 'style'));
  const skillMd = await readFile(path.join(res.target, 'SKILL.md'), 'utf8');
  assert.match(skillMd, /^---\nname: style\ndescription: Use tabs, not spaces\.\n---\n\nAlways use tabs\./);
});

test('cross-agent: native cursor rule package installs verbatim into .cursor/rules', async () => {
  const original = '---\ndescription: Use tabs.\nglobs: ["**/*.ts"]\nalwaysApply: true\n---\nTabs.\n';
  const pkg = await makePackage({ 'style.mdc': original }, { name: 'style', type: 'rule', agent: 'cursor' });
  const deps = await makeDeps({ routes: gistRoutes(pkg) });
  await mkdir(path.join(deps.cwd, '.cursor'), { recursive: true });
  const res = await runInstall(GIST_ID, { yes: true }, deps);
  assert.equal(res.target, path.join(deps.cwd, '.cursor', 'rules', 'style.mdc'));
  assert.equal(await readFile(res.target, 'utf8'), original, 'native installs are byte-verbatim');
});

test('cross-agent: rename combines with conversion (--name + --agent)', async () => {
  const pkg = await SKILL_PKG();
  const deps = await makeDeps({ routes: gistRoutes(pkg) });
  const res = await runInstall(GIST_ID, { yes: true, agent: 'opencode', global: true, name: 'hop' }, deps);
  assert.equal(res.target, path.join(deps.home, '.config', 'opencode', 'command', 'hop.md'));
  const json = await loadInstalls(deps.configDir);
  assert.equal(json[0].name, 'hop');
});

test('cross-agent: bundles refuse agent targets and point at --dir', async () => {
  const pkg = await makePackage({ 'a.md': 'a', 'b.txt': 'b' }, { name: 'misc', type: 'bundle', agent: '' });
  const deps = await makeDeps({ routes: gistRoutes(pkg) });
  await assert.rejects(
    () => runInstall(GIST_ID, { yes: true, agent: 'cursor', project: true }, deps),
    (e) => e instanceof CliError && e.exitCode === 2 && /--dir/.test(e.message),
  );
});

test('cross-agent: unknown --agent exits 2 before the network', async () => {
  const deps = await makeDeps();
  let fetched = false;
  deps.fetch = async () => {
    fetched = true;
    throw new Error('no');
  };
  await assert.rejects(
    () => runInstall(GIST_ID, { yes: true, agent: 'emacs' }, deps),
    (e) => e instanceof CliError && e.exitCode === 2 && /Supported:/.test(e.message),
  );
  assert.equal(fetched, false);
});

test('inspect lists the install targets for the package type', async () => {
  const pkg = await SKILL_PKG();
  const deps = await makeDeps({ routes: gistRoutes(pkg) });
  await runInspect(GIST_ID, {}, deps);
  const text = deps.ui.text();
  assert.match(text, /Installs to: claude-code \(native\)/);
  assert.match(text, /convertible → .*cursor.*gemini/);
});

// --- share-side multi-agent discovery ---------------------------------------------

test('share discovery: a cursor rule resolves by name with the right type/agent and dialect metadata', async () => {
  const deps = {
    cwd: await tmpdir(),
    home: await tmpdir(),
    env: {},
    isTTY: false,
    configDir: await tmpdir(),
    ui: silentUi(),
    prompts: throwingPrompts(),
    clipboard: async () => true,
  };
  await writeTree(
    { '.cursor/rules/tabs.mdc': '---\ndescription: Tabs everywhere.\n---\nUse tabs.\n' },
    deps.cwd,
  );
  let body = null;
  deps.ghApi = async (args) => {
    body = JSON.parse(await readFile(args[args.indexOf('--input') + 1], 'utf8'));
    return JSON.stringify({ id: 'a'.repeat(32), history: [{ version: 'r' }] });
  };
  await runShare('tabs', { noClipboard: true, noEncrypt: true }, deps);
  const manifest = JSON.parse(body.files['SKILLSHARK.json'].content);
  assert.equal(manifest.type, 'rule');
  assert.equal(manifest.agent, 'cursor');
  assert.equal(manifest.name, 'tabs');
  assert.equal(manifest.description, 'Tabs everywhere.');
  assert.equal(body.description, `skillshark: tabs (cursor rule) · fp ${manifest.fingerprint.slice(0, 8)}`);
});

test('share discovery: codex prompts (global) and gemini TOML commands resolve by name', async () => {
  const deps = {
    cwd: await tmpdir(),
    home: await tmpdir(),
    env: {},
    isTTY: false,
    configDir: await tmpdir(),
    ui: silentUi(),
    prompts: throwingPrompts(),
    clipboard: async () => true,
  };
  await writeTree({ '.codex/prompts/draftpr.md': '---\ndescription: Draft a PR.\n---\nDraft it.\n' }, deps.home);
  await writeTree(
    { '.gemini/commands/changelog.toml': 'description = "Update the changelog."\n\nprompt = """\nDo the changelog.\n"""\n' },
    deps.cwd,
  );
  const manifests = [];
  deps.ghApi = async (args) => {
    manifests.push(JSON.parse(JSON.parse(await readFile(args[args.indexOf('--input') + 1], 'utf8')).files['SKILLSHARK.json'].content));
    return JSON.stringify({ id: 'b'.repeat(32), history: [{ version: 'r' }] });
  };
  await runShare('draftpr', { noClipboard: true, noEncrypt: true }, deps);
  await runShare('changelog', { noClipboard: true, noEncrypt: true }, deps);
  assert.equal(manifests[0].agent, 'codex');
  assert.equal(manifests[0].type, 'prompt');
  assert.equal(manifests[1].agent, 'gemini');
  assert.equal(manifests[1].type, 'command');
  assert.equal(manifests[1].description, 'Update the changelog.');
});

test('end-to-end dialect hop: share a gemini TOML, install it for claude-code', async () => {
  const shareDeps = {
    cwd: await tmpdir(),
    home: await tmpdir(),
    env: {},
    isTTY: false,
    configDir: await tmpdir(),
    ui: silentUi(),
    prompts: throwingPrompts(),
    clipboard: async () => true,
  };
  await writeTree(
    { '.gemini/commands/release.toml': 'description = "Cut a release."\n\nprompt = """\nTag, build, publish.\n"""\n' },
    shareDeps.cwd,
  );
  let gistBody = null;
  shareDeps.ghApi = async (args) => {
    gistBody = JSON.parse(await readFile(args[args.indexOf('--input') + 1], 'utf8'));
    return JSON.stringify({ id: GIST_ID, history: [{ version: 'r' }] });
  };
  await runShare('release', { noClipboard: true, noEncrypt: true }, shareDeps);

  // rebuild the wire tarball from the captured gist body, then install it
  // cross-agent: a gemini command maps to a claude-code command
  const tarball = Buffer.from(gistBody.files['package.tgz.b64'].content, 'base64');
  const deps = await makeDeps({ routes: { [`api.github.com/gists/${GIST_ID}`]: gistApiResponse(GIST_ID, tarball) } });
  await mkdir(path.join(deps.cwd, '.claude'), { recursive: true });
  const res = await runInstall(GIST_ID, { yes: true, agent: 'claude-code', project: true }, deps);
  assert.equal(res.target, path.join(deps.cwd, '.claude', 'commands', 'release.md'));
  const cmdMd = await readFile(res.target, 'utf8');
  assert.match(cmdMd, /^---\ndescription: Cut a release\.\n---\n/);
  assert.match(cmdMd, /Tag, build, publish\./, 'the TOML prompt survives the dialect hop intact');
});
