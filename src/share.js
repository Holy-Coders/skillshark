// `skillshark share <path|name>` (§4.1) and `skillshark revoke <id|name>` (§4.4).
// Sender operations are the only ones that use gh; they never run package content.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CliError } from './errors.js';
import { resolveShareArg, collectFiles, inferMetadata, findExternalRefs } from './discover.js';
import { buildTarball } from './pkg.js';
import { treeFingerprint, fp8 } from './fingerprint.js';
import { createGist, deleteGist, gistDescription, GIST_PAYLOAD_LIMIT } from './transports/gist.js';
import { addShareRecord, findShareRecord, removeShareRecord } from './config.js';
import { humanSize, displayPath, plural } from './ui.js';
import { VERSION } from './version.js';

const EXPIRES = {
  '30m': 30 * 60 * 1000,
  '6h': 6 * 3600 * 1000,
  '24h': 24 * 3600 * 1000,
  '7d': 7 * 86400000,
  '30d': 30 * 86400000,
};
const EXPIRES_LABEL = {
  '30m': '30 minutes',
  '6h': '6 hours',
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
};

export function parseExpires(value) {
  const v = value ?? '7d';
  if (!Object.hasOwn(EXPIRES, v)) {
    throw new CliError(`--expires must be one of: 30m, 6h, 24h, 7d, 30d (got "${value}").`, 2);
  }
  return { ms: EXPIRES[v], label: EXPIRES_LABEL[v], key: v };
}

// Assemble everything `share` needs before any upload happens. Also used by
// --dry-run. Returns { files, warnings, manifest, manifestJson, tarball, fp }.
export async function buildSharePackage(arg, opts, deps) {
  const { matches } = await resolveShareArg(arg, deps);
  let match;
  if (matches.length === 1) {
    [match] = matches;
  } else if (deps.isTTY && deps.prompts) {
    const value = await deps.prompts.select({
      message: `"${arg}" matches more than one artifact:`,
      options: matches.map((m, i) => ({ value: i, label: `${m.type} at ${displayPath(m.root, deps)}`, hint: m.where })),
    });
    if (value === null) throw new CliError('Cancelled.', 0);
    match = matches[value];
  } else {
    throw new CliError(
      `"${arg}" is ambiguous here:\n${matches.map((m) => `  ${m.type}  ${displayPath(m.root, deps)}`).join('\n')}\nPass the path you mean.`,
      2,
    );
  }

  const { files, warnings } = await collectFiles(match.root, { isDir: match.isDir, force: opts.force });
  if (files.length === 0) {
    throw new CliError(
      'Nothing to package: every file was excluded (or the directory is empty). Use --force to include secret-shaped files you really mean to share.',
      2,
    );
  }
  const meta = await inferMetadata({
    root: match.root,
    isDir: match.isDir,
    type: match.type,
    agent: match.agent,
    files,
  });
  const name = opts.name || meta.name;
  const expires = parseExpires(opts.expires);
  const now = Date.now();
  const fingerprint = treeFingerprint(files);
  const manifest = {
    skillshark: '2',
    name,
    type: match.type,
    agent: match.agent,
    description: meta.description,
    files: files.map(({ path: p, size, sha256, mode, executable }) => ({ path: p, size, sha256, mode, executable })),
    totalSize: files.reduce((n, f) => n + f.size, 0),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + expires.ms).toISOString(),
    tool: { name: 'skillshark', version: VERSION },
    dependencies: meta.dependencies,
    fingerprint,
  };
  const externalRefs = await findExternalRefs(files);
  const { tarball, manifestJson } = await buildTarball(
    files.map((f) => ({ path: f.path, abs: f.abs, executable: f.executable })),
    manifest,
  );
  return { match, files, warnings, manifest, manifestJson, tarball, fingerprint, expires, externalRefs, meta };
}

