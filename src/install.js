// The §4.2 pipeline: fetch → extract (guarded) → verify (sha256 + tree
// fingerprint + #fp=) → expiry → preview → destination (agent + scope +
// optional rename/conversion) → conflict → confirm → atomic write → record.
// Never executes anything from a package. The receive path never shells out:
// this module and the transports it uses import no subprocess machinery at
// all (enforced by test and by the DoD grep).
import { mkdtemp, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CliError, MSG } from './errors.js';
import { parseSource, formatSource, resolveHost } from './source.js';
import { fetchGistPackage } from './transports/gist.js';
import { fetchRepoTree } from './transports/repo.js';
import { extractTarball, hashTree, readManifest, verifyTreeAgainstManifest, MANIFEST_NAME } from './pkg.js';
import { treeFingerprint, sha256hex, fp8, formatFp8 } from './fingerprint.js';
import { decryptEnvelope, decodeSecret, MSG_ENCRYPTED_NEEDS_KEY } from './crypt.js';
import { inferMetadata, findExternalRefs } from './discover.js';
import { AGENTS, AGENT_IDS, getAgent, detectAgents, extractCanonical, rewriteFrontmatterName, NAME_RE } from './agents.js';
import { addInstallRecord } from './config.js';
import { renderPreview, renderFileTree, humanSize, displayPath, plural } from './ui.js';
import { VERSION } from './version.js';

const DAY_MS = 86400000;

// --- fetch + verify (shared by install and inspect) -------------------------

function classifyRepoTree(actual, subPath, repo) {
  if (subPath && /(^|\/)\.claude\/commands\/[^/]+\.md$/.test(subPath)) {
    return { type: 'command', agent: 'claude-code' };
  }
  if (actual.some((f) => f.path === 'SKILL.md')) return { type: 'skill', agent: 'claude-code' };
  if (actual.length === 1 && subPath && subPath.endsWith(actual[0].path)) {
    return { type: 'prompt', agent: '' };
  }
  return { type: 'bundle', agent: '' };
}

export async function fetchAndVerify(sourceStr, deps, opts = {}) {
  const defaultHost = resolveHost(opts, deps);
  const src = parseSource(sourceStr, { defaultHost });
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'skillshark-recv-'));

  if (src.kind === 'gist') {
    const gist = await fetchGistPackage(src.id, { fetch: deps.fetch, host: src.host, ghApi: deps.ghApi });
    let tarball;
    if (gist.encrypted) {
      if (!src.key) throw new CliError(MSG_ENCRYPTED_NEEDS_KEY, 1);
      tarball = decryptEnvelope(gist.bytes, decodeSecret(src.key));
    } else {
      tarball = gist.bytes;
    }
    await extractTarball(tarball, workDir);
    const manifest = await readManifest(workDir);
    const actual = await hashTree(workDir);
    const fingerprint = verifyTreeAgainstManifest(actual, manifest);
    if (src.fp && !fingerprint.startsWith(src.fp)) {
      throw new CliError(MSG.linkIntegrity, 1);
    }
    return {
      src,
      workDir,
      manifest,
      fingerprint,
      sender: gist.owner,
      fpVerified: Boolean(src.fp),
      sourceRecord: `${formatSource({ ...src })}@${gist.revision ?? 'unknown'}`,
    };
  }

  // repo: no manifest exists; run the share-side inference on the extracted
  // tree and synthesize one in memory. The commit SHA is the integrity.
  const { sha } = await fetchRepoTree(src, workDir, { fetch: deps.fetch, ghApi: deps.ghApi });
  const actual = await hashTree(workDir, { exclude: [] });
  if (actual.length === 0) {
    throw new CliError(`No files found at gh:${src.owner}/${src.repo}${src.path ? `/${src.path}` : ''}@${sha.slice(0, 7)}.`, 1);
  }
  const { type, agent } = classifyRepoTree(actual, src.path, src.repo);
  const withAbs = actual.map((f) => ({ ...f, abs: path.join(workDir, ...f.path.split('/')) }));
  const meta = await inferMetadata({
    root: workDir,
    isDir: true,
    type,
    agent,
    files: withAbs,
  });
  const fallbackName = path.basename(src.path ?? src.repo).replace(/\.[^.]+$/, '');
  const manifest = {
    skillshark: '2',
    name: meta.name === path.basename(workDir) ? fallbackName : meta.name,
    type,
    agent,
    description: meta.description,
    files: actual.map((f) => ({ ...f, mode: f.executable ? '0755' : '0644' })),
    totalSize: actual.reduce((n, f) => n + f.size, 0),
    createdAt: null,
    expiresAt: null,
    tool: { name: 'skillshark', version: VERSION },
    dependencies: meta.dependencies,
    fingerprint: treeFingerprint(actual),
  };
  return {
    src,
    workDir,
    manifest,
    fingerprint: manifest.fingerprint,
    sender: src.owner,
    fpVerified: false,
    sourceRecord: `${formatSource({ ...src, ref: null })}@${sha}`,
  };
}

