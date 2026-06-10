// `skillshark share <path|name>` (§4.1) and `skillshark revoke <id|name>` (§4.4).
// Sender operations are the only ones that use gh; they never run package content.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CliError } from './errors.js';
import { resolveHost, DEFAULT_HOST } from './source.js';
import { resolveShareArg, collectFiles, inferMetadata, findExternalRefs } from './discover.js';
import { buildTarball } from './pkg.js';
import { treeFingerprint, fp8 } from './fingerprint.js';
import { generateLinkSecret, encodeSecret, encryptTarball } from './crypt.js';
import { VERSION as TOOL_VERSION } from './version.js';
import { createGist, deleteGist, gistDescription, GIST_PAYLOAD_LIMIT } from './transports/gist.js';
import { addShareRecord, findShareRecord, removeShareRecord, loadConfig } from './config.js';
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

  // privacy by default: seal the tarball; GitHub stores only ciphertext and
  // the one key rides in the link fragment (--no-encrypt opts out for the
  // browser-preview behavior)
  const encrypted = !opts.noEncrypt;
  const linkSecret = encrypted ? generateLinkSecret() : null;
  const payload = encrypted ? encryptTarball(tarball, linkSecret) : tarball;
  const b64 = payload.toString('base64');
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
  if (!encrypted && built.meta.primaryDoc) {
    const abs = match.isDir ? path.join(match.root, ...built.meta.primaryDoc.split('/')) : match.root;
    try {
      primaryDoc = { name: built.meta.primaryDoc, content: await readFile(abs, 'utf8') };
    } catch { /* preview is optional */ }
  }

  // encrypted shares publish a metadata-free stub: no name, no description,
  // no file list — only what's needed to recognize and house-keep the share
  const publicManifestJson = encrypted
    ? JSON.stringify({
        skillshark: '3',
        encrypted: true,
        fp8: shortFp,
        createdAt: manifest.createdAt,
        expiresAt: manifest.expiresAt,
        tool: { name: 'skillshark', version: TOOL_VERSION },
      }, null, 2) + '\n'
    : manifestJson;
  const description = encrypted
    ? `skillshark: encrypted (fp ${shortFp})`
    : gistDescription({ name: manifest.name, agent: manifest.agent, type: manifest.type, fp8: shortFp });

  const host = resolveHost(opts, deps);
  const { id, revision, htmlUrl } = await ui.spin('Uploading as a secret gist', () =>
    createGist({
      manifestJson: publicManifestJson,
      primaryDoc,
      tarballB64: b64,
      description,
      ghApi: deps.ghApi,
      host,
      encrypted,
    }));
  // github.com gets the short canonical form; enterprise hosts keep the
  // html_url GitHub handed back (subdomain isolation varies per install)
  const base = host === DEFAULT_HOST ? `https://gist.github.com/${id}` : (htmlUrl ?? `https://${host}/gist/${id}`);
  const fragment = encrypted ? `#k=${encodeSecret(linkSecret)}&fp=${shortFp}` : `#fp=${shortFp}`;
  const url = `${base}${fragment}`;
  // the paste-and-go line: receivers run this with zero setup
  const installCommand = `npx skillshark install '${url}'`;

  // the full link — key fragment included — is kept locally so the sender
  // can always pull it back up with `skillshark shares <name>`
  await addShareRecord(deps.configDir, {
    id,
    name: manifest.name,
    url,
    encrypted,
    fingerprint,
    revision,
    createdAt: manifest.createdAt,
    expiresAt: manifest.expiresAt,
    ...(host !== DEFAULT_HOST ? { host } : {}),
  });

  let copied = false;
  if (!opts.noClipboard && deps.clipboard) {
    copied = await deps.clipboard(installCommand);
  }

  if (opts.json) {
    ui.out(JSON.stringify({
      id,
      url,
      installCommand,
      encrypted,
      revision,
      expiresAt: manifest.expiresAt,
      fingerprint,
      size: manifest.totalSize,
      files: manifest.files.map((f) => f.path),
      ...(host !== DEFAULT_HOST ? { host } : {}),
    }));
  } else if (opts.quiet) {
    ui.out(url);
  } else {
    ui.out('');
    if (encrypted) {
      ui.ok('Encrypted (AES-256-GCM) and uploaded as a secret gist — GitHub stores only ciphertext');
      ui.out('    The only key rides in your link below. Lose the link, lose the share.');
    } else {
      ui.ok('Uploaded as a secret gist (unlisted and UNENCRYPTED — anyone with the link can read it)');
    }
    if (copied) ui.ok(`Install one-liner copied to clipboard — they just paste it · advisory expiry in ${expires.label}`);
    else ui.out(`  Advisory expiry in ${expires.label}`);
    ui.out('');
    ui.out(`  ${installCommand}`);
    ui.out('');
    const who = host === DEFAULT_HOST ? '(no GitHub account needed)' : `(needs gh auth on ${host})`;
    ui.out(`  Link only:  ${url}   ${who}`);
    ui.out(`  Undo:       skillshark revoke ${manifest.name}   (deletes the gist)`);
  }
  return { status: 'shared', id, url, installCommand, fingerprint, encrypted };
}