export async function runShare(arg, opts, deps) {
  const ui = deps.ui;
  const built = await buildSharePackage(arg, opts, deps);
  const { match, files, warnings, manifest, manifestJson, tarball, fingerprint, expires, externalRefs } = built;
  const shortFp = fp8(fingerprint);
  const loud = !opts.quiet && !opts.json;

  if (loud) {
    const kind = manifest.agent ? `${manifest.type} "${manifest.name}" (${manifest.agent})` : `${manifest.type} "${manifest.name}"`;
    ui.out(`  Found ${kind} at ${displayPath(match.root, deps)} — ${plural(files.length, 'file')}, ${humanSize(manifest.totalSize)}`);
    for (const w of warnings) {
      if (w.forceable) ui.warn(`Skipped ${w.path} (${w.reason}) — pass --force to include`);
      else ui.warn(`Skipped ${w.path} (${w.reason})`);
    }
    for (const ref of externalRefs) {
      ui.warn(`References ${ref} outside the package — it may not work standalone`);
    }
  }

  const b64 = tarball.toString('base64');
  if (b64.length > GIST_PAYLOAD_LIMIT) {
    throw new CliError(
      `That's ${humanSize(b64.length)} (gist limit ~5 MB). Put it in a repo and share gh:owner/repo/path instead.`,
      2,
    );
  }

  if (opts.dryRun) {
    if (opts.json) {
      ui.out(JSON.stringify({
        dryRun: true,
        name: manifest.name,
        type: manifest.type,
        agent: manifest.agent,
        fingerprint,
        size: manifest.totalSize,
        encodedSize: b64.length,
        files: manifest.files,
      }, null, 2));
    } else {
      ui.out('');
      for (const f of manifest.files) {
        ui.out(`    ${f.path.padEnd(Math.max(...manifest.files.map((x) => x.path.length)) + 3)}${humanSize(f.size)}${f.executable ? '   (executable)' : ''}`);
      }
      ui.out('');
      ui.out(`  Fingerprint ${shortFp} · ${humanSize(b64.length)} encoded · nothing uploaded (--dry-run)`);
    }
    return { status: 'dry-run', fingerprint };
  }

  let primaryDoc = null;
  if (built.meta.primaryDoc) {
    const abs = match.isDir ? path.join(match.root, ...built.meta.primaryDoc.split('/')) : match.root;
    try {
      primaryDoc = { name: built.meta.primaryDoc, content: await readFile(abs, 'utf8') };
    } catch { /* preview is optional */ }
  }

  const { id, revision } = await ui.spin('Uploading as a secret gist', () =>
    createGist({
      manifestJson,
      primaryDoc,
      tarballB64: b64,
      description: gistDescription({ name: manifest.name, agent: manifest.agent, type: manifest.type, fp8: shortFp }),
      ghApi: deps.ghApi,
    }));
  const url = `https://gist.github.com/${id}#fp=${shortFp}`;

  await addShareRecord(deps.configDir, {
    id,
    name: manifest.name,
    url,
    revision,
    expiresAt: manifest.expiresAt,
  });

  let copied = false;
  if (!opts.noClipboard && deps.clipboard) {
    copied = await deps.clipboard(url);
  }

  if (opts.json) {
    ui.out(JSON.stringify({
      id,
      url,
      revision,
      expiresAt: manifest.expiresAt,
      fingerprint,
      size: manifest.totalSize,
      files: manifest.files.map((f) => f.path),
    }));
  } else if (opts.quiet) {
    ui.out(url);
  } else {
    ui.out('');
    ui.ok('Uploaded as a secret gist (unlisted — anyone with the link can read it)');
    if (copied) ui.ok(`Link copied to clipboard · advisory expiry in ${expires.label}`);
    else ui.out(`  Advisory expiry in ${expires.label}`);
    ui.out('');
    ui.out(`  ${url}`);
    ui.out('');
    ui.out('  They run:   skillshark install <the link>     (no GitHub account needed)');
    ui.out(`  Undo:       skillshark revoke ${manifest.name}               (deletes the gist)`);
  }
  return { status: 'shared', id, url, fingerprint };
}

// --- revoke (§4.4) -----------------------------------------------------------

export async function runRevoke(idOrName, opts, deps) {
  const ui = deps.ui;
  let id = null;
  let label = idOrName;
  if (/^[0-9a-f]{20,32}$/.test(idOrName)) {
    id = idOrName;
  } else {
    const rec = await findShareRecord(deps.configDir, idOrName);
    if (rec) {
      id = rec.id;
      label = `${rec.name} (${rec.id})`;
    } else {
      // cache miss → ask gh for our skillshark gists
      const out = await deps.ghApi(['gists', '--paginate']);
      let gists;
      try {
        gists = JSON.parse(out);
      } catch {
        throw new CliError('Unexpected response from gh while listing gists.', 1);
      }
      const mine = gists.filter((g) => (g.description ?? '').startsWith(`skillshark: ${idOrName} (`));
      if (mine.length === 0) {
        throw new CliError(`No share named "${idOrName}" found (locally or in your gists).`, 2);
      }
      mine.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      id = mine[0].id;
      label = `${idOrName} (${id})`;
      if (mine.length > 1) ui.warn(`${mine.length} shares named "${idOrName}" exist; revoking the newest. Re-run with the gist id for the others.`);
    }
  }

  if (deps.isTTY && !opts.yes) {
    const go = await deps.prompts.confirm({ message: `Delete the gist for ${label}? Anyone holding the link loses access.` });
    if (go !== true) {
      ui.out('  Cancelled.');
      return { status: 'cancelled' };
    }
  }
  await deleteGist(id, { ghApi: deps.ghApi });
  await removeShareRecord(deps.configDir, id);
  if (opts.json) ui.out(JSON.stringify({ revoked: id }));
  else ui.ok(`Revoked — the gist ${id} is gone. Anyone holding the link now gets "deleted by the sender".`);
  return { status: 'revoked', id };
}