// --- expiry (§4.2 step 4) ----------------------------------------------------

export function expiryState(manifest, now = Date.now()) {
  if (!manifest.expiresAt) return { state: 'none' };
  const exp = Date.parse(manifest.expiresAt);
  if (Number.isNaN(exp)) return { state: 'none' };
  if (exp >= now) {
    const remMs = exp - now;
    const days = Math.floor(remMs / DAY_MS);
    return { state: 'live', days, hours: Math.max(1, Math.floor(remMs / 3600000)) };
  }
  const days = Math.max(1, Math.floor((now - exp) / DAY_MS));
  return { state: 'expired', days };
}

export function expiredMessage(manifest, now = Date.now()) {
  const { days } = expiryState(manifest, now);
  return (
    `The sender marked this share as expired ${plural(days, 'day')} ago.\n` +
    `The files still exist until they prune — ask for a fresh link:  skillshark share ${manifest.name}`
  );
}

// --- conflict diff (§4.2 step 7) ----------------------------------------------

export function diffTrees(existingFiles, incomingFiles) {
  const existing = new Map(existingFiles.map((f) => [f.path, f.sha256]));
  const incoming = new Map(incomingFiles.map((f) => [f.path, f.sha256]));
  const added = [];
  const changed = [];
  const removed = [];
  for (const [p, sha] of incoming) {
    if (!existing.has(p)) added.push(p);
    else if (existing.get(p) !== sha) changed.push(p);
  }
  for (const p of existing.keys()) {
    if (!incoming.has(p)) removed.push(p);
  }
  added.sort();
  changed.sort();
  removed.sort();
  return { added, changed, removed };
}

async function existingTreeFor(target, plan) {
  if (plan.targetIsFile) {
    const data = await readFile(target);
    return [{ path: plan.files[0].path, sha256: sha256hex(data), size: data.length }];
  }
  const exclude = plan.files.some((f) => f.path === MANIFEST_NAME) ? [] : undefined;
  return hashTree(target, exclude ? { exclude } : undefined);
}

// --- destination: agent choice, scope, plan -----------------------------------

function isProjectish(cwd) {
  if (existsSync(path.join(cwd, '.git'))) return true;
  for (const probe of ['.claude', '.cursor', '.codex', '.windsurf', '.gemini', '.opencode', '.github']) {
    if (existsSync(path.join(cwd, probe))) return true;
  }
  return false;
}

// Which agent are we installing for? --agent wins; else the package's native
// agent when it's detected locally; else (TTY) offer the agents that ARE here.
async function chooseAgent(manifest, opts, deps, interactive) {
  if (opts.agent) return { agentId: opts.agent }; // validated before the fetch
  const srcAgent = manifest.agent || null;
  if (!srcAgent) {
    throw new CliError(
      `This package is a ${manifest.type} with no agent convention — re-run with --agent <${AGENT_IDS.join('|')}> or --dir <path>.`,
      2,
    );
  }
  if (AGENTS[srcAgent] && AGENTS[srcAgent].detect(deps)) return { agentId: srcAgent };
  const others = detectAgents(deps).filter((id) => id !== srcAgent);
  if (interactive && others.length) {
    const srcLabel = AGENTS[srcAgent]?.label ?? srcAgent;
    deps.ui.warn(`This is a ${srcLabel} ${manifest.type}, but ${srcLabel} isn't detected here. Detected: ${others.map((o) => AGENTS[o].label).join(', ')}.`);
    const choice = await deps.prompts.select({
      message: 'Install for:',
      options: [
        { value: srcAgent, label: `${srcLabel} anyway`, hint: 'native, creates its directories' },
        ...others.map((o) => ({ value: o, label: `${AGENTS[o].label}`, hint: 'converted — instructions only' })),
        { value: '__cancel', label: 'Cancel' },
      ],
    });
    if (choice === null || choice === '__cancel') return { cancelled: true };
    return { agentId: choice };
  }
  return { agentId: srcAgent }; // non-TTY default: native, predictable
}

