import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import {
  collectFiles,
  resolveShareArg,
  inferMetadata,
  classifyPath,
  parseFrontmatter,
  findExternalRefs,
  nearestNames,
} from '../src/discover.js';
import { CliError } from '../src/errors.js';
import { writeTree, tmpdir } from './helpers.js';

test('§8.9 secret excludes: .env and id_rsa skipped with warning; included with --force', async () => {
  const root = await writeTree({
    'SKILL.md': '# s',
    '.env': 'API_KEY=hunter2',
    'id_rsa': 'PRIVATE KEY',
    'creds/server.pem': 'PEM',
    'my-token.txt': 'tok',
  });
  const { files, warnings } = await collectFiles(root, { isDir: true });
  const paths = files.map((f) => f.path);
  assert.deepEqual(paths, ['SKILL.md']);
  const warned = warnings.map((w) => w.path).sort();
  assert.deepEqual(warned, ['.env', 'creds/server.pem', 'id_rsa', 'my-token.txt']);
  assert.ok(warnings.every((w) => w.forceable), 'secret-shaped warnings are forceable');

  const forced = await collectFiles(root, { isDir: true, force: true });
  const forcedPaths = forced.files.map((f) => f.path).sort();
  assert.deepEqual(forcedPaths, ['.env', 'SKILL.md', 'creds/server.pem', 'id_rsa', 'my-token.txt']);
  assert.equal(forced.warnings.length, 0);
});

test('§8.9 hard excludes (.git, node_modules, .DS_Store, *.log) never packaged, even with --force', async () => {
  const root = await writeTree({
    'SKILL.md': '# s',
    '.git/HEAD': 'ref: x',
    'node_modules/dep/index.js': 'x',
    '.DS_Store': 'junk',
    'debug.log': 'log',
  });
  for (const force of [false, true]) {
    const { files } = await collectFiles(root, { isDir: true, force });
    assert.deepEqual(files.map((f) => f.path), ['SKILL.md'], `force=${force}`);
  }
});

test('§8.9 symlinks are skipped with a warning at pack time', async () => {
  const root = await writeTree({ 'SKILL.md': '# s' });
  await symlink('/etc/passwd', path.join(root, 'sneaky'));
  const { files, warnings } = await collectFiles(root, { isDir: true });
  assert.deepEqual(files.map((f) => f.path), ['SKILL.md']);
  assert.ok(warnings.some((w) => w.path === 'sneaky' && w.reason === 'symlink'));
});

test('§8.10 inference: frontmatter name/description; location implies type/agent', async () => {
  const cwd = await tmpdir();
  const home = await tmpdir();
  const skillDir = path.join(cwd, '.claude', 'skills', 'j');
  await mkdir(path.join(skillDir, 'scripts'), { recursive: true });
  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: jump\ndescription: Jump to a recently used directory.\n---\n# j\nbody\n',
  );
  await writeFile(path.join(skillDir, 'scripts', 'jump.sh'), '#!/bin/sh\n');

  const { matches } = await resolveShareArg('/j', { cwd, home });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].type, 'skill');
  assert.equal(matches[0].agent, 'claude-code');

  const { files } = await collectFiles(skillDir, { isDir: true });
  const meta = await inferMetadata({ root: skillDir, isDir: true, type: 'skill', agent: 'claude-code', files });
  assert.equal(meta.name, 'jump');
  assert.equal(meta.description, 'Jump to a recently used directory.');
  assert.equal(meta.primaryDoc, 'SKILL.md');
});

test('§8.10 inference falls back to basename + first heading; bare dir → bundle, bare file → prompt', async () => {
  const dir = await writeTree({ 'README.md': '# My Notes\n\nSome text.\n', 'data.txt': 'x' });
  assert.deepEqual(classifyPath(dir, true), { type: 'bundle', agent: '' });

  const { files } = await collectFiles(dir, { isDir: true });
  const meta = await inferMetadata({ root: dir, isDir: true, type: 'bundle', agent: '', files });
  assert.equal(meta.name, path.basename(dir));
  assert.equal(meta.description, 'My Notes');

  const fileRoot = path.join(dir, 'README.md');
  assert.deepEqual(classifyPath(fileRoot, false), { type: 'prompt', agent: '' });
  // and a command location classifies as a command
  assert.deepEqual(classifyPath('/x/.claude/commands/go.md', false), { type: 'command', agent: 'claude-code' });
  assert.deepEqual(classifyPath('/x/.claude/skills/go', true), { type: 'skill', agent: 'claude-code' });
});

test('§8.10 command resolution by name finds .claude/commands/<name>.md', async () => {
  const cwd = await tmpdir();
  const home = await tmpdir();
  await writeTree({ '.claude/commands/review.md': '---\ndescription: Review code.\n---\n' }, cwd);
  const { matches } = await resolveShareArg('review', { cwd, home });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].type, 'command');
  assert.ok(matches[0].root.endsWith('review.md'));
});

test('§8.10 unknown name exits 2 with nearest-name suggestions', async () => {
  const cwd = await tmpdir();
  const home = await tmpdir();
  await writeTree({ '.claude/skills/jump/SKILL.md': '# jump' }, cwd);
  await assert.rejects(
    () => resolveShareArg('jmup', { cwd, home }),
    (e) => e instanceof CliError && e.exitCode === 2 && /jump/.test(e.message),
  );
  assert.deepEqual(nearestNames('jmup', ['jump', 'review', 'unrelated']), ['jump']);
});

test('frontmatter parser handles quotes, missing blocks, and junk', () => {
  assert.deepEqual(parseFrontmatter('no frontmatter').data, {});
  const { data } = parseFrontmatter('---\nname: "quoted name"\ndescription: \'single\'\nweird line\n---\nbody');
  assert.equal(data.name, 'quoted name');
  assert.equal(data.description, 'single');
});

test('external-reference detection flags ../ paths in packaged .md files', async () => {
  const root = await writeTree({
    'SKILL.md': 'See [util](../shared/util.md) and run `../bin/tool.sh`.\nAlso ./local.md is fine.\n',
  });
  const { files } = await collectFiles(root, { isDir: true });
  const refs = await findExternalRefs(files);
  assert.deepEqual(refs, ['../bin/tool.sh', '../shared/util.md']);
});
