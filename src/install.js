// The §4.2 pipeline: fetch → extract (guarded) → verify (sha256 + tree
// fingerprint + #fp=) → expiry → preview → target → conflict → confirm →
// atomic write → record. Never executes anything from a package. The receive
// path never shells out: this module and the transports it uses import no
// subprocess machinery at all (enforced by test and by the DoD grep).
import { mkdtemp, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CliError, MSG } from './errors.js';
import { parseSource, formatSource } from './source.js';
import { fetchGistPackage } from './transports/gist.js';
import { fetchRepoTree } from './transports/repo.js';
import { extractTarball, hashTree, readManifest, verifyTreeAgainstManifest, MANIFEST_NAME } from './pkg.js';
import { treeFingerprint, sha256hex, fp8, formatFp8 } from './fingerprint.js';
import { inferMetadata, findExternalRefs } from './discover.js';
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

export async function fetchAndVerify(sourceStr, deps) {
  const src = parseSource(sourceStr);
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'skillshark-recv-'));

  if (src.kind === 'gist') {
    const gist = await fetchGistPackage(src.id, { fetch: deps.fetch });
    await extractTarball(gist.tarball, workDir);
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
      sourceRecord: `gist:${src.id}@${gist.revision ?? 'unknown'}`,
    };
  }

  // repo: no manifest exists; run the share-side inference on the extracted
  // tree and synthesize one in memory. The commit SHA is the integrity.
  const { sha } = await fetchRepoTree(src, workDir, { fetch: deps.fetch });
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

async function existingTreeFor(target, targetIsFile, manifest) {
  if (targetIsFile) {
    const data = await readFile(target);
    return [{ path: manifest.files[0].path, sha256: sha256hex(data), size: data.length }];
  }
  // if the package legitimately carries a skillshark.json (repo content), the
  // comparison must include the one we wrote
  const exclude = manifest.files.some((f) => f.path === MANIFEST_NAME) ? [] : undefined;
  return hashTree(target, exclude ? { exclude } : undefined);
}

// --- target resolution (§4.2 step 6) ------------------------------------------

async function resolveTarget(manifest, opts, deps) {
  if (opts.dir) {
    return { target: path.resolve(deps.cwd, opts.dir), targetIsFile: false, scope: 'dir' };
  }
  if (manifest.type !== 'skill' && manifest.type !== 'command') {
    throw new CliError(
      `This package is a ${manifest.type} with no agent convention — choose a destination with --dir <path>.`,
      2,
    );
  }
  if (manifest.type === 'command' && manifest.files.length !== 1) {
    throw new CliError('Malformed command package: expected exactly one file.', 1);
  }

  const interactive = deps.isTTY && !opts.yes;
  const detectable = existsSync(path.join(deps.cwd, '.claude')) || existsSync(path.join(deps.cwd, '.git'));
  let root;
  let scope;
  if (opts.project) {
    root = deps.cwd;
    scope = 'project';
  } else if (opts.global) {
    root = deps.home;
    scope = 'global';
  } else if (interactive) {
    const sub = manifest.type === 'skill' ? `.claude/skills/${manifest.name}` : `.claude/commands/${manifest.name}.md`;
    const choice = await deps.prompts.select({
      message: 'Install to:',
      options: [
        { value: 'project', label: `${sub}`, hint: 'this project' },
        { value: 'global', label: `~/${sub}`, hint: 'all projects' },
        { value: 'cancel', label: 'cancel' },
      ],
    });
    if (choice === null || choice === 'cancel') return { cancelled: true };
    root = choice === 'global' ? deps.home : deps.cwd;
    scope = choice;
  } else if (detectable) {
    root = deps.cwd;
    scope = 'project';
  } else {
    throw new CliError(
      "Can't tell if this is a project (no .claude/ or .git here). Re-run with --project, --global, or --dir <path>.",
      2,
    );
  }
  const target =
    manifest.type === 'skill'
      ? path.join(root, '.claude', 'skills', manifest.name)
      : path.join(root, '.claude', 'commands', `${manifest.name}.md`);
  return { target, targetIsFile: manifest.type === 'command', scope };
}

// --- atomic write (§4.2 step 9) ------------------------------------------------