async function chooseScope(agent, kind, name, opts, deps, interactive, loud) {
  const allowed = agent.scopes(kind);
  if (allowed === 'global') {
    if (opts.project) {
      throw new CliError(`${agent.label} ${kind}s live in your home directory only — drop --project.`, 2);
    }
    if (loud) deps.ui.info(`${agent.label} ${kind}s are global — installing under ~/.`);
    return { root: deps.home, scope: 'global' };
  }
  if (allowed === 'project') {
    if (opts.global) {
      throw new CliError(`${agent.label} ${kind}s are project-scoped — run inside the project (drop --global).`, 2);
    }
    if (!opts.project && !interactive && !isProjectish(deps.cwd)) {
      throw new CliError(
        "This directory doesn't look like a project (no .git or agent directories). Re-run with --project to confirm, or --dir <path>.",
        2,
      );
    }
    return { root: deps.cwd, scope: 'project' };
  }
  // both
  if (opts.project) return { root: deps.cwd, scope: 'project' };
  if (opts.global) return { root: deps.home, scope: 'global' };
  if (interactive) {
    const projRel = agent.targetRel(kind, name, 'project').join('/');
    const globRel = agent.targetRel(kind, name, 'global').join('/');
    const choice = await deps.prompts.select({
      message: 'Install to:',
      options: [
        { value: 'project', label: projRel, hint: 'this project' },
        { value: 'global', label: `~/${globRel}`, hint: 'all projects' },
        { value: 'cancel', label: 'cancel' },
      ],
    });
    if (choice === null || choice === 'cancel') return { cancelled: true };
    return { root: choice === 'global' ? deps.home : deps.cwd, scope: choice };
  }
  if (isProjectish(deps.cwd)) return { root: deps.cwd, scope: 'project' };
  throw new CliError(
    "Can't tell if this is a project (no .git or agent directories here). Pass --project, --global, or --dir.",
    2,
  );
}

// Interactive installs offer a rename up front (the --name flag skips this).
async function askInstallName(deps, current) {
  const choice = await deps.prompts.select({
    message: 'Name it:',
    options: [
      { value: 'keep', label: `Keep "${current}"` },
      { value: 'rename', label: 'Install under a different name…' },
    ],
  });
  if (choice === null) return null; // cancelled
  if (choice === 'keep') return current;
  for (;;) {
    const entered = deps.prompts.text
      ? await deps.prompts.text({ message: 'Install as:', placeholder: current })
      : null;
    if (entered === null) return current; // backed out of typing → keep
    const name = String(entered).trim();
    if (!name) return current;
    if (NAME_RE.test(name)) return name;
    deps.ui.warn('Names are letters, digits, ".", "_", "-". Try again.');
  }
}

