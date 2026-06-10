// Gist transport. Share/revoke go through `gh` (the sender's auth); the
// receive path is ANONYMOUS https only — it must never invoke gh (§0.3).
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CliError, MSG } from '../errors.js';
import { USER_AGENT } from '../version.js';

export const GIST_PAYLOAD_LIMIT = 5 * 1024 * 1024; // encoded bytes (§4.1)
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

// One `gh api gists --method POST --input <tmp.json>` call; a JSON body file
// avoids every shell-escaping pitfall (hard rule 3).
export async function createGist({ manifestJson, primaryDoc, tarballB64, description, ghApi }) {
  const files = { 'SKILLSHARK.json': { content: manifestJson } };
  if (primaryDoc && primaryDoc.content.trim()) {
    files[path.basename(primaryDoc.name)] = { content: primaryDoc.content };
  }
  files['package.tgz.b64'] = { content: tarballB64 };
  const body = { public: false, description, files };

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'skillshark-share-'));
  const bodyFile = path.join(tmpDir, 'gist-body.json');
  try {
    await writeFile(bodyFile, JSON.stringify(body));
    const stdout = await ghApi(['gists', '--method', 'POST', '--input', bodyFile]);
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new CliError('Unexpected response from gh while creating the gist.', 1);
    }
    if (!parsed.id) throw new CliError('gh created no gist (no id in response).', 1);
    return { id: parsed.id, revision: parsed.history?.[0]?.version ?? null };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export async function deleteGist(id, { ghApi }) {
  await ghApi(['--method', 'DELETE', `gists/${id}`]);
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

export async function fetchGistPackage(id, { fetch }) {
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
  const data = await res.json();

  const pkgFile = data.files?.['package.tgz.b64'];
  if (!pkgFile) {
    throw new CliError('No package at that link (the gist has no package.tgz.b64 — not a SkillShark share).', 1);
  }
  let b64;
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
  const tarball = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
  if (tarball.length < 2 || tarball[0] !== 0x1f || tarball[1] !== 0x8b) {
    throw new CliError(MSG.downloadIntegrity, 1);
  }
  return {
    tarball,
    owner: data.owner?.login ?? null,
    revision: data.history?.[0]?.version ?? null,
    description: data.description ?? '',
  };
}
