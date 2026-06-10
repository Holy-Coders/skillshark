// The adapter registry: the ONLY place agent-specific knowledge lives.
// Each adapter encodes one tool's on-disk conventions (verified against the
// tools' docs, June 2026) and how to render a canonical artifact into its
// dialect. Cross-agent installs are honest best-effort conversions: markdown
// instructions travel; bundled support files cannot leave a Claude skill.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CliError } from './errors.js';

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// canonical = { name, description, body } — body is the primary document
// with its source-dialect frontmatter stripped.

// --- dialect helpers ---------------------------------------------------------

function yamlFront(fields) {
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${String(v)}`);
  if (!lines.length) return '';
  return `---\n${lines.join('\n')}\n---\n\n`;
}

// TOML basic strings: escape backslashes and quotes so the parsed prompt is
// byte-identical to the source body.
function tomlBasicString(s) {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function tomlMultiline(s) {
  const escaped = s.replace(/\\/g, '\\\\').replace(/"""/g, '""\\"');
  return `"""\n${escaped}\n"""`;
}

export function renderGeminiToml({ description, body }) {
  let out = '';
  if (description) out += `description = ${tomlBasicString(description)}\n\n`;
  out += `prompt = ${tomlMultiline(body.replace(/\n$/, ''))}\n`;
  return out;
}

// Parse the gemini TOML dialect (our generated shape + the common hand-written
// variants: basic/literal multiline strings and single-line prompts).
export function parseGeminiToml(text) {
  const out = { description: '', body: null };
  const desc = text.match(/^[ \t]*description[ \t]*=[ \t]*"((?:[^"\\]|\\.)*)"[ \t]*$/m);
  if (desc) out.description = desc[1].replace(/\\(["\\])/g, '$1');

  let m = text.match(/^[ \t]*prompt[ \t]*=[ \t]*"""\n?([\s\S]*?)"""[ \t]*$/m);
  if (m) {
    out.body = m[1].replace(/""\\"/g, '"""').replace(/\\\\/g, '\\').replace(/\n$/, '');
    return out;
  }
  m = text.match(/^[ \t]*prompt[ \t]*=[ \t]*'''\n?([\s\S]*?)'''[ \t]*$/m);
  if (m) {
    out.body = m[1].replace(/\n$/, '');
    return out;
  }
  m = text.match(/^[ \t]*prompt[ \t]*=[ \t]*"((?:[^"\\]|\\.)*)"[ \t]*$/m);
  if (m) {
    out.body = m[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\(["\\])/g, '$1');
    return out;
  }
  return out; // body null → caller decides how honest to be
}

// Rewrite (or leave alone) the `name:` value in a YAML frontmatter block.
export function rewriteFrontmatterName(text, newName) {
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return text;
  const head = text.slice(0, end);
  if (!/^name[ \t]*:/m.test(head.slice(4))) return text;
  const newHead = head.replace(/^(name[ \t]*:[ \t]*).*$/m, `$1${newName}`);
  return newHead + text.slice(end);
}

// --- the registry -------------------------------------------------------------

// Adapter shape:
//   label                       human name
//   detect({cwd, home})         is this tool present here?
//   locations                   share-side lookup spots for a bare <name>
//     { kind, scope, rel(name) }   rel is relative to cwd (project) or home (global)
//   mapKind(type)               incoming artifact type → this agent's kind (null = can't)
//   scopes(kind)                'both' | 'project' | 'global'
//   targetRel(kind, name)       install path segments, relative to the scope root
//   container(kind)             'dir' | 'file'
//   render(kind, canonical)     content for a converted install
//   parse(content, ext)         native file → { description, body } (canonical-ish)
const mdParse = (content) => {
  // lazy import avoided: tiny local frontmatter read
  const fm = {};
  let body = content;
  if (content.startsWith('---')) {
    const end = content.indexOf('\n---', 3);
    if (end !== -1) {
      for (const line of content.slice(4, end).split('\n')) {
        const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (m) fm[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
      }
      body = content.slice(end + 4).replace(/^\n/, '');
    }
  }
  return { name: fm.name, description: fm.description ?? '', body };
};

export const AGENTS = {
  'claude-code': {
    label: 'Claude Code',
    detect: ({ cwd, home }) =>
      existsSync(path.join(cwd, '.claude')) || existsSync(path.join(home, '.claude')),
    locations: [
      { kind: 'skill', scope: 'project', container: 'dir', rel: (n) => ['.claude', 'skills', n] },
      { kind: 'command', scope: 'project', container: 'file', rel: (n) => ['.claude', 'commands', `${n}.md`] },
      { kind: 'skill', scope: 'global', container: 'dir', rel: (n) => ['.claude', 'skills', n] },
      { kind: 'command', scope: 'global', container: 'file', rel: (n) => ['.claude', 'commands', `${n}.md`] },
    ],
    mapKind: (type) => (type === 'skill' || type === 'rule' ? 'skill' : type === 'bundle' ? null : 'command'),
    scopes: () => 'both',
    container: (kind) => (kind === 'skill' ? 'dir' : 'file'),
    targetRel: (kind, name) =>
      kind === 'skill' ? ['.claude', 'skills', name] : ['.claude', 'commands', `${name}.md`],
    render: (kind, { name, description, body }) => {
      if (kind === 'skill') {
        return { filename: 'SKILL.md', content: yamlFront({ name, description }) + body };
      }
      return { filename: `${name}.md`, content: yamlFront({ description }) + body };
    },
    parse: mdParse,
  },

  cursor: {
    label: 'Cursor',
    detect: ({ cwd, home }) =>
      existsSync(path.join(cwd, '.cursor')) || existsSync(path.join(home, '.cursor')),
    locations: [
      { kind: 'rule', scope: 'project', container: 'file', rel: (n) => ['.cursor', 'rules', `${n}.mdc`] },
      { kind: 'command', scope: 'project', container: 'file', rel: (n) => ['.cursor', 'commands', `${n}.md`] },
      { kind: 'command', scope: 'global', container: 'file', rel: (n) => ['.cursor', 'commands', `${n}.md`] },
    ],
    mapKind: (type) => (type === 'bundle' ? null : type === 'rule' ? 'rule' : 'command'),
    scopes: (kind) => (kind === 'rule' ? 'project' : 'both'),
    container: () => 'file',
    targetRel: (kind, name) =>
      kind === 'rule' ? ['.cursor', 'rules', `${name}.mdc`] : ['.cursor', 'commands', `${name}.md`],
    render: (kind, { name, description, body }) => {
      if (kind === 'rule') {
        return { filename: `${name}.mdc`, content: yamlFront({ description, alwaysApply: 'false' }) + body };
      }
      return { filename: `${name}.md`, content: body };
    },
    parse: mdParse,
  },

  codex: {
    label: 'Codex CLI',
    detect: ({ cwd, home }) =>
      existsSync(path.join(cwd, '.codex')) || existsSync(path.join(home, '.codex')),
    locations: [
      { kind: 'prompt', scope: 'global', container: 'file', rel: (n) => ['.codex', 'prompts', `${n}.md`] },
    ],
    mapKind: (type) => (type === 'bundle' ? null : 'prompt'),
    scopes: () => 'global', // Codex scans only ~/.codex/prompts (top-level)
    container: () => 'file',
    targetRel: (kind, name) => ['.codex', 'prompts', `${name}.md`],
    render: (kind, { description, body, name }) => ({
      filename: `${name}.md`,
      content: yamlFront({ description }) + body,
    }),
    parse: mdParse,
  },

  copilot: {
    label: 'GitHub Copilot',
    detect: ({ cwd }) =>
      existsSync(path.join(cwd, '.github', 'prompts')) ||
      existsSync(path.join(cwd, '.github', 'copilot-instructions.md')) ||
      existsSync(path.join(cwd, '.github', 'instructions')),
    locations: [
      { kind: 'prompt', scope: 'project', container: 'file', rel: (n) => ['.github', 'prompts', `${n}.prompt.md`] },
    ],
    mapKind: (type) => (type === 'bundle' ? null : 'prompt'),
    scopes: () => 'project',
    container: () => 'file',
    targetRel: (kind, name) => ['.github', 'prompts', `${name}.prompt.md`],
    render: (kind, { description, body, name }) => ({
      filename: `${name}.prompt.md`,
      content: yamlFront({ description }) + body,
    }),
    parse: mdParse,
  },

  windsurf: {
    label: 'Windsurf',
    detect: ({ cwd, home }) =>
      existsSync(path.join(cwd, '.windsurf')) ||
      existsSync(path.join(home, '.codeium', 'windsurf')),
    locations: [
      { kind: 'rule', scope: 'project', container: 'file', rel: (n) => ['.windsurf', 'rules', `${n}.md`] },
      { kind: 'workflow', scope: 'project', container: 'file', rel: (n) => ['.windsurf', 'workflows', `${n}.md`] },
    ],
    mapKind: (type) => (type === 'bundle' ? null : type === 'rule' ? 'rule' : 'workflow'),
    scopes: () => 'project',
    container: () => 'file',
    targetRel: (kind, name) =>
      kind === 'rule' ? ['.windsurf', 'rules', `${name}.md`] : ['.windsurf', 'workflows', `${name}.md`],
    render: (kind, { description, body, name }) => {
      if (kind === 'rule') return { filename: `${name}.md`, content: body };
      return { filename: `${name}.md`, content: yamlFront({ description }) + body };
    },
    parse: mdParse,
  },

  gemini: {
    label: 'Gemini CLI',
    detect: ({ cwd, home }) =>
      existsSync(path.join(cwd, '.gemini')) || existsSync(path.join(home, '.gemini')),
    locations: [
      { kind: 'command', scope: 'project', container: 'file', rel: (n) => ['.gemini', 'commands', `${n}.toml`] },
      { kind: 'command', scope: 'global', container: 'file', rel: (n) => ['.gemini', 'commands', `${n}.toml`] },
    ],
    mapKind: (type) => (type === 'bundle' ? null : 'command'),
    scopes: () => 'both',
    container: () => 'file',
    targetRel: (kind, name) => ['.gemini', 'commands', `${name}.toml`],
    render: (kind, canonical) => ({
      filename: `${canonical.name}.toml`,
      content: renderGeminiToml(canonical),
    }),
    parse: (content, ext) => {
      if (ext === '.toml') {
        const parsed = parseGeminiToml(content);
        if (parsed.body === null) {
          throw new CliError(
            "Couldn't read a prompt out of this Gemini command — install it unconverted with --agent gemini.",
            1,
          );
        }
        return { description: parsed.description, body: parsed.body };
      }
      return mdParse(content);
    },
  },

  opencode: {
    label: 'opencode',
    detect: ({ cwd, home }) =>
      existsSync(path.join(cwd, '.opencode')) ||
      existsSync(path.join(home, '.config', 'opencode')),
    locations: [
      { kind: 'command', scope: 'project', container: 'file', rel: (n) => ['.opencode', 'command', `${n}.md`] },
      { kind: 'command', scope: 'global', container: 'file', rel: (n) => ['.config', 'opencode', 'command', `${n}.md`] },
    ],
    mapKind: (type) => (type === 'bundle' ? null : 'command'),
    scopes: () => 'both',
    container: () => 'file',
    targetRel: (kind, name, scope) =>
      scope === 'global'
        ? ['.config', 'opencode', 'command', `${name}.md`]
        : ['.opencode', 'command', `${name}.md`],
    render: (kind, { description, body, name }) => ({
      filename: `${name}.md`,
      content: yamlFront({ description }) + body,
    }),
    parse: mdParse,
  },
};

export const AGENT_IDS = Object.keys(AGENTS);

export function getAgent(id) {
  const a = AGENTS[id];
  if (!a) {
    throw new CliError(`Unknown agent "${id}". Supported: ${AGENT_IDS.join(', ')}.`, 2);
  }
  return a;
}

export function detectAgents(ctx) {
  return AGENT_IDS.filter((id) => AGENTS[id].detect(ctx));
}

// Explicit-path classification: which agent convention does this path follow?
export function classifyByConvention(absPath, isDir) {
  const norm = absPath.split(path.sep).join('/');
  const rules = [
    [/\/\.claude\/skills\/[^/]+$/, true, 'skill', 'claude-code'],
    [/\/\.claude\/commands\/[^/]+\.md$/, false, 'command', 'claude-code'],
    [/\/\.cursor\/rules\/[^/]+\.mdc$/, false, 'rule', 'cursor'],
    [/\/\.cursor\/commands\/[^/]+\.md$/, false, 'command', 'cursor'],
    [/\/\.codex\/prompts\/[^/]+\.md$/, false, 'prompt', 'codex'],
    [/\/\.github\/prompts\/[^/]+\.prompt\.md$/, false, 'prompt', 'copilot'],
    [/\/\.windsurf\/rules\/[^/]+\.md$/, false, 'rule', 'windsurf'],
    [/\/\.windsurf\/workflows\/[^/]+\.md$/, false, 'workflow', 'windsurf'],
    [/\/\.gemini\/commands\/[^/]+\.toml$/, false, 'command', 'gemini'],
    [/\/(\.opencode|opencode)\/command\/[^/]+\.md$/, false, 'command', 'opencode'],
  ];
  for (const [re, wantDir, type, agent] of rules) {
    if (wantDir === isDir && re.test(norm)) return { type, agent };
  }
  return null;
}

// Strip an artifact filename down to its bare name (handles ".prompt.md").
export function artifactBaseName(filename) {
  return filename.replace(/\.prompt\.md$/, '').replace(/\.[^.]+$/, '');
}

// Extract the canonical document from a verified package: the primary doc,
// parsed with the SOURCE agent's dialect.
export function extractCanonical(manifest, readFileSyncish) {
  const files = manifest.files;
  let primary =
    files.find((f) => f.path === 'SKILL.md') ??
    (files.length === 1 ? files[0] : files.find((f) => /\.(md|mdc|toml)$/.test(f.path) && !f.path.includes('/')));
  if (!primary) {
    throw new CliError(
      `This package has no convertible primary document. Install it natively${manifest.agent ? ` (--agent ${manifest.agent})` : ''} or with --dir.`,
      2,
    );
  }
  const content = readFileSyncish(primary.path);
  const ext = path.extname(primary.path);
  const sourceAgent = AGENTS[manifest.agent] ?? AGENTS['claude-code'];
  const parsed = sourceAgent.parse(content, ext);
  const dropped = files.filter((f) => f.path !== primary.path).map((f) => f.path);
  return {
    name: manifest.name,
    description: (parsed.description || manifest.description || '').trim(),
    body: parsed.body.replace(/^\n+/, ''),
    primaryPath: primary.path,
    dropped,
  };
}