// Build the exact file set that will land on disk (post-rename, post-conversion).
function buildPlan({ workDir, manifest, name, agentId, kind, target, deps, loud }) {
  const agent = getAgent(agentId);
  const native = agentId === (manifest.agent || null);
  const container = agent.container(kind);
  const notes = [];
  let files;
  let conversion = null;

  const readPkgFile = (rel) => readFileSync(path.join(workDir, ...rel.split('/')));

  if (native && container === 'dir') {
    // native multi-file skill, copied verbatim (modulo rename)
    files = manifest.files.map((f) => ({
      path: f.path,
      data: readPkgFile(f.path),
      executable: Boolean(f.executable),
    }));
    if (name !== manifest.name) {
      const primary = files.find((f) => f.path === 'SKILL.md');
      if (primary) {
        primary.data = Buffer.from(rewriteFrontmatterName(primary.data.toString('utf8'), name));
        notes.push(`Renamed "${manifest.name}" → "${name}" (frontmatter name updated).`);
      } else {
        notes.push(`Renamed "${manifest.name}" → "${name}".`);
      }
    }
  } else if (native && manifest.files.length === 1) {
    // native single-file artifact, verbatim; rename = filename change
    const f = manifest.files[0];
    const filename = path.basename(target);
    let data = readPkgFile(f.path);
    if (name !== manifest.name) {
      data = Buffer.from(rewriteFrontmatterName(data.toString('utf8'), name));
      notes.push(`Renamed "${manifest.name}" → "${name}".`);
    }
    files = [{ path: filename, data, executable: Boolean(f.executable) }];
  } else {
    // conversion (cross-agent, or a multi-file package squeezed into one doc)
    const canonical = extractCanonical(manifest, (p) => readPkgFile(p).toString('utf8'));
    const rendered = agent.render(kind, { name, description: canonical.description, body: canonical.body });
    const filename = container === 'dir' ? rendered.filename : path.basename(target);
    files = [{ path: filename, data: Buffer.from(rendered.content), executable: false }];
    const fromLabel = manifest.agent ? `${AGENTS[manifest.agent]?.label ?? manifest.agent} ${manifest.type}` : manifest.type;
    conversion = { from: manifest.agent || null, to: agentId, dropped: canonical.dropped };
    notes.push(`Converting ${fromLabel} → ${agent.label} ${kind} (best effort — review the result).`);
    if (canonical.dropped.length) {
      notes.push(`${plural(canonical.dropped.length, 'bundled file')} cannot come along: ${canonical.dropped.join(', ')}.`);
    }
    if (name !== manifest.name) notes.push(`Renamed "${manifest.name}" → "${name}".`);
  }

  const fingerprint = treeFingerprint(files.map((f) => ({ path: f.path, sha256: sha256hex(f.data) })));
  if (loud) {
    for (const note of notes) {
      if (note.startsWith('Convert') || note.includes('cannot come along')) deps.ui.warn(note);
      else deps.ui.info(note);
    }
  }
  return { agentId, kind, target, targetIsFile: container === 'file', files, fingerprint, conversion, notes };
}

function verbatimDirPlan(workDir, manifest, target) {
  const files = manifest.files.map((f) => ({
    path: f.path,
    data: readFileSync(path.join(workDir, ...f.path.split('/'))),
    executable: Boolean(f.executable),
  }));
  return {
    agentId: manifest.agent || null,
    kind: manifest.type,
    target,
    targetIsFile: false,
    files,
    fingerprint: treeFingerprint(files.map((f) => ({ path: f.path, sha256: sha256hex(f.data) }))),
    conversion: null,
    notes: [],
  };
}

// --- atomic write (§4.2 step 9) ------------------------------------------------

async function atomicWrite({ plan, allowExec, beforeRename }) {
  const { target, targetIsFile } = plan;
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const stage = path.join(parent, `.skillshark-stage-${token}`);
  let written = 0;
  try {
    if (targetIsFile) {
      const f = plan.files[0];
      await writeFile(stage, f.data, { mode: allowExec && f.executable ? 0o755 : 0o644 });
      written = 1;
    } else {
      await mkdir(stage);
      for (const f of plan.files) {
        const dest = path.join(stage, ...f.path.split('/'));
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, f.data, { mode: allowExec && f.executable ? 0o755 : 0o644 });
        written += 1;
      }
    }
    if (beforeRename) await beforeRename();
    let backup = null;
    if (existsSync(target)) {
      backup = path.join(parent, `.skillshark-old-${token}`);
      await rename(target, backup);
    }
    try {
      await rename(stage, target);
    } catch (err) {
      if (backup) await rename(backup, target).catch(() => {});
      throw err;
    }
    if (backup) await rm(backup, { recursive: true, force: true });
    return written;
  } catch (err) {
    await rm(stage, { recursive: true, force: true });
    throw err;
  }
}

// --- the pipeline ---------------------------------------------------------------

