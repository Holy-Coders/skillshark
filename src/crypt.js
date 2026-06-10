// Privacy by default: the canonical tarball is sealed in an authenticated
// envelope before it ever leaves the machine. GitHub stores ciphertext; the
// decryption secret travels ONLY in the link's #fragment — it lands on the
// sender's clipboard inside the install one-liner and is never sent to any
// server by anything SkillShark does.
//
// Envelope (base64-encoded into the gist as package.tgz.enc.b64):
//   "SSE1" (4) | salt (16) | iv (12) | gcm tag (16) | ciphertext
//
// key = HKDF-SHA256(ikm = 32-byte link secret, salt = per-share salt,
//                   info = "skillshark.v1.aes-256-gcm") → AES-256-GCM.
// The per-share salt rides inside the envelope: the link secret alone is
// useless without the share it belongs to, and no two shares — even of the
// same bytes — produce related keys.
import { randomBytes, hkdfSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { CliError } from './errors.js';

export const ENVELOPE_MAGIC = Buffer.from('SSE1');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const SECRET_LEN = 32;
const HKDF_INFO = 'skillshark.v1.aes-256-gcm';

export const MSG_ENCRYPTED_NEEDS_KEY =
  'This share is encrypted and the link is missing its key (the #k=… part of the fragment). ' +
  'Some apps strip URL fragments — ask the sender to resend the full link.';
export const MSG_DECRYPT_FAILED =
  'Could not decrypt this share — the key in the link does not match the payload ' +
  '(wrong link, or the share was tampered with). Nothing was installed.';

export function generateLinkSecret() {
  return randomBytes(SECRET_LEN);
}

export function encodeSecret(secret) {
  return secret.toString('base64url');
}

export function decodeSecret(encoded) {
  // validate the string form: Buffer.from silently drops invalid characters
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(encoded ?? ''))) {
    throw new CliError('The #k= key in that link is malformed.', 2);
  }
  const buf = Buffer.from(encoded, 'base64url');
  if (buf.length !== SECRET_LEN) {
    throw new CliError('The #k= key in that link is malformed.', 2);
  }
  return buf;
}

function deriveKey(secret, salt) {
  return Buffer.from(hkdfSync('sha256', secret, salt, HKDF_INFO, 32));
}

export function encryptTarball(tarball, secret) {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(secret, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(tarball), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ENVELOPE_MAGIC, salt, iv, tag, ciphertext]);
}

export function isEnvelope(bytes) {
  return bytes.length > ENVELOPE_MAGIC.length && bytes.subarray(0, 4).equals(ENVELOPE_MAGIC);
}

export function decryptEnvelope(envelope, secret) {
  const minLen = ENVELOPE_MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN + 1;
  if (!isEnvelope(envelope) || envelope.length < minLen) {
    throw new CliError(MSG_DECRYPT_FAILED, 1);
  }
  let off = ENVELOPE_MAGIC.length;
  const salt = envelope.subarray(off, (off += SALT_LEN));
  const iv = envelope.subarray(off, (off += IV_LEN));
  const tag = envelope.subarray(off, (off += TAG_LEN));
  const ciphertext = envelope.subarray(off);
  const key = deriveKey(secret, salt);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // GCM auth failure: wrong key or modified ciphertext — same honest answer
    throw new CliError(MSG_DECRYPT_FAILED, 1);
  }
}
