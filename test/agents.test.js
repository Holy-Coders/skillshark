import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import {
  AGENTS,
  AGENT_IDS,
  getAgent,
  detectAgents,
  classifyByConvention,
  artifactBaseName,
  renderGeminiToml,
  parseGeminiToml,
  rewriteFrontmatterName,
  extractCanonical,
  NAME_RE,
} from '../src/agents.js';
import { CliError } from '../src/errors.js';
import { tmpdir, writeTree } from './helpers.js';

const CANON = {
  name: 'review',
  description: 'Review code carefully.',
  body: '# review\n\nLook at the diff and comment.\n',
};

test('registry: every adapter declares the full contract', () => {
  assert.ok(AGENT_IDS.length >= 7);
  for (const id of AGENT_IDS) {
    const a = AGENTS[id];
    for (const key of ['label', 'detect', 'locations', 'mapKind', 'scopes', 'container', 'targetRel', 'render', 'parse']) {
      assert.ok(a[key] !== undefined, `${id} is missing ${key}`);
    }
  }
  assert.throws(() => getAgent('emacs'), (e) => e instanceof CliError && e.exitCode === 2 && /Supported:/.test(e.message));
});

test('conversion: cursor rule gets mdc frontmatter, cursor command stays plain markdown', () => {
  const rule = AGENTS.cursor.render('rule', CANON);
  assert.equal(rule.filename, 'review.mdc');
  assert.match(rule.content, /^---\ndescription: Review code carefully\.\nalwaysApply: false\n---\n\n# review/);
  const cmd = AGENTS.cursor.render('command', CANON);
  assert.equal(cmd.filename, 'review.md');
  assert.equal(cmd.content, CANON.body, 'cursor commands are plain markdown, no frontmatter');
});

test('conversion: claude skill, codex prompt, copilot prompt, windsurf, opencode dialects', () => {
  const skill = AGENTS['claude-code'].render('skill', CANON);
  assert.equal(skill.filename, 'SKILL.md');
  assert.match(skill.content, /^---\nname: review\ndescription: Review code carefully\.\n---\n\n# review/);

  const codex = AGENTS.codex.render('prompt', CANON);
  assert.equal(codex.filename, 'review.md');
  assert.match(codex.content, /^---\ndescription: Review code carefully\.\n---\n/);

  const copilot = AGENTS.copilot.render('prompt', CANON);
  assert.equal(copilot.filename, 'review.prompt.md');
  assert.match(copilot.content, /^---\ndescription: /);

  const wsRule = AGENTS.windsurf.render('rule', CANON);
  assert.equal(wsRule.content, CANON.body, 'windsurf rules are plain markdown');
  const wsFlow = AGENTS.windsurf.render('workflow', CANON);
  assert.match(wsFlow.content, /^---\ndescription: /);

  const oc = AGENTS.opencode.render('command', CANON);
  assert.equal(oc.filename, 'review.md');
  assert.match(oc.content, /^---\ndescription: /);
});

test('conversion: gemini TOML escapes quotes, backslashes, and triple quotes round-trip', () => {
  const nasty = {
    name: 'tricky',
    description: 'Says "hi" with a \\ backslash.',
    body: 'Use C:\\paths and quote """ blocks.\nSecond line.',
  };
  const toml = renderGeminiToml(nasty);
  const parsed = parseGeminiToml(toml);
  assert.equal(parsed.description, nasty.description);
  assert.equal(parsed.body, nasty.body);
});

test('gemini TOML parser handles literal and single-line variants; refuses promptless files', () => {
  const lit = parseGeminiToml("description = \"d\"\nprompt = '''\nliteral \\ no escapes\n'''\n");
  assert.equal(lit.body, 'literal \\ no escapes');
  const single = parseGeminiToml('prompt = "one\\nline"');
  assert.equal(single.body, 'one\nline');
  assert.equal(parseGeminiToml('just = "junk"').body, null);
  assert.throws(
    () => AGENTS.gemini.parse('nope = 1', '.toml'),
    (e) => e instanceof CliError && /--agent gemini/.test(e.message),
  );
});

test('kind mapping: rules stay rule-shaped, everything else lands invocable; bundles refuse', () => {
  assert.equal(AGENTS['claude-code'].mapKind('rule'), 'skill');
  assert.equal(AGENTS['claude-code'].mapKind('prompt'), 'command');
  assert.equal(AGENTS.cursor.mapKind('skill'), 'command');
  assert.equal(AGENTS.cursor.mapKind('rule'), 'rule');
  assert.equal(AGENTS.windsurf.mapKind('skill'), 'workflow');
  assert.equal(AGENTS.codex.mapKind('skill'), 'prompt');
  for (const id of AGENT_IDS) {
    assert.equal(AGENTS[id].mapKind('bundle'), null, `${id} must refuse bundles`);
  }
});

test('scopes: codex is global-only, copilot/windsurf project-only, cursor rules project-only', () => {
  assert.equal(AGENTS.codex.scopes('prompt'), 'global');
  assert.equal(AGENTS.copilot.scopes('prompt'), 'project');
  assert.equal(AGENTS.windsurf.scopes('rule'), 'project');
  assert.equal(AGENTS.cursor.scopes('rule'), 'project');
  assert.equal(AGENTS.cursor.scopes('command'), 'both');
  assert.equal(AGENTS.opencode.scopes('command'), 'both');
});

test('targetRel: opencode global lands under ~/.config, gemini uses .toml', () => {
  assert.deepEqual(AGENTS.opencode.targetRel('command', 'x', 'global'), ['.config', 'opencode', 'command', 'x.md']);
  assert.deepEqual(AGENTS.opencode.targetRel('command', 'x', 'project'), ['.opencode', 'command', 'x.md']);
  assert.deepEqual(AGENTS.gemini.targetRel('command', 'x'), ['.gemini', 'commands', 'x.toml']);
  assert.deepEqual(AGENTS.codex.targetRel('prompt', 'x'), ['.codex', 'prompts', 'x.md']);
});

test('detection: adapters spot their directories in cwd or home', async () => {
  const cwd = await tmpdir();
  const home = await tmpdir();
  assert.deepEqual(detectAgents({ cwd, home }), []);
  await mkdir(path.join(cwd, '.cursor'), { recursive: true });
  await mkdir(path.join(home, '.codex'), { recursive: true });
  await mkdir(path.join(home, '.config', 'opencode'), { recursive: true });
  await mkdir(path.join(cwd, '.github', 'prompts'), { recursive: true });
  const found = detectAgents({ cwd, home });
  assert.deepEqual(found.sort(), ['codex', 'copilot', 'cursor', 'opencode']);
});

test('classifyByConvention recognizes every adapter path; artifactBaseName strips .prompt.md', () => {
  assert.deepEqual(classifyByConvention('/p/.cursor/rules/style.mdc', false), { type: 'rule', agent: 'cursor' });
  assert.deepEqual(classifyByConvention('/p/.cursor/commands/go.md', false), { type: 'command', agent: 'cursor' });
  assert.deepEqual(classifyByConvention('/h/.codex/prompts/draftpr.md', false), { type: 'prompt', agent: 'codex' });
  assert.deepEqual(classifyByConvention('/p/.github/prompts/fix.prompt.md', false), { type: 'prompt', agent: 'copilot' });
  assert.deepEqual(classifyByConvention('/p/.windsurf/workflows/deploy.md', false), { type: 'workflow', agent: 'windsurf' });
  assert.deepEqual(classifyByConvention('/p/.gemini/commands/changelog.toml', false), { type: 'command', agent: 'gemini' });
  assert.deepEqual(classifyByConvention('/h/.config/opencode/command/test.md', false), { type: 'command', agent: 'opencode' });
  assert.deepEqual(classifyByConvention('/p/.claude/skills/j', true), { type: 'skill', agent: 'claude-code' });
  assert.equal(classifyByConvention('/p/random/notes.md', false), null);
  assert.equal(artifactBaseName('fix.prompt.md'), 'fix');
  assert.equal(artifactBaseName('changelog.toml'), 'changelog');
  assert.equal(artifactBaseName('go.md'), 'go');
});

test('rewriteFrontmatterName replaces only the name value, leaves files without one untouched', () => {
  const src = '---\nname: old-name\ndescription: D\n---\n# old-name body\n';
  const out = rewriteFrontmatterName(src, 'fresh');
  assert.match(out, /^---\nname: fresh\ndescription: D\n---\n/);
  assert.match(out, /# old-name body/, 'body is never rewritten');
  const noFm = '# plain\n';
  assert.equal(rewriteFrontmatterName(noFm, 'x'), noFm);
  const noName = '---\ndescription: D\n---\nbody';
  assert.equal(rewriteFrontmatterName(noName, 'x'), noName);
});

test('extractCanonical: picks SKILL.md, strips dialect frontmatter, reports dropped files', () => {
  const manifest = {
    name: 'jump',
    agent: 'claude-code',
    description: 'fallback desc',
    files: [
      { path: 'SKILL.md' },
      { path: 'scripts/jump.sh' },
      { path: 'README.md' },
    ],
  };
  const contents = { 'SKILL.md': '---\nname: jump\ndescription: Jump around.\n---\n\nDo the jump.\n' };
  const canon = extractCanonical(manifest, (p) => contents[p]);
  assert.equal(canon.description, 'Jump around.');
  assert.equal(canon.body, 'Do the jump.\n');
  assert.deepEqual(canon.dropped.sort(), ['README.md', 'scripts/jump.sh']);
});

test('NAME_RE accepts sane names and rejects path-ish ones', () => {
  for (const ok of ['j', 'review-2', 'my_skill', 'a.b', 'X9']) assert.ok(NAME_RE.test(ok), ok);
  for (const bad of ['', '.hidden', '-lead', 'has space', 'a/b', '..', 'a'.repeat(80)]) {
    assert.ok(!NAME_RE.test(bad), bad);
  }
});