export async function runInstall(sourceStr, opts, deps) {
  // hard rule 5: a prompt with no TTY is a bug — refuse before touching the network
  if (!deps.isTTY && !opts.yes) {
    throw new CliError(
      'Non-interactive install needs --yes (and --project/--global/--dir if the scope is ambiguous).',
      2,
    );
  }
  if (opts.name && !NAME_RE.test(opts.name)) {
    throw new CliError(`--name must be a simple name (letters, digits, ".", "_", "-"), got "${opts.name}".`, 2);
  }
  if (opts.agent) getAgent(opts.agent); // validate early, before the network
  const interactive = deps.isTTY && !opts.yes;
  const loud = !opts.json && !opts.quiet;
  const ui = deps.ui;
  const verified = await ui.spin('Fetching and verifying the package', () => fetchAndVerify(sourceStr, deps, opts));
  const { workDir, manifest, fingerprint, sourceRecord } = verified;

  try {
    // step 4 — advisory expiry: install refuses, inspect does not
    const exp = expiryState(manifest);
    if (exp.state === 'expired') {
      throw new CliError(expiredMessage(manifest), 1);
    }

    // step 5 — preview from verified bytes only
    const externalRefs = await findExternalRefs(
      manifest.files
        .filter((f) => f.path.endsWith('.md'))
        .map((f) => ({ ...f, abs: path.join(workDir, ...f.path.split('/')) })),
    );
    if (loud) {
      renderPreview(ui, { manifest, fingerprint, fpFromLink: verified.fpVerified, externalRefs });
      ui.out('');
    }

    // step 6 — destination: --dir verbatim, or agent + scope (+ rename/conversion)
    let makePlan;
    let installName = opts.name ?? manifest.name;
    if (opts.dir) {
      if (opts.name && opts.name !== manifest.name) {
        ui.warn('--name is ignored with --dir (the directory you chose is the name).');
      }
      const target = path.resolve(deps.cwd, opts.dir);
      makePlan = () => verbatimDirPlan(workDir, manifest, target);
    } else {
      const agentChoice = await chooseAgent(manifest, opts, deps, interactive);
      if (agentChoice.cancelled) {
        ui.out('  Cancelled. Nothing was installed.');
        return { status: 'cancelled' };
      }
      const agentId = agentChoice.agentId;
      const agent = getAgent(agentId);
      const kind = agent.mapKind(manifest.type);
      if (!kind) {
        throw new CliError(
          `A ${manifest.type} package has no ${agent.label} representation — install it with --dir <path>.`,
          2,
        );
      }
      let baseName = opts.name ?? manifest.name;
      // keep it, or take it under a new name? (--name decides silently)
      if (interactive && !opts.name) {
        const chosen = await askInstallName(deps, baseName);
        if (chosen === null) {
          ui.out('  Cancelled. Nothing was installed.');
          return { status: 'cancelled' };
        }
        baseName = chosen;
      }
      const scope = await chooseScope(agent, kind, baseName, opts, deps, interactive, loud);
      if (scope.cancelled) {
        ui.out('  Cancelled. Nothing was installed.');
        return { status: 'cancelled' };
      }
      makePlan = (n = baseName, quiet = false) =>
        buildPlan({
          workDir,
          manifest,
          name: n,
          agentId,
          kind,
          target: path.join(scope.root, ...agent.targetRel(kind, n, scope.scope)),
          deps,
          loud: loud && !quiet,
        });
      installName = baseName;
    }
    let plan = makePlan();

    // step 7 — conflict
    let planName = installName;
    for (;;) {
      if (!existsSync(plan.target)) break;
      const existingFiles = await existingTreeFor(plan.target, plan);
      if (existingFiles.length === 0) break; // empty dir → nothing to conflict with
      const existingFp = treeFingerprint(existingFiles);
      if (existingFp === plan.fingerprint) {
        const msg = `ⓘ "${planName}" is already installed at ${displayPath(plan.target, deps)} and is identical (${formatFp8(plan.fingerprint)}). Nothing to do.`;
        if (opts.json) ui.out(JSON.stringify({ status: 'identical', name: planName, installedPath: plan.target }));
        else ui.out(`  ${msg}`);
        return { status: 'identical', target: plan.target };
      }
      const diff = diffTrees(existingFiles, plan.files.map((f) => ({ path: f.path, sha256: sha256hex(f.data) })));
      if (!interactive) {
        if (opts.force) break;
        throw new CliError(
          `"${planName}" already exists at ${displayPath(plan.target, deps)} and differs ` +
            `(+${diff.added.length} ~${diff.changed.length} -${diff.removed.length}). Re-run with --force to overwrite.`,
          1,
        );
      }
      ui.warn(`"${planName}" already exists at ${displayPath(plan.target, deps)} and differs:`);
      for (const p of diff.changed) ui.out(`      ~ ${p}   (changed)`);
      for (const p of diff.added) ui.out(`      + ${p}   (added)`);
      for (const p of diff.removed) ui.out(`      - ${p}   (removed)`);
      const action = await deps.prompts.select({
        message: 'What now?',
        options: [
          { value: 'overwrite', label: `Overwrite ${displayPath(plan.target, deps)}` },
          { value: 'rename', label: 'Install under a different name…' },
          { value: 'side', label: `Install side-by-side as "${planName}-2"` },
          { value: 'cancel', label: 'Cancel' },
        ],
      });
      if (action === null || action === 'cancel') {
        ui.out('  Cancelled. Nothing was installed.');
        return { status: 'cancelled' };
      }
      if (action === 'overwrite') break;
      if (action === 'rename') {
        const entered = deps.prompts.text
          ? await deps.prompts.text({ message: 'New name:', placeholder: `${planName}-2` })
          : null;
        if (!entered || !NAME_RE.test(entered)) {
          ui.warn('Names are letters, digits, ".", "_", "-". Try again.');
          continue;
        }
        planName = entered;
        plan = makePlan(planName, true);
        continue;
      }
      if (action === 'side') {
        let n = 2;
        let cand = `${planName}-${n}`;
        while (n < 100) {
          const p = makePlan(cand, true);
          if (!existsSync(p.target)) break;
          n += 1;
          cand = `${planName}-${n}`;
        }
        planName = cand;
        plan = makePlan(planName, true);
        continue;
      }
    }

    // step 8 — confirm
    if (interactive) {
      const go = await deps.prompts.confirm({
        message: `Install to ${displayPath(plan.target, deps)}?`,
      });
      if (go !== true) {
        ui.out('  Cancelled. Nothing was installed.');
        return { status: 'cancelled' };
      }
    } else if (loud) {
      ui.out(`  Installing to ${displayPath(plan.target, deps)}`);
    }

    // step 9 — atomic write (exec bits stripped unless --allow-exec)
    const filesWritten = await atomicWrite({
      plan,
      allowExec: Boolean(opts.allowExec),
      beforeRename: deps.beforeRename,
    });

    // step 10 — record
    await addInstallRecord(deps.configDir, {
      name: planName,
      agent: plan.agentId,
      path: plan.target,
      fingerprint: plan.fingerprint,
      installedAt: new Date().toISOString(),
      source: sourceRecord,
      ...(plan.conversion ? { convertedFrom: plan.conversion.from } : {}),
    });

    // step 11 — report
    if (opts.json) {
      ui.out(JSON.stringify({
        name: planName,
        type: manifest.type,
        agent: plan.agentId,
        kind: plan.kind,
        installedPath: plan.target,
        filesWritten,
        fingerprint: plan.fingerprint,
        source: sourceRecord,
        convertedFrom: plan.conversion?.from ?? null,
        renamedFrom: planName !== manifest.name ? manifest.name : null,
      }));
    } else if (opts.quiet) {
      ui.out(plan.target);
    } else {
      ui.ok('Verified checksums');
      ui.ok(`Installed to ${displayPath(plan.target, deps)}`);
      const label = plan.agentId ? (AGENTS[plan.agentId]?.label ?? plan.agentId) : null;
      if (plan.agentId === 'claude-code') {
        ui.out(`  Available in Claude Code as the "${planName}" ${plan.kind} — restart the session to pick it up.`);
      } else if (label && plan.kind === 'rule') {
        ui.out(`  Active in ${label} as the "${planName}" rule — restart the session to pick it up.`);
      } else if (label) {
        ui.out(`  Available in ${label} as /${planName} — restart the session to pick it up.`);
      } else {
        ui.out('  Restart the session to pick it up.');
      }
    }
    return { status: 'installed', target: plan.target, filesWritten, fingerprint: plan.fingerprint, plan };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

// --- inspect (§4.3) ---------------------------------------------------------------

function summaryLine(verified) {
  const { manifest, fingerprint, sender, fpVerified, src } = verified;
  const typeLabel = manifest.type.charAt(0).toUpperCase() + manifest.type.slice(1);
  const parts = [
    `${typeLabel}: ${manifest.name}`,
    manifest.agent || manifest.type,
    plural(manifest.files.length, 'file'),
    humanSize(manifest.totalSize ?? 0),
  ];
  if (sender) parts.push(`shared by @${sender}`);
  if (src.kind === 'repo') parts.push(`pinned ${verified.sourceRecord.split('@').pop().slice(0, 7)}`);
  const exp = expiryState(manifest);
  if (exp.state === 'live') {
    parts.push(`advisory expiry in ${exp.days >= 1 ? `${exp.days}d` : `${exp.hours}h`}`);
  } else if (exp.state === 'expired') {
    parts.push(`expired ${plural(exp.days, 'day')} ago`);
  }
  let line = parts.join(' · ');
  line += ` · Fingerprint ${formatFp8(fingerprint)}`;
  if (fpVerified) line += ' ✓ matches the link';
  return line;
}

function installTargetsLine(manifest) {
  const native = manifest.agent && AGENTS[manifest.agent] ? manifest.agent : null;
  const convertible = AGENT_IDS.filter((id) => id !== native && AGENTS[id].mapKind(manifest.type) !== null);
  const parts = [];
  if (native) parts.push(`${native} (native)`);
  if (convertible.length) parts.push(`convertible → ${convertible.join(', ')}`);
  if (!parts.length) return null;
  return `Installs to: ${parts.join(' · ')}`;
}

export async function runInspect(sourceStr, opts, deps) {
  const ui = deps.ui;
  const verified = await (opts.json || opts.files
    ? fetchAndVerify(sourceStr, deps, opts)
    : ui.spin('Fetching and verifying the package', () => fetchAndVerify(sourceStr, deps, opts)));
  const { workDir, manifest } = verified;
  try {
    if (opts.json) {
      ui.out(JSON.stringify({
        name: manifest.name,
        type: manifest.type,
        agent: manifest.agent || null,
        description: manifest.description ?? '',
        files: manifest.files.map(({ path: p, size, sha256, executable }) => ({ path: p, size, sha256, executable })),
        totalSize: manifest.totalSize,
        fingerprint: verified.fingerprint,
        fp8: fp8(verified.fingerprint),
        sender: verified.sender,
        expiresAt: manifest.expiresAt ?? null,
        source: verified.sourceRecord,
        fpVerified: verified.fpVerified,
        dependencies: manifest.dependencies ?? [],
        installTargets: AGENT_IDS.filter((id) => AGENTS[id].mapKind(manifest.type) !== null),
      }, null, 2));
      return { status: 'inspected' };
    }
    if (opts.files) {
      for (const f of manifest.files) {
        ui.out(`${f.path}\t${f.size}${f.executable ? '\t(executable)' : ''}`);
      }
      return { status: 'inspected' };
    }
    ui.out(`  ${summaryLine(verified)}`);
    const targets = installTargetsLine(manifest);
    if (targets) ui.out(`  ${targets}`);
    const exp = expiryState(manifest);
    if (exp.state === 'expired') {
      ui.warn('This share is past its advisory expiry — install will refuse it.');
    }
    if (opts.cat) {
      const f = manifest.files.find((x) => x.path === opts.cat);
      if (!f) {
        throw new CliError(
          `No file "${opts.cat}" in this package. Files:\n  ${manifest.files.map((x) => x.path).join('\n  ')}`,
          2,
        );
      }
      const content = await readFile(path.join(workDir, ...f.path.split('/')), 'utf8');
      ui.out('');
      ui.out(`  ── ${f.path} ${'─'.repeat(Math.max(4, 56 - f.path.length))}`);
      ui.raw(content.endsWith('\n') ? content : content + '\n');
      ui.out(`  ${'─'.repeat(60)}`);
    } else {
      ui.out('');
      renderFileTree(ui, manifest);
    }
    return { status: 'inspected' };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
