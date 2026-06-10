// v0.4: privacy by default. The payload is sealed (AES-256-GCM, HKDF over a
// link secret + per-share salt) before upload; GitHub stores ciphertext and a
// metadata-free stub; the only key rides in the link fragment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  generateLinkSecret,
  encodeSecret,
  decodeSecret,
  encryptTarball,
  decryptEnvelope,
  isEnvelope,
  MSG_DECRYPT_FAILED,
  MSG_ENCRYPTED_NEEDS_KEY,
} from '../src/crypt.js';
import { parseSource } from '../src/source.js';
import { runShare } from '../src/share.js';
import { runInstall, runInspect } from '../src/install.js';
import { CliError, MSG } from '../src/errors.js';
import { silentUi, throwingPrompts, tmpdir, writeTree, fakeFetch } from './helpers.js';

const GIST_ID = 'feedfacefeedfacefeedfacefeedface';
const SECRET_BODY = 'TOP-SECRET-MARKER: the launch codes are in the fridge';

async function senderDeps() {
  const cwd = await tmpdir('skillshark-priv-');
  await writeTree(
    {
      '.claude/skills/covert/SKILL.md': `---\nname: covert\ndescription: Covert ops.\n---\n# covert\n\n${SECRET_BODY}\n`,
    },
    cwd,
  );
  return {
    cwd,
    home: await tmpdir(),
    env: {},
    isTTY: false,
    configDir: await tmpdir(),
    ui: silentUi(),
    prompts: throwingPrompts(),
    fetch: async () => {
      throw new Error('share must not use anonymous fetch');
    },
    clipboard: async () => true,
  };
}

// --- crypto core ---------------------------------------------------------------

test('crypt: encrypt → decrypt round-trips byte-identically', () => {
  const secret = generateLinkSecret();
  const payload = Buffer.from('skill bytes '.repeat(1000));
  const envelope = encryptTarball(payload, secret);
  assert.ok(isEnvelope(envelope));
  assert.equal(envelope.subarray(0, 4).toString(), 'SSE1');
  assert.ok(!envelope.includes(payload.subarray(0, 32)), 'plaintext must not appear in the envelope');
  assert.deepEqual(decryptEnvelope(envelope, secret), payload);
});

test('crypt: wrong key, flipped ciphertext bit, and truncated envelope all fail closed', () => {
  const secret = generateLinkSecret();
  const envelope = encryptTarball(Buffer.from('payload'), secret);

  assert.throws(
    () => decryptEnvelope(envelope, generateLinkSecret()),
    (e) => e instanceof CliError && e.exitCode === 1 && e.message === MSG_DECRYPT_FAILED,
  );
  const tampered = Buffer.from(envelope);
  tampered[tampered.length - 1] ^= 0x01;
  assert.throws(() => decryptEnvelope(tampered, secret), (e) => e.message === MSG_DECRYPT_FAILED);
  assert.throws(() => decryptEnvelope(envelope.subarray(0, 20), secret), (e) => e.message === MSG_DECRYPT_FAILED);
});

test('crypt: same payload twice → different salts, ivs, and ciphertexts (no correlation at rest)', () => {
  const secret = generateLinkSecret();
  const payload = Buffer.from('identical bytes');
  const a = encryptTarball(payload, secret);
  const b = encryptTarball(payload, secret);
  assert.notDeepEqual(a, b);
  assert.notDeepEqual(a.subarray(4, 20), b.subarray(4, 20), 'salts differ');
});

