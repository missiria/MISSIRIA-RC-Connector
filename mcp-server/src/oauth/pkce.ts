import { createHash } from 'node:crypto';
import { constantTimeEqual } from '../crypto/seal.js';

const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isValidCodeChallenge(challenge: string): boolean {
  // base64url of a SHA-256 digest is exactly 43 chars without padding
  return /^[A-Za-z0-9\-_]{43}$/.test(challenge);
}

export function computeS256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function verifyPkce(verifier: string | undefined, challenge: string, method: string): boolean {
  if (!verifier || !VERIFIER_RE.test(verifier)) return false;
  if (method !== 'S256') return false;
  return constantTimeEqual(computeS256(verifier), challenge);
}
