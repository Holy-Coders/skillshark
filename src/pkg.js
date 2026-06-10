// The security core: build, extract, verify. SkillShark never executes
// package content — extraction writes regular files and directories, nothing else.
import { mkdtemp, mkdir, writeFile, readFile, readdir, chmod, rm, stat } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import * as tar from 'tar';
import { sha256hex, treeFingerprint } from './fingerprint.js';
import { CliError, MSG } from './errors.js';

export const MAX_DECOMPRESSED_BYTES = 50 * 1024 * 1024;
export const MAX_FILES = 500;
export const MANIFEST_NAME = 'skillshark.json';

export class ExtractError extends CliError {
  constructor(message, details) {
    super(message, 1, details);
    this.name = 'ExtractError';
  }
}

// --- build ----------------------------------------------------------------

// files: [{ path, abs, executable }] — path is "/"-separated, relative to package root.
// Returns the canonical tarball with `skillshark.json` at the archive root.
export async function buildTarball(files, manifest) {
  const staging = await mkdtemp(path.join(os.tmpdir(), 'skillshark-pack-'));
  try {
    for (const f of files) {
      const dest = path.join(staging, ...f.path.split('/'));
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, await readFile(f.abs));
      await chmod(dest, f.executable ? 0o755 : 0o644);
    }
    const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
    await writeFile(path.join(staging, MANIFEST_NAME), manifestJson);
    const tarFile = path.join(staging, '..', `skillshark-tar-${process.pid}-${Date.now()}.tgz`);
    try {
      await tar.create(
        { file: tarFile, gzip: true, cwd: staging, portable: true },
        [MANIFEST_NAME, ...files.map((f) => f.path)],
      );
      return { tarball: await readFile(tarFile), manifestJson };
    } finally {
      await rm(tarFile, { force: true });
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// --- extract ---------------------------------------------------------------

// Reject anything that could land outside the extraction root. Returns the
// cleaned, "/"-joined relative path ('' for the root itself).
function cleanEntryPath(raw) {
  let p = String(raw);
  if (p.includes('\u0000')) throw new ExtractError('Refused tar entry: NUL byte in path.');
  if (p.includes('\\')) throw new ExtractError(`Refused tar entry "${p}": backslash in path.`);
  if (/^[A-Za-z]:/.test(p)) throw new ExtractError(`Refused tar entry "${p}": drive letter path.`);
  if (p.startsWith('/')) throw new ExtractError(`Refused tar entry "${p}": absolute path.`);
  const segs = p.split('/').filter((s) => s !== '' && s !== '.');
  if (segs.includes('..')) throw new ExtractError(`Refused tar entry "${p}": path traversal ("..").`);
  return segs.join('/');
}

// Guarded streaming extraction (§7.2). Own entry filter — node-tar's built-in
// protections are not relied on. transformPath(cleanPath) → string|null lets the
// repo transport strip the codeload prefix and select a subtree; null skips.
export async function extractTarball(tarball, destRoot, opts = {}) {
  const {
    maxBytes = MAX_DECOMPRESSED_BYTES,
    maxFiles = MAX_FILES,
    transformPath = null,
  } = opts;

  const root = path.resolve(destRoot);
  const entries = [];
  let bytesSeen = 0;
  let fileCount = 0;
  let openEntries = 0;

  await new Promise((resolve, reject) => {
    let settled = false;
    const gunzip = createGunzip();
    const parser = new tar.Parser();
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { gunzip.destroy(); } catch { /* already dead */ }
      try { parser.abort(err); } catch { /* best effort */ }
      reject(err);
    };
    const done = () => {
      if (settled) return;
      if (openEntries > 0) {
        fail(new ExtractError('Truncated archive: a file entry ended early. Nothing was installed.'));
        return;
      }
      settled = true;
      resolve();
    };

    parser.on('entry', (entry) => {
      try {
        if (entry.meta) { entry.resume(); return; } // pax/gnu metadata consumed by the parser
        const cleaned = cleanEntryPath(entry.path);
        const mapped = transformPath ? transformPath(cleaned, entry.type) : cleaned;
        if (mapped === null || mapped === undefined || mapped === '') {
          if (entry.type === 'File' && !transformPath && mapped === '') {
            throw new ExtractError(`Refused tar entry "${entry.path}": empty path.`);
          }
          entry.resume();
          return;
        }
        const rel = cleanEntryPath(mapped); // re-validate after any transform
        const resolved = path.resolve(root, ...rel.split('/'));
        if (resolved !== root && !resolved.startsWith(root + path.sep)) {
          throw new ExtractError(`Refused tar entry "${entry.path}": escapes extraction root.`);
        }
        if (entry.type === 'Directory') {
          entries.push({ rel, type: 'dir' });
          entry.resume();
          return;
        }
        if (entry.type !== 'File') {
          throw new ExtractError(
            `Refused tar entry "${entry.path}": type "${entry.type}" is not allowed (only files and directories).`,
          );
        }
        fileCount += 1;
        if (fileCount > maxFiles) {
          throw new ExtractError(`Package has too many files (limit ${maxFiles}). Nothing was installed.`);
        }
        openEntries += 1;
        const expected = entry.size ?? 0;
        const chunks = [];
        entry.on('data', (c) => chunks.push(c));
        entry.on('end', () => {
          const data = Buffer.concat(chunks);
          if (data.length !== expected) {
            fail(new ExtractError(`Truncated archive: "${rel}" ended early. Nothing was installed.`));
            return;
          }
          openEntries -= 1;
          entries.push({ rel, type: 'file', mode: entry.mode ?? 0o644, data });
        });
      } catch (err) {
        fail(err);
      }
    });
    parser.on('error', fail);
    // strict mode: a malformed entry the parser would skip (bad checksum,
    // forbidden linkpath, unsupported extension) aborts the whole extraction
    parser.on('warn', (code, message) => {
      fail(new ExtractError(`Refused malformed archive entry (${code}: ${message}). Nothing was installed.`));
    });
    parser.on('end', done);
    parser.on('close', done);

    gunzip.on('data', (chunk) => {
      bytesSeen += chunk.length;
      if (bytesSeen > maxBytes) {
        fail(new ExtractError(
          `Package expands past the ${Math.floor(maxBytes / (1024 * 1024))} MB safety limit. Nothing was installed.`,
          { bytesSeen },
        ));
        return;
      }
      parser.write(chunk);
    });
    gunzip.on('end', () => parser.end());
    gunzip.on('error', (e) => fail(new ExtractError(`Not a valid package (gzip): ${e.message}`)));
    gunzip.end(tarball);
  });

  for (const e of entries) {
    const dest = path.resolve(root, ...e.rel.split('/'));
    if (e.type === 'dir') {
      await mkdir(dest, { recursive: true });
    } else {
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, e.data, { mode: (e.mode & 0o111) ? 0o755 : 0o644 });
    }
  }
  return { bytesSeen, fileCount };
}

