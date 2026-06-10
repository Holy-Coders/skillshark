// Client-side state: ~/.config/skillshark/ (or $SKILLSHARK_CONFIG_DIR).
// config.json — shares cache so `revoke <name>` resolves offline.
// installs.json — local install records (client-side by design).
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export function getConfigDir(env = process.env) {
  return env.SKILLSHARK_CONFIG_DIR || path.join(os.homedir(), '.config', 'skillshark');
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  // the share cache holds full links — including decryption keys — so it is
  // readable by the owner only
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
}

export async function loadConfig(dir) {
  const cfg = await readJson(path.join(dir, 'config.json'), {});
  if (!Array.isArray(cfg.shares)) cfg.shares = [];
  return cfg;
}

export async function saveConfig(dir, cfg) {
  await writeJson(path.join(dir, 'config.json'), cfg);
}

export async function addShareRecord(dir, record) {
  const cfg = await loadConfig(dir);
  cfg.shares.unshift(record);
  await saveConfig(dir, cfg);
}

export async function findShareRecord(dir, idOrName) {
  const cfg = await loadConfig(dir);
  return cfg.shares.find((s) => s.id === idOrName) ?? cfg.shares.find((s) => s.name === idOrName) ?? null;
}

export async function removeShareRecord(dir, id) {
  const cfg = await loadConfig(dir);
  cfg.shares = cfg.shares.filter((s) => s.id !== id);
  await saveConfig(dir, cfg);
}

export async function loadInstalls(dir) {
  const v = await readJson(path.join(dir, 'installs.json'), []);
  return Array.isArray(v) ? v : [];
}

export async function addInstallRecord(dir, record) {
  const installs = await loadInstalls(dir);
  const next = installs.filter((r) => r.path !== record.path);
  next.unshift(record);
  await writeJson(path.join(dir, 'installs.json'), next);
}
