// Local artifact discovery + metadata inference. Authors never write a
// manifest; everything is inferred at share time (§4.1).
import { readdir, readFile, stat, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { sha256hex } from './fingerprint.js';
import { CliError } from './errors.js';
import { AGENTS, AGENT_IDS, classifyByConvention, artifactBaseName, parseGeminiToml } from './agents.js';

// Never packaged, not even with --force.
const HARD_EXCLUDE_DIRS = new Set(['.git', 'node_modules']);
const HARD_EXCLUDE_FILES = [/^\.DS_Store$/, /\.log$/i];
// Secret-shaped: skipped with a warning; --force includes them.
const SECRET_PATTERNS = [
  { re: /^\.env$/, label: 'secret pattern' },
  { re: /^\.env\..+$/, label: 'secret pattern' },
  { re: /\.pem$/i, label: 'secret pattern' },
  { re: /^id_rsa/, label: 'secret pattern' },
  { re: /token/i, label: 'secret pattern' },
  { re: /secret/i, label: 'secret pattern' },
];
const RESERVED_NAMES = new Set(['skillshark.json']);

function hardExcluded(name) {
  return HARD_EXCLUDE_FILES.some((re) => re.test(name));
}

function secretMatch(name) {
  return SECRET_PATTERNS.find((p) => p.re.test(name)) ?? null;
}

// --- share-argument resolution (§4.1) ---------------------------------------

// Candidate locations for a bare name, in search order: claude-code first
// (project before global), then every other adapter in registry order.
export function nameCandidates(name, { cwd, home }) {
  const out = [];
  for (const id of AGENT_IDS) {
    for (const loc of AGENTS[id].locations) {
      const base = loc.scope === 'project' ? cwd : home;
      const rel = loc.rel(name);
      out.push({
        root: path.join(base, ...rel),
        isDir: loc.container === 'dir',
        type: loc.kind,
        agent: id,
        where: `${loc.scope === 'project' ? '' : '~/'}${rel.slice(0, -1).join('/')} (${loc.scope}, ${AGENTS[id].label})`,
      });
    }
  }
  return out;
}

async function existsAs(p, wantDir) {
  try {
    const s = await stat(p);
    return wantDir ? s.isDirectory() : s.isFile();
  } catch {
    return false;
  }
}

// Classify an explicit path by its on-disk convention (§4.1): any adapter
// convention wins; otherwise prompt (file) or bundle (directory).
export function classifyPath(absPath, isDir) {
  const hit = classifyByConvention(absPath, isDir);
  if (hit) return hit;
  return { type: isDir ? 'bundle' : 'prompt', agent: '' };
}

// List every artifact name visible from here, across all adapters (suggestions).
export async function knownNames({ cwd, home }) {
  const names = new Set();
  for (const id of AGENT_IDS) {
    for (const loc of AGENTS[id].locations) {
      const base = loc.scope === 'project' ? cwd : home;
      // rel('') gives us the parent dir + the filename pattern's extension
      const probe = loc.rel('@');
      const dir = path.join(base, ...probe.slice(0, -1));
      const suffix = probe[probe.length - 1].replace('@', '');
      try {
        for (const ent of await readdir(dir, { withFileTypes: true })) {
          if (loc.container === 'dir' && ent.isDirectory()) names.add(ent.name);
          else if (loc.container === 'file' && ent.isFile() && suffix && ent.name.endsWith(suffix)) {
            names.add(artifactBaseName(ent.name));
          }
        }
      } catch { /* location absent */ }
    }
  }
  return [...names].sort();
}

function editDistance(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return d[m][n];
}

export function nearestNames(name, candidates, max = 3) {
  return candidates
    .map((c) => ({ c, d: editDistance(name.toLowerCase(), c.toLowerCase()) }))
    .filter(({ c, d }) => d <= 3 || c.toLowerCase().includes(name.toLowerCase()))
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map(({ c }) => c);
}

// Resolve the share argument: an existing path wins; otherwise a name (one
// leading "/" stripped) searched across the four known locations.
// Returns { matches: [{ root, isDir, type, agent, where }] }; throws CliError(2)
// for no hit. Multiple hits are returned for the caller to pick or refuse.
export async function resolveShareArg(arg, { cwd, home }) {
  const asPath = path.resolve(cwd, arg);
  if (existsSync(asPath)) {
    const s = await stat(asPath);
    const isDir = s.isDirectory();
    const { type, agent } = classifyPath(asPath, isDir);
    return { matches: [{ root: asPath, isDir, type, agent, where: 'explicit path' }] };
  }
  const name = arg.startsWith('/') ? arg.slice(1) : arg;
  if (!name || name.includes('/')) {
    throw new CliError(`No such path or skill: "${arg}"`, 2);
  }
  const matches = [];
  for (const cand of nameCandidates(name, { cwd, home })) {
    if (await existsAs(cand.root, cand.isDir)) {
      matches.push(cand);
    }
  }
  if (matches.length === 0) {
    const known = await knownNames({ cwd, home });
    const near = nearestNames(name, known);
    let msg = `No skill named "${name}" found here or in any known agent location.`;
    if (near.length) msg += `\nDid you mean: ${near.join(', ')}?`;
    else if (known.length) msg += `\nAvailable: ${known.slice(0, 8).join(', ')}`;
    throw new CliError(msg, 2);
  }
  return { matches, name };
}

// --- file collection (§4.1 excludes) ----------------------------------------

// Walk an artifact and apply the exclude rules. Returns:
//   files:    [{ path, abs, size, mode, executable, sha256 }]
//   warnings: [{ path, reason, forceable }]
export async function collectFiles(root, { isDir, force = false } = {}) {
  const files = [];
  const warnings = [];

  async function addFile(abs, rel) {
    const data = await readFile(abs);
    const s = await stat(abs);
    const executable = Boolean(s.mode & 0o111);
    files.push({
      path: rel,
      abs,
      size: data.length,
      mode: executable ? '0755' : '0644',
      executable,
      sha256: sha256hex(data),
    });
  }

  async function consider(abs, rel, name) {
    if (RESERVED_NAMES.has(name)) {
      warnings.push({ path: rel, reason: 'reserved name', forceable: false });
      return;
    }
    if (hardExcluded(name)) return; // silently never packaged
    const secret = secretMatch(name);
    if (secret && !force) {
      warnings.push({ path: rel, reason: secret.label, forceable: true });
      return;
    }
    await addFile(abs, rel);
  }

  if (!isDir) {
    const name = path.basename(root);
    await consider(root, name, name);
  } else {
    async function walk(dir, prefix) {
      const dirents = (await readdir(dir, { withFileTypes: true }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const ent of dirents) {
        const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
        const abs = path.join(dir, ent.name);
        const ls = await lstat(abs);
        if (ls.isSymbolicLink()) {
          warnings.push({ path: rel, reason: 'symlink', forceable: false });
          continue;
        }
        if (ent.isDirectory()) {
          if (HARD_EXCLUDE_DIRS.has(ent.name)) continue;
          await walk(abs, rel);
        } else if (ent.isFile()) {
          await consider(abs, rel, ent.name);
        }
      }
    }
    await walk(root, '');
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files, warnings };
}

// --- metadata inference (§4.1) ----------------------------------------------

// Tiny frontmatter reader: a leading "---" block of `key: value` lines.
export function parseFrontmatter(text) {
  const data = {};
  if (!text.startsWith('---')) return { data, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { data, body: text };
  const block = text.slice(text.indexOf('\n') + 1, end);
  for (const line of block.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    data[m[1]] = value;
  }
  return { data, body: text.slice(end + 4) };
}

function firstHeadingOrParagraph(body) {
  const heading = body.match(/^#+\s+(.+)$/m);
  if (heading) return heading[1].trim();
  for (const block of body.split(/\n\s*\n/)) {
    const t = block.trim();
    if (t && !t.startsWith('#') && !t.startsWith('---')) return t.split('\n')[0].trim();
  }
  return '';
}

// The artifact's primary document: SKILL.md for a skill, the file itself for
// single-file artifacts, else the only .md present.
export function primaryDocPath(files, { isDir, type }) {
  if (!isDir) return files[0]?.path ?? null;
  const skillMd = files.find((f) => f.path === 'SKILL.md');
  if (skillMd) return skillMd.path;
  const mds = files.filter((f) => f.path.endsWith('.md') && !f.path.includes('/'));
  if (mds.length === 1) return mds[0].path;
  return null;
}

// name: frontmatter `name:` → basename (--name overrides, applied by caller).
// description: frontmatter → first heading → first paragraph → "".
// Dialect-aware: .md/.mdc/.prompt.md use YAML frontmatter; .toml is gemini.
export async function inferMetadata({ root, isDir, type, agent, files }) {
  let fm = {};
  let body = '';
  const docRel = primaryDocPath(files, { isDir, type });
  if (docRel) {
    const docAbs = isDir ? path.join(root, ...docRel.split('/')) : root;
    try {
      const text = await readFile(docAbs, 'utf8');
      if (docRel.endsWith('.toml')) {
        const parsed = parseGeminiToml(text);
        if (parsed.description) fm.description = parsed.description;
        body = parsed.body ?? '';
      } else if (/\.(md|mdc)$/.test(docRel)) {
        const parsed = parseFrontmatter(text);
        fm = parsed.data;
        body = parsed.body;
      }
    } catch { /* unreadable doc → fall back to basenames */ }
  }
  const base = artifactBaseName(path.basename(root));
  const name = (fm.name && String(fm.name).trim()) || base;
  const description = (fm.description && String(fm.description).trim()) || firstHeadingOrParagraph(body) || '';
  const dependencies = [];
  for (const key of ['requires', 'mcp']) {
    if (fm[key]) dependencies.push({ [key]: fm[key] });
  }
  return { name, type, agent, description, dependencies, primaryDoc: docRel };
}

// §2.4 — relative references that escape the artifact ("../shared/util.md"):
// the skill may not work standalone. Scans packaged .md files.
export async function findExternalRefs(files) {
  const refs = new Set();
  for (const f of files) {
    if (!f.path.endsWith('.md')) continue;
    let text;
    try {
      text = await readFile(f.abs, 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/(?:^|[\s('"`(=])(\.\.\/[A-Za-z0-9_./-]+)/g)) {
      refs.add(m[1]);
    }
  }
  return [...refs].sort();
}