// --- shares: recall the links you created --------------------------------------

function shareState(rec, now = Date.now()) {
  if (!rec.expiresAt) return 'no expiry';
  const exp = Date.parse(rec.expiresAt);
  if (Number.isNaN(exp)) return 'no expiry';
  if (exp < now) return 'expired';
  const days = Math.floor((exp - now) / 86400000);
  return days >= 1 ? `expires in ${days}d` : `expires in ${Math.max(1, Math.floor((exp - now) / 3600000))}h`;
}

// `skillshark shares` — list everything you've shared (newest first).
// `skillshark shares <name|id>` — print that share's full link and put the
// paste-and-go one-liner back on the clipboard, exactly like share did.
export async function runShares(arg, opts, deps) {
  const ui = deps.ui;
  const cfg = await loadConfig(deps.configDir);
  const shares = cfg.shares;

  if (!arg) {
    if (opts.json) {
      ui.out(JSON.stringify(shares, null, 2));
      return { status: 'listed', count: shares.length };
    }
    if (shares.length === 0) {
      ui.out('  No shares recorded on this machine. Make one:  skillshark share <name>');
      return { status: 'listed', count: 0 };
    }
    if (opts.quiet) {
      for (const s of shares) ui.out(s.url);
      return { status: 'listed', count: shares.length };
    }
    const width = Math.max(...shares.map((s) => s.name.length)) + 2;
    for (const s of shares) {
      const bits = [
        s.encrypted === false ? 'plain' : '🔐',
        shareState(s),
        s.host ? s.host : null,
        (s.createdAt ?? '').slice(0, 10) || null,
      ].filter(Boolean);
      ui.out(`  ${s.name.padEnd(width)}${bits.join(' · ')}`);
    }
    ui.out('');
    ui.out('  Get a link back:   skillshark shares <name>     (copies the install one-liner)');
    ui.out('  Kill a link:       skillshark revoke <name>');
    return { status: 'listed', count: shares.length };
  }

  const rec = shares.find((s) => s.id === arg) ?? shares.find((s) => s.name === arg);
  if (!rec) {
    const names = [...new Set(shares.map((s) => s.name))];
    throw new CliError(
      `No share named "${arg}" on this machine.${names.length ? `\nKnown: ${names.slice(0, 10).join(', ')}` : ' (Shares made elsewhere can\'t be recovered here — the key never leaves the machine that made it.)'}`,
      2,
    );
  }
  const installCommand = `npx skillshark install '${rec.url}'`;
  if (opts.json) {
    ui.out(JSON.stringify({ ...rec, installCommand }, null, 2));
    return { status: 'shown', id: rec.id };
  }
  if (opts.quiet) {
    ui.out(rec.url);
    return { status: 'shown', id: rec.id };
  }
  let copied = false;
  if (!opts.noClipboard && deps.clipboard) copied = await deps.clipboard(installCommand);
  const state = shareState(rec);
  ui.out(`  ${rec.name} · ${rec.encrypted === false ? 'plain' : 'encrypted'} · ${state}${rec.host ? ` · ${rec.host}` : ''}`);
  if (copied) ui.ok('Install one-liner copied to clipboard — paste it anywhere');
  ui.out('');
  ui.out(`  ${installCommand}`);
  ui.out('');
  if (state === 'expired') {
    ui.warn(`Past its advisory expiry — installs will refuse it. Re-share with:  skillshark share ${rec.name}`);
  }
  ui.out(`  Undo:  skillshark revoke ${rec.name}`);
  return { status: 'shown', id: rec.id, url: rec.url, installCommand };
}

// --- prune: delete your own advisory-expired shares ----------------------------

