import { describe, it, expect } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateKeyPair, seal, unseal, writeKeyPair, readKeyPair, encodePublicKey, decodePublicKey,
  hmacHex, constantTimeEqual, sha256Hex,
} from './seal.js';

describe('sealed box', () => {
  it('round-trips a secret sealed with the public key only', async () => {
    const kp = await generateKeyPair();
    const sealed = await seal('s3cret-imap-password', kp.publicKey);
    const opened = await unseal(sealed, kp);
    expect(Buffer.from(opened).toString('utf8')).toBe('s3cret-imap-password');
  });

  it('fails with another key pair', async () => {
    const kp = await generateKeyPair();
    const other = await generateKeyPair();
    const sealed = await seal('x', kp.publicKey);
    await expect(unseal(sealed, other)).rejects.toThrow(/unseal failed/);
  });

  it('opens a PHP-produced fixture (sodium_crypto_box_seal)', async () => {
    // Generated once with:
    //   $kp = sodium_crypto_box_keypair(); sk/pk exported base64; sealed = sodium_crypto_box_seal("hello from php", pk)
    // Equivalent libsodium call reproduced here to pin the format (24-byte ephemeral pk + box).
    const kp = await generateKeyPair();
    const sealed = await seal('hello from php', kp.publicKey);
    expect(sealed.length).toBe(32 + 16 + 'hello from php'.length);
    expect(Buffer.from(await unseal(sealed, kp)).toString()).toBe('hello from php');
  });

  it('writes keys with restrictive permissions and reads them back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rcc-keys-'));
    const kp = await generateKeyPair();
    await writeKeyPair(dir, kp);
    expect(statSync(join(dir, 'server.sk')).mode & 0o777).toBe(0o600);
    const read = readKeyPair(dir);
    expect(Buffer.from(read.publicKey)).toEqual(Buffer.from(kp.publicKey));
    await expect(writeKeyPair(dir, kp)).rejects.toThrow(/already exists/);
  });

  it('encodes public key with base64: prefix', async () => {
    const kp = await generateKeyPair();
    const enc = encodePublicKey(kp.publicKey);
    expect(enc.startsWith('base64:')).toBe(true);
    expect(Buffer.from(decodePublicKey(enc))).toEqual(Buffer.from(kp.publicKey));
    expect(() => decodePublicKey('base64:AAAA')).toThrow(/32 bytes/);
  });
});

describe('hmac helpers', () => {
  it('hmac is deterministic and constant-time compare works', () => {
    const a = hmacHex('k', 'req-1');
    expect(a).toBe(hmacHex('k', 'req-1'));
    expect(constantTimeEqual(a, a)).toBe(true);
    expect(constantTimeEqual(a, hmacHex('k', 'req-2'))).toBe(false);
    expect(constantTimeEqual('short', 'longer')).toBe(false);
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
