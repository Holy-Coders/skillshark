// §7.3 — source parsing. Accepted forms:
//   https://gist.github.com/<id>            (optionally <user>/<id>, optionally #fp=<hex>)
//   https://gist.<ghes-host>/<id>           GitHub Enterprise, subdomain isolation
//   https://<ghes-host>/gist/<id>           GitHub Enterprise, path form
//   <20-32 char hex gist id>                (host from --host / GH_HOST, default github.com)
//   gh:owner/repo[/deep/path][@ref]         (ref = branch, tag, or SHA; split on the LAST "@")
import { CliError } from './errors.js';

export const DEFAULT_HOST = 'github.com';

const USAGE = `Unrecognized source. Accepted forms:
  https://gist.github.com/8a1bc94ef23d4b6a9c01e57f8d2a4b3c#fp=3f9a7c21
  https://ghe.example.com/gist/8a1bc94ef23d4b6a9c01e57f8d2a4b3c#fp=3f9a7c21
  8a1bc94ef23d4b6a9c01e57f8d2a4b3c
  gh:owner/repo[/deep/path][@ref]`;

const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;

// The host a command should talk to: explicit flag → env → github.com.
export function resolveHost(opts = {}, deps = {}) {
  const host = opts.host || deps.env?.SKILLSHARK_HOST || deps.env?.GH_HOST || DEFAULT_HOST;
  if (!HOST_RE.test(host)) throw new CliError(`Invalid --host "${host}".`, 2);
  return host.toLowerCase();
}

export function parseSource(input, { defaultHost = DEFAULT_HOST } = {}) {
  const s = String(input ?? '').trim();
  if (!s) throw new CliError(USAGE, 2);

  // gist.<host>/<id> — github.com and GHES-with-subdomain-isolation alike
  let m = s.match(
    /^https:\/\/gist\.([a-z0-9.-]+)\/(?:([A-Za-z0-9-]+)\/)?([0-9a-f]{20,32})\/?(?:#fp=([0-9a-f]{8,64}))?$/i,
  );
  if (m) {
    return { kind: 'gist', id: m[3], fp: m[4] ?? null, host: m[1].toLowerCase() };
  }

  // <host>/gist/<id> — GHES path form
  m = s.match(
    /^https:\/\/([a-z0-9.-]+)\/gist\/(?:([A-Za-z0-9-]+)\/)?([0-9a-f]{20,32})\/?(?:#fp=([0-9a-f]{8,64}))?$/i,
  );
  if (m && m[1].toLowerCase() !== 'github.com') {
    return { kind: 'gist', id: m[3], fp: m[4] ?? null, host: m[1].toLowerCase() };
  }

  if (/^[0-9a-f]{20,32}$/.test(s)) {
    return { kind: 'gist', id: s, fp: null, host: defaultHost };
  }

  if (s.startsWith('gh:')) {
    let rest = s.slice(3);
    let ref = null;
    const at = rest.lastIndexOf('@');
    if (at !== -1) {
      ref = rest.slice(at + 1);
      rest = rest.slice(0, at);
      if (!ref) throw new CliError(USAGE, 2);
    }
    const segs = rest.split('/').filter(Boolean);
    if (segs.length >= 2 && NAME_RE.test(segs[0]) && NAME_RE.test(segs[1])) {
      return {
        kind: 'repo',
        owner: segs[0],
        repo: segs[1],
        path: segs.length > 2 ? segs.slice(2).join('/') : null,
        ref,
        host: defaultHost,
      };
    }
  }

  throw new CliError(`Unrecognized source: "${s}"\n${USAGE.split('\n').slice(1).join('\n')}`, 2);
}

export function formatSource(src) {
  const hostTag = src.host && src.host !== DEFAULT_HOST ? `${src.host}:` : '';
  if (src.kind === 'gist') return `gist:${hostTag}${src.id}`;
  const p = src.path ? `/${src.path}` : '';
  const r = src.ref ? `@${src.ref}` : '';
  return `gh:${hostTag}${src.owner}/${src.repo}${p}${r}`;
}