test('crypt: secrets encode to 43-char base64url and survive the round trip; junk is refused', () => {
  const secret = generateLinkSecret();
  const encoded = encodeSecret(secret);
  assert.match(encoded, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(decodeSecret(encoded), secret);
  for (const bad of ['short', 'x'.repeat(43) + '!', '']) {
    assert.throws(() => decodeSecret(bad), (e) => e instanceof CliError && e.exitCode === 2);
  }
});

test('parseSource: #k=&fp= fragments parse in either order; legacy #fp-only still works', () => {
  const k = encodeSecret(generateLinkSecret());
  const a = parseSource(`https://gist.github.com/${GIST_ID}#k=${k}&fp=3f9a7c21`);
  assert.equal(a.key, k);
  assert.equal(a.fp, '3f9a7c21');
  const b = parseSource(`https://gist.github.com/${GIST_ID}#fp=3f9a7c21&k=${k}`);
  assert.equal(b.key, k);
  assert.equal(b.fp, '3f9a7c21');
  const legacy = parseSource(`https://gist.github.com/${GIST_ID}#fp=3f9a7c21`);
  assert.equal(legacy.key, null);
  assert.equal(legacy.fp, '3f9a7c21');
});

// --- end-to-end: share encrypted → gist stores nothing readable → install ----------

async function shareEncrypted() {
  const deps = await senderDeps();
  let gistBody = null;
  deps.ghApi = async (args) => {
    gistBody = JSON.parse(await readFile(args[args.indexOf('--input') + 1], 'utf8'));
    return JSON.stringify({ id: GIST_ID, history: [{ version: 'r1' }] });
  };
  const res = await runShare('covert', { noClipboard: true }, deps);
  return { deps, gistBody, res };
}

function receiverDepsFor(gistBody) {
  const apiResponse = {
    id: GIST_ID,
    public: false,
    description: gistBody.description,
    owner: { login: 'sender' },
    history: [{ version: 'r1' }],
    files: Object.fromEntries(
      Object.entries(gistBody.files).map(([name, f]) => [name, { filename: name, truncated: false, content: f.content }]),
    ),
  };
  return (async () => ({
    fetch: fakeFetch({ [`api.github.com/gists/${GIST_ID}`]: apiResponse }),
    cwd: await tmpdir(),
    home: await tmpdir(),
    env: {},
    isTTY: false,
    configDir: await tmpdir(),
    ui: silentUi(),
    prompts: throwingPrompts(),
    ghApi: async () => {
      throw new Error('gh invoked by the receive path');
    },
    clipboard: async () => false,
  }))();
}

test('e2e: encrypted share leaks nothing — no name, no SKILL.md, no plaintext anywhere in the gist', async () => {
  const { gistBody, res } = await shareEncrypted();
  assert.equal(res.encrypted, true);
  assert.deepEqual(Object.keys(gistBody.files).sort(), ['SKILLSHARK.json', 'package.tgz.enc.b64']);
  const raw = JSON.stringify(gistBody);
  assert.ok(!raw.includes('covert'), 'the skill name must not appear in the gist');
  assert.ok(!raw.includes('Covert ops'), 'the description must not appear in the gist');
  assert.ok(!raw.includes('TOP-SECRET-MARKER'), 'content must not appear in the gist');
  assert.match(gistBody.description, /^skillshark: encrypted \(fp [0-9a-f]{8}\)$/);
  const stub = JSON.parse(gistBody.files['SKILLSHARK.json'].content);
  assert.equal(stub.encrypted, true);
  assert.equal(stub.files, undefined, 'the stub carries no file list');
  const envelope = Buffer.from(gistBody.files['package.tgz.enc.b64'].content, 'base64');
  assert.equal(envelope.subarray(0, 4).toString(), 'SSE1');
});

test('e2e: the full link installs; byte-identical content lands', async () => {
  const { gistBody, res } = await shareEncrypted();
  const deps = await receiverDepsFor(gistBody);
  const dir = path.join(deps.cwd, 'covert');
  await runInstall(res.url, { yes: true, dir }, deps);
  const skillMd = await readFile(path.join(dir, 'SKILL.md'), 'utf8');
  assert.match(skillMd, /TOP-SECRET-MARKER/);
  // inspect through the same keyed link works too
  const ideps = await receiverDepsFor(gistBody);
  await runInspect(res.url, { cat: 'SKILL.md' }, ideps);
  assert.match(ideps.ui.text(), /TOP-SECRET-MARKER/);
});

test('e2e: link without the #k= key refuses with the fragment-stripped guidance', async () => {
  const { gistBody, res } = await shareEncrypted();
  const deps = await receiverDepsFor(gistBody);
  const keyless = res.url.replace(/#.*$/, `#fp=${res.fingerprint.slice(0, 8)}`);
  await assert.rejects(
    () => runInstall(keyless, { yes: true, dir: path.join(deps.cwd, 'x') }, deps),
    (e) => e instanceof CliError && e.exitCode === 1 && e.message === MSG_ENCRYPTED_NEEDS_KEY,
  );
  assert.ok(!existsSync(path.join(deps.cwd, 'x')));
});

test('e2e: wrong key fails closed; tampered #fp still caught after decryption', async () => {
  const { gistBody, res } = await shareEncrypted();
  const deps = await receiverDepsFor(gistBody);
  const wrongKey = res.url.replace(/#k=[^&]+/, `#k=${encodeSecret(generateLinkSecret())}`);
  await assert.rejects(
    () => runInstall(wrongKey, { yes: true, dir: path.join(deps.cwd, 'x') }, deps),
    (e) => e instanceof CliError && e.message === MSG_DECRYPT_FAILED,
  );

  const deps2 = await receiverDepsFor(gistBody);
  const badFp = res.url.replace(/&fp=[0-9a-f]+/, '&fp=deadbeef');
  await assert.rejects(
    () => runInstall(badFp, { yes: true, dir: path.join(deps2.cwd, 'x') }, deps2),
    (e) => e instanceof CliError && e.message === MSG.linkIntegrity,
  );
});

test('--no-encrypt opts out: plaintext layout with SKILL.md preview and #fp-only link', async () => {
  const deps = await senderDeps();
  let gistBody = null;
  deps.ghApi = async (args) => {
    gistBody = JSON.parse(await readFile(args[args.indexOf('--input') + 1], 'utf8'));
    return JSON.stringify({ id: GIST_ID, history: [{ version: 'r1' }] });
  };
  const res = await runShare('covert', { noClipboard: true, noEncrypt: true }, deps);
  assert.equal(res.encrypted, false);
  assert.deepEqual(Object.keys(gistBody.files).sort(), ['SKILL.md', 'SKILLSHARK.json', 'package.tgz.b64']);
  assert.match(res.url, /#fp=[0-9a-f]{8}$/);
  assert.match(deps.ui.text(), /UNENCRYPTED/);
});
