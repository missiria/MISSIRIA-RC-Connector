import sodium from 'libsodium-wrappers';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

const PK_PREFIX = 'base64:';

export async function generateKeyPair(): Promise<KeyPair> {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

export function encodePublicKey(pk: Uint8Array): string {
  return PK_PREFIX + Buffer.from(pk).toString('base64');
}

export function decodePublicKey(s: string): Uint8Array {
  const raw = s.startsWith(PK_PREFIX) ? s.slice(PK_PREFIX.length) : s;
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('public key must be 32 bytes');
  return new Uint8Array(buf);
}

/** Writes server.sk (0600) and server.pk into dir. Refuses to overwrite an existing private key. */
export async function writeKeyPair(dir: string, kp: KeyPair, { force = false } = {}): Promise<void> {
  mkdirSync(dir, { recursive: true, mode: 0o750 });
  const skPath = join(dir, 'server.sk');
  if (existsSync(skPath) && !force) throw new Error(`${skPath} already exists (use --force to overwrite)`);
  writeFileSync(skPath, Buffer.from(kp.privateKey).toString('base64') + '\n', { mode: 0o600 });
  chmodSync(skPath, 0o600);
  writeFileSync(join(dir, 'server.pk'), encodePublicKey(kp.publicKey) + '\n', { mode: 0o640 });
}

export function readKeyPair(dir: string): KeyPair {
  const sk = Buffer.from(readFileSync(join(dir, 'server.sk'), 'utf8').trim(), 'base64');
  const pk = decodePublicKey(readFileSync(join(dir, 'server.pk'), 'utf8').trim());
  if (sk.length !== 32) throw new Error('server.sk is not a 32-byte key');
  return { publicKey: pk, privateKey: new Uint8Array(sk) };
}

/** What the PHP plugin does: sodium_crypto_box_seal($plaintext, $publicKey). Used in tests and the CLI. */
export async function seal(plaintext: Uint8Array | string, publicKey: Uint8Array): Promise<Uint8Array> {
  await sodium.ready;
  const msg = typeof plaintext === 'string' ? sodium.from_string(plaintext) : plaintext;
  return sodium.crypto_box_seal(msg, publicKey);
}

/** Opens a sealed box. Caller must wipe the result (wipe()) as soon as it is no longer needed. */
export async function unseal(sealed: Uint8Array, kp: KeyPair): Promise<Uint8Array> {
  await sodium.ready;
  try {
    return sodium.crypto_box_seal_open(sealed, kp.publicKey, kp.privateKey);
  } catch {
    throw new Error('unseal failed: wrong key or corrupted blob');
  }
}

export function wipe(buf: Uint8Array): void {
  buf.fill(0);
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacHex(key: string, message: string): string {
  return createHmac('sha256', key).update(message).digest('hex');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function randomId(): string {
  return randomBytes(16).toString('hex');
}
