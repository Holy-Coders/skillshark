import { createHash } from 'node:crypto';

export function sha256hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

// §7.1 — tree fingerprint, independent of tar framing, mtimes, and file order.
// entries = path + NUL + sha256hex, lexicographically byte-sorted, joined with "\n",
// then sha256-hexed. skillshark.json itself is never part of `files`.
export function treeFingerprint(files) {
  const entries = files.map((f) => Buffer.from(f.path + '\u0000' + f.sha256, 'utf8'));
  entries.sort(Buffer.compare);
  const nl = Buffer.from('\n');
  const parts = [];
  for (let i = 0; i < entries.length; i++) {
    if (i > 0) parts.push(nl);
    parts.push(entries[i]);
  }
  return sha256hex(Buffer.concat(parts));
}

export function fp8(fingerprint) {
  return fingerprint.slice(0, 8);
}

// fp8 displayed as XXXX-XXXX (e.g. 3f9a-7c21)
export function formatFp8(fingerprint) {
  return `${fingerprint.slice(0, 4)}-${fingerprint.slice(4, 8)}`;
}
