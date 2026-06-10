// Repo transport (install-only in v0.1): gh:owner/repo[/path][@ref], fetched
// anonymously from api.github.com + codeload. The one integrity anchor is the
// commit SHA; #fp= does not apply here (§4.2).
import { CliError } from '../errors.js';
import { USER_AGENT } from '../version.js';
import { extractTarball } from '../pkg.js';

export const REPO_TARBALL_LIMIT = 50 * 1024 * 1024;
const FETCH_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': USER_AGENT,
  'X-GitHub-Api-Version': '2022-11-28',
};

async function getJson(fetch, url, what) {
  let res;
  try {
    res = await fetch(url, { headers: FETCH_HEADERS });
  } catch (e) {
    throw new CliError(`Network error reaching GitHub: ${e.message}`, 1);
  }
  if (res.status === 404) throw new CliError(`${what} not found (private repos aren't supported in v0.1).`, 1);
  if (res.status === 403 || res.status === 429) {
    throw new CliError('GitHub rate limit hit (anonymous reads are 60/hour per IP). Try again in a bit.', 1);
  }
  if (!res.ok) throw new CliError(`GitHub API error for ${what} (HTTP ${res.status}).`, 1);
  return res.json();
}

async function readBodyCapped(res, cap, what) {
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > cap) {
      throw new CliError(`${what} exceeds the ${Math.floor(cap / (1024 * 1024))} MB limit. Put less in, or install a deeper path.`, 1);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

// Map a codeload entry path onto the requested subtree:
// strip the "<repo>-<ref>/" prefix, then select under `subPath` (or everything).
// A file `subPath` maps to its basename. Returns null to skip the entry.
export function subtreeMapper(subPath) {
  const want = subPath ? subPath.split('/').filter(Boolean) : [];
  return (cleanedPath) => {
    const segs = cleanedPath.split('/').filter(Boolean);
    if (segs.length <= 1) return null; // the prefix dir itself
    const rest = segs.slice(1);
    if (want.length === 0) return rest.join('/');
    if (rest.length < want.length) return null;
    for (let i = 0; i < want.length; i++) {
      if (rest[i] !== want[i]) return null;
    }
    if (rest.length === want.length) return rest[rest.length - 1]; // subPath IS a file
    return rest.slice(want.length).join('/');
  };
}

// Resolve ref → commit SHA (pinned installs skip the API entirely), download
// the codeload tarball, and extract just the subtree through the §7.2 guards.
export async function fetchRepoTree({ owner, repo, path: subPath, ref }, destDir, { fetch }) {
  let sha;
  if (ref && /^[0-9a-f]{40}$/.test(ref)) {
    sha = ref;
  } else {
    let resolvedRef = ref;
    if (!resolvedRef) {
      const repoInfo = await getJson(fetch, `https://api.github.com/repos/${owner}/${repo}`, `Repository ${owner}/${repo}`);
      resolvedRef = repoInfo.default_branch;
      if (!resolvedRef) throw new CliError(`Repository ${owner}/${repo} has no default branch.`, 1);
    }
    const commit = await getJson(
      fetch,
      `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(resolvedRef)}`,
      `Ref "${resolvedRef}" in ${owner}/${repo}`,
    );
    sha = commit.sha;
    if (!sha) throw new CliError(`Could not resolve "${resolvedRef}" to a commit in ${owner}/${repo}.`, 1);
  }

  let res;
  try {
    res = await fetch(`https://codeload.github.com/${owner}/${repo}/tar.gz/${sha}`, {
      headers: { 'User-Agent': USER_AGENT },
    });
  } catch (e) {
    throw new CliError(`Network error downloading the repo tarball: ${e.message}`, 1);
  }
  if (!res.ok) throw new CliError(`Could not download ${owner}/${repo}@${sha.slice(0, 7)} (HTTP ${res.status}).`, 1);
  const tarball = await readBodyCapped(res, REPO_TARBALL_LIMIT, 'The repo tarball');

  await extractTarball(tarball, destDir, { transformPath: subtreeMapper(subPath) });
  return { sha };
}
