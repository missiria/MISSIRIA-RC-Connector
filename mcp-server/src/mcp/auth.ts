import type { Context, Next } from 'hono';
import type { Deps } from '../deps.js';
import type { Principal } from '../oauth/tokens.js';

export type AuthEnv = { Variables: { principal: Principal } };

export function requireBearer(deps: Deps) {
  const metadata = `${deps.cfg.PUBLIC_URL}/.well-known/oauth-protected-resource`;
  return async (c: Context<AuthEnv>, next: Next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const principal = token ? await deps.tokens.authenticate(token) : undefined;
    if (!principal) {
      c.header('WWW-Authenticate', `Bearer resource_metadata="${metadata}", error="invalid_token"`);
      return c.json({ error: 'invalid_token', error_description: 'missing, expired or revoked bearer token' }, 401);
    }
    c.set('principal', principal);
    await next();
  };
}
