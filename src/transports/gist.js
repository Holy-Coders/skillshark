// Gist transport. Share/revoke go through `gh` (the sender's auth); the
// public github.com receive path is ANONYMOUS https only — it must never
// invoke gh (§0.3). GitHub Enterprise links are the deliberate exception:
// privacy means everything rides the receiver's own gh auth and no anonymous
// request ever leaves for the enterprise host.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CliError, MSG } from '../errors.js';
import { USER_AGENT } from '../version.js';
import { DEFAULT_HOST } from '../source.js';

export const GIST_PAYLOAD_LIMIT = 5 * 1024 * 1024; // encoded bytes (§4.1)
// the gists API truncates inline file content at ~1 MB; on enterprise hosts we
// can't fall back to an anonymous raw_url fetch, so shares are capped honestly
export const ENTERPRISE_INLINE_LIMIT = 900 * 1024;
const FETCH_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': USER_AGENT,
  'X-GitHub-Api-Version': '2022-11-28',
  // anonymous API responses are CDN-cached; a revoked gist must die promptly
  'Cache-Control': 'no-cache',
};

// --- sender side (gh) -------------------------------------------------------

export function gistDescription({ name, agent, type, fp8 }) {
  const kind = agent ? `${agent} ${type}` : type;
  return `skillshark: ${name} (${kind}) · fp ${fp8}`;
}

function hostFlags(host) {
  return host && host !== DEFAULT_HOST ? ['--hostname', host] : [];
}

// One `gh api gists --method POST --input <tmp.json>` call; a JSON body file
// avoids every shell-escaping pitfall (hard rule 3).
// Encrypted shares (the default) upload ONLY a metadata-free stub + the
// sealed envelope: no name, no description, no file list, no SKILL.md
// preview — GitHub stores nothing readable.
export async function createGist({ manifestJson, primaryDoc, tarballB64, description, ghApi, host = DEFAULT_HOST, encrypted = false }) {
  if (host !== DEFAULT_HOST && tarballB64.length > ENTERPRISE_INLINE_LIMIT) {
    throw new CliError(
      `That's too big for an enterprise gist share (~${Math.floor(ENTERPRISE_INLINE_LIMIT / 1024)} KB encoded cap — the API truncates larger files and enterprise receivers can't fetch around it anonymously). Put it in a repo on ${host} instead.`,
      2,
    );
  }
  const files = { 'SKILLSHARK.json': { content: manifestJson } };
  if (!encrypted && primaryDoc && primaryDoc.content.trim()) {
    files[path.basename(primaryDoc.name)] = { content: primaryDoc.content };
  }
  files[encrypted ? 'package.tgz.enc.b64' : 'package.tgz.b64'] = { content: tarballB64 };
  const body = { public: false, description, files };

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'skillshark-share-'));
  const bodyFile = path.join(tmpDir, 'gist-body.json');
  try {
    await writeFile(bodyFile, JSON.stringify(body));
    const stdout = await ghApi([...hostFlags(host), 'gists', '--method', 'POST', '--input', bodyFile]);
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new CliError('Unexpected response from gh while creating the gist.', 1);
    }
    if (!parsed.id) throw new CliError('gh created no gist (no id in response).', 1);
    return { id: parsed.id, revision: parsed.history?.[0]?.version ?? null, htmlUrl: parsed.html_url ?? null };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export async function deleteGist(id, { ghApi, host = DEFAULT_HOST }) {
  await ghApi([...hostFlags(host), '--method', 'DELETE', `gists/${id}`]);
}

// --- receive side (anonymous fetch, no gh — ever) ---------------------------

async function readBodyCapped(res, cap, what) {
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > cap) {
      throw new CliError(`${what} exceeds the ${Math.floor(cap / (1024 * 1024))} MB limit. Refusing to continue.`, 1);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export async function fetchGistPackage(id, { fetch, host = DEFAULT_HOST, ghApi = null }) {
  let data;
  if (host !== DEFAULT_HOST) {
    // GitHub Enterprise: private by nature. Everything goes through the
    // receiver's own gh auth; no anonymous request touches the host.
    if (!ghApi) throw new CliError(`Can't reach ${host} without gh.`, 2);
    let stdout;
    try {
      stdout = await ghApi(['--hostname', host, `gists/${id}`]);
    } catch (err) {
      if (err instanceof CliError && /404/.test(err.message)) throw new CliError(MSG.gistDeleted, 1);
      throw err;
    }
    try {
      data = JSON.parse(stdout);
    } catch {
      throw new CliError(`Unexpected response from ${host} while fetching the gist.`, 1);
    }
  } else {
    let res;
    try {
      res = await fetch(`https://api.github.com/gists/${id}`, { headers: FETCH_HEADERS });
    } catch (e) {
      throw new CliError(`Network error reaching GitHub: ${e.message}`, 1);
    }
    if (res.status === 404) throw new CliError(MSG.gistDeleted, 1);
    if (res.status === 403 || res.status === 429) {
      throw new CliError('GitHub rate limit hit (anonymous reads are 60/hour per IP). Try again in a bit.', 1);
    }
    if (!res.ok) throw new CliError(`GitHub API error fetching the gist (HTTP ${res.status}).`, 1);
    data = await res.json();
  }

  const encFile = data.files?.['package.tgz.enc.b64'];
  const pkgFile = encFile ?? data.files?.['package.tgz.b64'];
  if (!pkgFile) {
    throw new CliError('No package at that link (the gist carries no SkillShark payload).', 1);
  }
  let b64;
  if (pkgFile.truncated && host !== DEFAULT_HOST) {
    throw new CliError(
      `This enterprise share is too large to fetch inline (the ${host} API truncates files past ~1 MB). Ask the sender to share it as a repo path on ${host} instead.`,
      1,
    );
  }
  if (pkgFile.truncated) {
    let raw;
    try {
      raw = await fetch(pkgFile.raw_url, { headers: { 'User-Agent': USER_AGENT } });
    } catch (e) {
      throw new CliError(`Network error fetching the package: ${e.message}`, 1);
    }
    if (!raw.ok) throw new CliError(`Could not fetch the package payload (HTTP ${raw.status}).`, 1);
    b64 = (await readBodyCapped(raw, GIST_PAYLOAD_LIMIT + 1024 * 1024, 'The package payload')).toString('utf8');
  } else {
    b64 = pkgFile.content ?? '';
  }
  if (b64.length > GIST_PAYLOAD_LIMIT + 1024 * 1024) {
    throw new CliError('The package payload exceeds the gist size limit. Refusing to continue.', 1);
  }
  const bytes = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
  const encrypted = Boolean(encFile);
  if (encrypted) {
    if (bytes.length < 4 || bytes.subarray(0, 4).toString() !== 'SSE1') {
      throw new CliError(MSG.downloadIntegrity, 1);
    }
  } else if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new CliError(MSG.downloadIntegrity, 1);
  }
  return {
    encrypted,
    bytes,
    owner: data.owner?.login ?? null,
    revision: data.history?.[0]?.version ?? null,
    description: data.description ?? '',
  };
}