async function atomicWrite({ workDir, manifest, target, targetIsFile, allowExec, beforeRename }) {
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const stage = path.join(parent, `.skillshark-stage-${token}`);
  let written = 0;
  try {
    if (targetIsFile) {
      const f = manifest.files[0];
      const data = await readFile(path.join(workDir, ...f.path.split('/')));
      await writeFile(stage, data, { mode: allowExec && f.executable ? 0o755 : 0o644 });
      written = 1;
    } else {
      await mkdir(stage);
      for (const f of manifest.files) {
        const src = path.join(workDir, ...f.path.split('/'));
        const dest = path.join(stage, ...f.path.split('/'));
        await mkdir(path.dirname(dest), { recursive: true });
        const data = await readFile(src);
        await writeFile(dest, data, { mode: allowExec && f.executable ? 0o755 : 0o644 });
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
  const interactive = deps.isTTY && !opts.yes;
  const ui = deps.ui;
  const verified = await fetchAndVerify(sourceStr, deps);
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
    if (!opts.json && !opts.quiet) {
      renderPreview(ui, { manifest, fingerprint, fpFromLink: verified.fpVerified, externalRefs });
      ui.out('');
    }

    // step 6 — agent target + scope
    const resolved = await resolveTarget(manifest, opts, deps);
    if (resolved.cancelled) {
      ui.out('  Cancelled. Nothing was installed.');
      return { status: 'cancelled' };
    }
    let { target, targetIsFile } = resolved;

    // step 7 — conflict
    let conflictResolved = false;
    while (!conflictResolved) {
      const exists = existsSync(target);
      if (!exists) break;
      const existingFiles = await existingTreeFor(target, targetIsFile, manifest);
      if (existingFiles.length === 0) break; // empty dir → nothing to conflict with
      const existingFp = treeFingerprint(existingFiles);
      if (existingFp === fingerprint) {
        const msg = `ⓘ "${manifest.name}" is already installed at ${displayPath(target, deps)} and is identical (${formatFp8(fingerprint)}). Nothing to do.`;
        if (opts.json) ui.out(JSON.stringify({ status: 'identical', name: manifest.name, installedPath: target }));
        else ui.out(`  ${msg}`);
        return { status: 'identical', target };
      }
      const diff = diffTrees(existingFiles, manifest.files);
      if (!interactive) {
        if (opts.force) break;
        throw new CliError(
          `"${manifest.name}" already exists at ${displayPath(target, deps)} and differs ` +
            `(+${diff.added.length} ~${diff.changed.length} -${diff.removed.length}). Re-run with --force to overwrite.`,
          1,
        );
      }
      ui.warn(`"${manifest.name}" already exists at ${displayPath(target, deps)} and differs:`);
      for (const p of diff.changed) ui.out(`      ~ ${p}   (changed)`);
      for (const p of diff.added) ui.out(`      + ${p}   (added)`);
      for (const p of diff.removed) ui.out(`      - ${p}   (removed)`);
      const action = await deps.prompts.select({
        message: 'What now?',
        options: [
          { value: 'overwrite', label: `Overwrite ${displayPath(target, deps)}` },
          { value: 'side', label: `Install side-by-side as "${manifest.name}-2"` },
          { value: 'diff', label: 'Show diff' },
          { value: 'cancel', label: 'Cancel' },
        ],
      });
      if (action === null || action === 'cancel') {
        ui.out('  Cancelled. Nothing was installed.');
        return { status: 'cancelled' };
      }
      if (action === 'overwrite') break;
      if (action === 'side') {
        let n = 2;
        let cand;
        do {
          cand = targetIsFile
            ? target.replace(/\.md$/, `-${n}.md`)
            : `${target.replace(/-\d+$/, '')}-${n}`;
          n += 1;
        } while (existsSync(cand) && n < 100);
        target = cand;
        continue;
      }
      if (action === 'diff') {
        ui.out('');
        for (const p of diff.changed) ui.out(`      ~ ${p}   (changed)`);
        for (const p of diff.added) ui.out(`      + ${p}   (added)`);
        for (const p of diff.removed) ui.out(`      - ${p}   (removed)`);
        ui.out('');
        continue; // re-ask
      }
    }

    // step 8 — confirm
    if (interactive) {
      const go = await deps.prompts.confirm({
        message: `Install to ${displayPath(target, deps)}?`,
      });
      if (go !== true) {
        ui.out('  Cancelled. Nothing was installed.');
        return { status: 'cancelled' };
      }
    } else if (!opts.json && !opts.quiet) {
      ui.out(`  Installing to ${displayPath(target, deps)}`);
    }

    // step 9 — atomic write (exec bits stripped unless --allow-exec)
    const filesWritten = await atomicWrite({
      workDir,
      manifest,
      target,
      targetIsFile,
      allowExec: Boolean(opts.allowExec),
      beforeRename: deps.beforeRename,
    });

    // step 10 — record
    await addInstallRecord(deps.configDir, {
      name: manifest.name,
      agent: manifest.agent || null,
      path: target,
      fingerprint,
      installedAt: new Date().toISOString(),
      source: sourceRecord,
    });

    // step 11 — report
    if (opts.json) {
      ui.out(JSON.stringify({
        name: manifest.name,
        type: manifest.type,
        agent: manifest.agent || null,
        installedPath: target,
        filesWritten,
        fingerprint,
        source: sourceRecord,
      }));
    } else if (opts.quiet) {
      ui.out(target);
    } else {
      ui.ok('Verified checksums');
      ui.ok(`Installed to ${displayPath(target, deps)}`);
      if (manifest.agent === 'claude-code') {
        ui.out(`  Available in Claude Code as the "${manifest.name}" ${manifest.type} — restart the session to pick it up.`);
      } else {
        ui.out('  Restart the session to pick it up.');
      }
    }
    return { status: 'installed', target, filesWritten, fingerprint };
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

export async function runInspect(sourceStr, opts, deps) {
  const ui = deps.ui;
  const verified = await fetchAndVerify(sourceStr, deps);
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
