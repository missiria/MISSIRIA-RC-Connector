import { SignJWT, jwtVerify } from 'jose';
import type { Config, Scope } from '../config.js';
import { isScope } from '../config.js';
import type { Store, GrantRow } from '../store/db.js';
import { randomToken, sha256Hex, randomId } from '../crypto/seal.js';

export const PAT_PREFIX = 'rcc_';

export interface Principal {
  grantId: string;
  username: string;
  /** Sender address: Roundcube identity when known, else username. */
  email: string | null;
  scopes: Scope[];
  kind: 'oauth' | 'pat';
}

export class TokenService {
  private readonly secret: Uint8Array;

  constructor(private readonly cfg: Config, private readonly store: Store) {
    this.secret = new TextEncoder().encode(cfg.JWT_SECRET);
  }

  get audience(): string {
    return `${this.cfg.PUBLIC_URL}/mcp`;
  }

  async issueAccessToken(grant: GrantRow): Promise<{ token: string; expiresIn: number }> {
    const expiresIn = this.cfg.ACCESS_TOKEN_TTL_SECONDS;
    const token = await new SignJWT({ scope: grant.scopes.join(' ') })
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
      .setIssuer(this.cfg.PUBLIC_URL)
      .setAudience(this.audience)
      .setSubject(grant.id)
      .setJti(randomId())
      .setIssuedAt()
      .setExpirationTime(`${expiresIn}s`)
      .sign(this.secret);
    return { token, expiresIn };
  }

  issueRefreshToken(grant: GrantRow): string {
    const token = randomToken(32);
    this.store.insertToken({
      hash: sha256Hex(token),
      grant_id: grant.id,
      kind: 'refresh',
      expires_at: Math.floor(Date.now() / 1000) + this.cfg.REFRESH_TOKEN_TTL_DAYS * 86400,
    });
    return token;
  }

  issuePat(grant: GrantRow): string {
    const token = PAT_PREFIX + randomToken(32);
    this.store.insertToken({ hash: sha256Hex(token), grant_id: grant.id, kind: 'pat', expires_at: null });
    return token;
  }

  /** Resolves a refresh token to its live grant, or undefined. Does not rotate. */
  resolveRefreshToken(token: string): { grant: GrantRow; hash: string } | undefined {
    const hash = sha256Hex(token);
    const row = this.store.getToken(hash);
    if (!row || row.kind !== 'refresh' || row.revoked_at) return undefined;
    if (row.expires_at !== null && row.expires_at < Math.floor(Date.now() / 1000)) return undefined;
    const grant = this.store.getGrant(row.grant_id);
    if (!grant || grant.revoked_at) return undefined;
    return { grant, hash };
  }

  /** Bearer → principal. Accepts rcc_ PATs and HS256 access tokens. */
  async authenticate(bearer: string): Promise<Principal | undefined> {
    if (bearer.startsWith(PAT_PREFIX)) {
      const row = this.store.getToken(sha256Hex(bearer));
      if (!row || row.kind !== 'pat' || row.revoked_at) return undefined;
      const grant = this.store.getGrant(row.grant_id);
      if (!grant || grant.revoked_at) return undefined;
      return { grantId: grant.id, username: grant.username, email: grant.email, scopes: grant.scopes, kind: 'pat' };
    }
    try {
      const { payload } = await jwtVerify(bearer, this.secret, {
        issuer: this.cfg.PUBLIC_URL,
        audience: this.audience,
        algorithms: ['HS256'],
      });
      if (!payload.sub) return undefined;
      const grant = this.store.getGrant(payload.sub);
      if (!grant || grant.revoked_at) return undefined;
      const scopes = String(payload['scope'] ?? '').split(' ').filter(isScope);
      return { grantId: grant.id, username: grant.username, email: grant.email, scopes, kind: 'oauth' };
    } catch {
      return undefined;
    }
  }
}
