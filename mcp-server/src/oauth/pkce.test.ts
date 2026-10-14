import { describe, it, expect } from 'vitest';
import { computeS256, verifyPkce, isValidCodeChallenge } from './pkce.js';

describe('PKCE', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'.repeat(1).padEnd(43, 'a');
  it('verifies S256 challenge', () => {
    const challenge = computeS256(verifier);
    expect(isValidCodeChallenge(challenge)).toBe(true);
    expect(verifyPkce(verifier, challenge, 'S256')).toBe(true);
  });
  it('rejects wrong verifier, plain method and short verifiers', () => {
    const challenge = computeS256(verifier);
    expect(verifyPkce(verifier + 'x', challenge, 'S256')).toBe(false);
    expect(verifyPkce(verifier, verifier, 'plain')).toBe(false);
    expect(verifyPkce('short', challenge, 'S256')).toBe(false);
    expect(verifyPkce(undefined, challenge, 'S256')).toBe(false);
  });
  it('matches RFC 7636 appendix B vector', () => {
    expect(computeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});