// Resolve a candidate gist's advisory expiry: prefer the local cache (no
// network), else read expiresAt out of the SKILLSHARK.json stub.
async function resolveExpiry(gist, cacheById, host, deps) {
  const rec = cacheById.get(gist.id);
  if (rec && rec.expiresAt !== undefined) return rec.expiresAt;
  let full;
  try {
    full = JSON.parse(await deps.ghApi([...(host !== DEFAULT_HOST ? ['--hostname', host] : []), `gists/${gist.id}`]));
  } catch {
    return null; // unreadable → leave it alone
  }
  const stub = full.files?.['SKILLSHARK.json']?.content;
  if (!stub) return null;
  try {
    return JSON.parse(stub).expiresAt ?? null;
  } catch {
    return null;
  }
}

// `skillshark prune` — list your skillshark gists, keep only those past their
// advisory expiry, confirm, delete. Advisory expiry the installer already
// refuses; prune is the real cleanup the sender controls.
export async function runPrune(opts, deps) {
  const ui = deps.ui;
  const host = resolveHost(opts, deps);
  const cfg = await loadConfig(deps.configDir);
  const cacheById = new Map(cfg.shares.map((s) => [s.id, s]));

  const out = await ui.spin('Listing your shares', () =>
    deps.ghApi([...(host !== DEFAULT_HOST ? ['--hostname', host] : []), 'gists', '--paginate']));
  let gists;
  try {
    gists = JSON.parse(out);
  } catch {
    throw new CliError('Unexpected response from gh while listing gists.', 1);
  }
  const candidates = gists.filter((g) => String(g.description ?? '').startsWith('skillshark:'));
  const now = Date.now();
  const expired = [];
  for (const g of candidates) {
    const expiresAt = await resolveExpiry(g, cacheById, host, deps);
    if (!expiresAt) continue;
    const t = Date.parse(expiresAt);
    if (!Number.isNaN(t) && t < now) {
      const rec = cacheById.get(g.id);
      expired.push({ id: g.id, expiresAt, name: rec?.name ?? null, description: g.description });
    }
  }

  if (opts.json) {
    ui.out(JSON.stringify({ scanned: candidates.length, expired: expired.map((e) => ({ id: e.id, name: e.name, expiresAt: e.expiresAt })) }, null, 2));
  }
  if (expired.length === 0) {
    if (!opts.json) ui.out(`  Nothing to prune — none of your ${plural(candidates.length, 'share')} are past their advisory expiry.`);
    return { status: 'pruned', deleted: 0, scanned: candidates.length };
  }

  if (!opts.json) {
    ui.out(`  ${plural(expired.length, 'share')} past advisory expiry:`);
    for (const e of expired) {
      const days = Math.max(1, Math.floor((now - Date.parse(e.expiresAt)) / 86400000));
      ui.out(`    ${e.name ? e.name : e.id.slice(0, 12)}   expired ${plural(days, 'day')} ago`);
    }
    ui.out('');
  }
  if (deps.isTTY && !opts.yes) {
    const go = await deps.prompts.confirm({ message: `Delete ${plural(expired.length, 'expired gist')}? This is permanent.` });
    if (go !== true) {
      ui.out('  Cancelled. Nothing was deleted.');
      return { status: 'cancelled' };
    }
  }
  let deleted = 0;
  for (const e of expired) {
    await deleteGist(e.id, { ghApi: deps.ghApi, host });
    await removeShareRecord(deps.configDir, e.id);
    deleted += 1;
  }
  if (opts.json) ui.out(JSON.stringify({ deleted }));
  else ui.ok(`Pruned ${plural(deleted, 'expired share')}.`);
  return { status: 'pruned', deleted, scanned: candidates.length };
}

// --- revoke (§4.4) -----------------------------------------------------------

export async function runRevoke(idOrName, opts, deps) {
  const ui = deps.ui;
  let id = null;
  let label = idOrName;
  let host = resolveHost(opts, deps);
  if (/^[0-9a-f]{20,32}$/.test(idOrName)) {
    id = idOrName;
  } else {
    const rec = await findShareRecord(deps.configDir, idOrName);
    if (rec) {
      id = rec.id;
      label = `${rec.name} (${rec.id})`;
      if (rec.host) host = rec.host; // enterprise share → revoke on its host
    } else {
      // cache miss → ask gh for our skillshark gists (on the chosen host)
      const out = await deps.ghApi([
        ...(host !== DEFAULT_HOST ? ['--hostname', host] : []),
        'gists',
        '--paginate',
      ]);
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
  await deleteGist(id, { ghApi: deps.ghApi, host });
  await removeShareRecord(deps.configDir, id);
  if (opts.json) ui.out(JSON.stringify({ revoked: id }));
  else ui.ok(`Revoked — the gist ${id} is gone. Anyone holding the link now gets "deleted by the sender".`);
  return { status: 'revoked', id };
}
