// §7.3 — source parsing. Accepted forms:
//   https://gist.github.com/<id>            (optionally <user>/<id>, optionally #fp=<hex>)
//   <20-32 char hex gist id>
//   gh:owner/repo[/deep/path][@ref]         (ref = branch, tag, or SHA; split on the LAST "@")
import { CliError } from './errors.js';

const USAGE = `Unrecognized source. Accepted forms:
  https://gist.github.com/8a1bc94ef23d4b6a9c01e57f8d2a4b3c#fp=3f9a7c21
  8a1bc94ef23d4b6a9c01e57f8d2a4b3c
  gh:owner/repo[/deep/path][@ref]`;

const NAME_RE = /^[A-Za-z0-9_.-]+$/;

export function parseSource(input) {
  const s = String(input ?? '').trim();
  if (!s) throw new CliError(USAGE, 2);

  const gistUrl = s.match(
    /^https:\/\/gist\.github\.com\/(?:([A-Za-z0-9-]+)\/)?([0-9a-f]{20,32})\/?(?:#fp=([0-9a-f]{8,64}))?$/,
  );
  if (gistUrl) {
    return { kind: 'gist', id: gistUrl[2], fp: gistUrl[3] ?? null };
  }

  if (/^[0-9a-f]{20,32}$/.test(s)) {
    return { kind: 'gist', id: s, fp: null };
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
      };
    }
  }

  throw new CliError(`Unrecognized source: "${s}"\n${USAGE.split('\n').slice(1).join('\n')}`, 2);
}

export function formatSource(src) {
  if (src.kind === 'gist') return `gist:${src.id}`;
  const p = src.path ? `/${src.path}` : '';
  const r = src.ref ? `@${src.ref}` : '';
  return `gh:${src.owner}/${src.repo}${p}${r}`;
}