// --- verify ----------------------------------------------------------------

// Walk an on-disk tree → [{ path, size, sha256, executable }], sorted by path.
// Symlinks and special files are never followed or hashed.
export async function hashTree(dir, { exclude = [MANIFEST_NAME] } = {}) {
  const out = [];
  async function walk(d, prefix) {
    const dirents = await readdir(d, { withFileTypes: true });
    for (const ent of dirents) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (!prefix && exclude.includes(ent.name)) continue;
      if (ent.isDirectory()) await walk(path.join(d, ent.name), rel);
      else if (ent.isFile()) {
        const abs = path.join(d, ent.name);
        const data = await readFile(abs);
        const { mode } = await stat(abs);
        out.push({
          path: rel,
          size: data.length,
          sha256: sha256hex(data),
          executable: Boolean(mode & 0o111),
        });
      }
      // anything else (symlink smuggled in, fifo, …) is ignored: we never wrote it
    }
  }
  await walk(dir, '');
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

export async function readManifest(dir) {
  let raw;
  try {
    raw = await readFile(path.join(dir, MANIFEST_NAME), 'utf8');
  } catch {
    throw new CliError('No package at that link (missing skillshark.json — not a SkillShark share).', 1);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new CliError(MSG.downloadIntegrity, 1);
  }
  if (!manifest || !Array.isArray(manifest.files) || typeof manifest.name !== 'string') {
    throw new CliError(MSG.downloadIntegrity, 1);
  }
  return manifest;
}

// Per-file sha256 + exact set equality between the manifest and the extracted
// tree. Returns the tree fingerprint computed from the *actual* bytes.
export function verifyTreeAgainstManifest(actualFiles, manifest) {
  const actualByPath = new Map(actualFiles.map((f) => [f.path, f]));
  const manifestByPath = new Map();
  for (const f of manifest.files) {
    if (typeof f.path !== 'string' || typeof f.sha256 !== 'string') {
      throw new CliError(MSG.downloadIntegrity, 1);
    }
    manifestByPath.set(f.path, f);
  }
  if (actualByPath.size !== manifestByPath.size) throw new CliError(MSG.downloadIntegrity, 1);
  for (const [p, mf] of manifestByPath) {
    const af = actualByPath.get(p);
    if (!af || af.sha256 !== mf.sha256) throw new CliError(MSG.downloadIntegrity, 1);
  }
  const fingerprint = treeFingerprint(actualFiles);
  if (manifest.fingerprint && manifest.fingerprint !== fingerprint) {
    throw new CliError(MSG.downloadIntegrity, 1);
  }
  return fingerprint;
}
