import { Hono } from 'hono';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { SCOPES, DEFAULT_SCOPE, isScope } from '../config.js';
import { now } from '../store/db.js';
import { hmacHex, randomId, randomToken, sha256Hex, constantTimeEqual } from '../crypto/seal.js';
import { isValidCodeChallenge, verifyPkce } from './pkce.js';

const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'] as const;

const registerSchema = z.object({
  redirect_uris: z.array(z.string().url()).min(1).max(10),
  client_name: z.string().trim().min(1).max(120).default('MCP client'),
  token_endpoint_auth_method: z.enum(AUTH_METHODS).default('client_secret_basic'),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  scope: z.string().optional(),
  client_uri: z.string().url().optional(),
  logo_uri: z.string().url().optional(),
});

function redirectUriAllowed(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')) return true;
    // Native app custom schemes (e.g. cursor://, vscode://) are allowed by RFC 8252.
    return !['http:', 'javascript:', 'data:', 'file:'].includes(u.protocol);
  } catch {
    return false;
  }
}

function oauthError(status: 400 | 401 | 403, error: string, description: string) {
  return { status, body: { error, error_description: description } };
}

function withQuery(base: string, params: Record<string, string | null | undefined>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return u.toString();
}

export function consentUrl(deps: Deps, requestId: string): string {
  const sig = hmacHex(deps.cfg.INTERNAL_KEY, requestId);
  return withQuery(`${deps.cfg.WEBMAIL_URL}/`, { _task: 'rcconnector', _action: 'consent', req: requestId, sig });
}

async function readBody(c: { req: { header: (n: string) => string | undefined; json: () => Promise<unknown>; parseBody: () => Promise<Record<string, unknown>> } }) {
  const ct = c.req.header('content-type') ?? '';
  if (ct.includes('application/json')) return (await c.req.json()) as Record<string, unknown>;
  return (await c.req.parseBody()) as Record<string, unknown>;
}

export function oauthRoutes(deps: Deps): Hono {
  const { cfg, store, tokens, log } = deps;
  const app = new Hono();
  const issuer = cfg.PUBLIC_URL;

  app.get('/.well-known/oauth-authorization-server', (c) =>
    c.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: [...AUTH_METHODS],
      revocation_endpoint_auth_methods_supported: [...AUTH_METHODS],
      scopes_supported: [...SCOPES],
      service_documentation: 'https://github.com/missiria/MISSIRIA-RC-Connector',
    }),
  );

  const protectedResource = (c: { json: (o: unknown) => Response }) =>
    c.json({
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
      scopes_supported: [...SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: 'MISSIRIA RC Connector',
      resource_documentation: 'https://github.com/missiria/MISSIRIA-RC-Connector',
    });
  app.get('/.well-known/oauth-protected-resource', protectedResource);
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResource);

  // RFC 7591 dynamic client registration (open registration, public clients allowed)
  app.post('/oauth/register', async (c) => {
    const parsed = registerSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid_client_metadata', error_description: parsed.error.issues[0]?.message ?? 'invalid' }, 400);
    const meta = parsed.data;
    const bad = meta.redirect_uris.find((u) => !redirectUriAllowed(u));
    if (bad) return c.json({ error: 'invalid_redirect_uri', error_description: `redirect_uri not allowed: ${bad}` }, 400);

    const clientId = randomId();
    const secret = meta.token_endpoint_auth_method === 'none' ? null : randomToken(32);
    store.insertClient({
      client_id: clientId,
      client_secret_hash: secret ? sha256Hex(secret) : null,
      client_name: meta.client_name,
      redirect_uris: meta.redirect_uris,
      token_endpoint_auth_method: meta.token_endpoint_auth_method,
    });
    log.info({ clientId, clientName: meta.client_name }, 'oauth client registered');
    return c.json(
      {
        client_id: clientId,
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
        client_id_issued_at: now(),
        client_name: meta.client_name,
        redirect_uris: meta.redirect_uris,
        token_endpoint_auth_method: meta.token_endpoint_auth_method,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: [...SCOPES].join(' '),
      },
      201,
    );
  });

  app.get('/oauth/authorize', (c) => {
    const q = c.req.query();
    const client = q['client_id'] ? store.getClient(q['client_id']) : undefined;
    if (!client) return c.text('invalid_request: unknown client_id', 400);
    const redirectUri = q['redirect_uri'];
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) return c.text('invalid_request: redirect_uri not registered for this client', 400);

    const fail = (error: string, description: string) =>
      c.redirect(withQuery(redirectUri, { error, error_description: description, state: q['state'] }), 302);

    if (q['response_type'] !== 'code') return fail('unsupported_response_type', 'only response_type=code is supported');
    if (!q['code_challenge'] || !isValidCodeChallenge(q['code_challenge'])) return fail('invalid_request', 'code_challenge (S256) is required');
    if ((q['code_challenge_method'] ?? 'S256') !== 'S256') return fail('invalid_request', 'code_challenge_method must be S256');
    const scopes = (q['scope'] ?? DEFAULT_SCOPE).split(/[\s+]+/).filter(Boolean);
    if (scopes.length === 0 || !scopes.every(isScope)) return fail('invalid_scope', `scopes supported: ${SCOPES.join(' ')}`);
    if (q['resource'] && q['resource'] !== `${issuer}/mcp` && q['resource'] !== issuer) return fail('invalid_target', 'unknown resource');

    const id = randomId();
    store.insertAuthRequest({
      id,
      client_id: client.client_id,
      redirect_uri: redirectUri,
      state: q['state'] ?? null,
      scope: [...new Set(scopes)].join(' '),
      code_challenge: q['code_challenge'],
      code_challenge_method: 'S256',
      resource: q['resource'] ?? null,
      expires_at: now() + cfg.AUTH_REQUEST_TTL_SECONDS,
    });
    return c.redirect(consentUrl(deps, id), 302);
  });

  // The Roundcube plugin sends the browser here after consent.
  app.get('/oauth/callback', (c) => {
    const q = c.req.query();
    const ar = q['req'] ? store.getAuthRequest(q['req']) : undefined;
    if (!ar) return c.text('unknown or expired authorization request', 400);
    if (q['error']) {
      if (ar.status === 'pending') store.setAuthRequestStatus(ar.id, 'denied');
      return c.redirect(withQuery(ar.redirect_uri, { error: 'access_denied', error_description: 'The user denied the request', state: ar.state }), 302);
    }
    const code = q['code'];
    if (!code || ar.status !== 'approved' || !ar.code_hash || !constantTimeEqual(sha256Hex(code), ar.code_hash)) {
      return c.text('invalid authorization code for this request', 400);
    }
    return c.redirect(withQuery(ar.redirect_uri, { code, state: ar.state }), 302);
  });

  app.post('/oauth/token', async (c) => {
    const body = await readBody(c).catch(() => ({}) as Record<string, unknown>);
    const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : undefined);

    // --- client authentication
    let clientId = str('client_id');
    let clientSecret = str('client_secret');
    const auth = c.req.header('authorization');
    if (auth?.toLowerCase().startsWith('basic ')) {
      const [u, p] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':', 2);
      clientId = decodeURIComponent(u ?? '');
      clientSecret = decodeURIComponent(p ?? '');
    }
    const client = clientId ? store.getClient(clientId) : undefined;
    if (!client) {
      const e = oauthError(401, 'invalid_client', 'unknown client');
      return c.json(e.body, e.status);
    }
    if (client.token_endpoint_auth_method !== 'none') {
      if (!clientSecret || !client.client_secret_hash || !constantTimeEqual(sha256Hex(clientSecret), client.client_secret_hash)) {
        const e = oauthError(401, 'invalid_client', 'client authentication failed');
        return c.json(e.body, e.status);
      }
    }

    const grantType = str('grant_type');
    if (grantType === 'authorization_code') {
      const code = str('code');
      const ar = code ? store.getAuthRequestByCodeHash(sha256Hex(code)) : undefined;
      if (!ar || ar.status !== 'approved' || !ar.grant_id) return c.json(oauthError(400, 'invalid_grant', 'unknown or used code').body, 400);
      if ((ar.code_expires_at ?? 0) < now()) return c.json(oauthError(400, 'invalid_grant', 'code expired').body, 400);
      if (ar.client_id !== client.client_id) return c.json(oauthError(400, 'invalid_grant', 'code was issued to another client').body, 400);
      const redirectUri = str('redirect_uri');
      if (!redirectUri || redirectUri !== ar.redirect_uri) return c.json(oauthError(400, 'invalid_grant', 'redirect_uri mismatch').body, 400);
      if (!verifyPkce(str('code_verifier'), ar.code_challenge, ar.code_challenge_method)) return c.json(oauthError(400, 'invalid_grant', 'PKCE verification failed').body, 400);
      if (!store.consumeAuthRequest(ar.id)) return c.json(oauthError(400, 'invalid_grant', 'code already used').body, 400);
      const grant = store.getGrant(ar.grant_id);
      if (!grant || grant.revoked_at) return c.json(oauthError(400, 'invalid_grant', 'grant revoked').body, 400);
      const access = await tokens.issueAccessToken(grant);
      const refresh = tokens.issueRefreshToken(grant);
      log.info({ grantId: grant.id, clientId: client.client_id }, 'tokens issued');
      return c.json({ access_token: access.token, token_type: 'Bearer', expires_in: access.expiresIn, refresh_token: refresh, scope: grant.scopes.join(' ') });
    }

    if (grantType === 'refresh_token') {
      const rt = str('refresh_token');
      const resolved = rt ? tokens.resolveRefreshToken(rt) : undefined;
      if (!resolved) return c.json(oauthError(400, 'invalid_grant', 'refresh token invalid, expired or revoked').body, 400);
      if (resolved.grant.client_id !== client.client_id) return c.json(oauthError(400, 'invalid_grant', 'refresh token belongs to another client').body, 400);
      store.revokeToken(resolved.hash);
      const access = await tokens.issueAccessToken(resolved.grant);
      const refresh = tokens.issueRefreshToken(resolved.grant);
      return c.json({ access_token: access.token, token_type: 'Bearer', expires_in: access.expiresIn, refresh_token: refresh, scope: resolved.grant.scopes.join(' ') });
    }

    return c.json(oauthError(400, 'unsupported_grant_type', 'use authorization_code or refresh_token').body, 400);
  });

  // RFC 7009. Revoking any token disconnects the whole grant (all its tokens).
  app.post('/oauth/revoke', async (c) => {
    const body = await readBody(c).catch(() => ({}) as Record<string, unknown>);
    const token = typeof body['token'] === 'string' ? (body['token'] as string) : undefined;
    if (token) {
      const row = store.getToken(sha256Hex(token));
      if (row) store.revokeGrant(row.grant_id);
      else {
        const p = await tokens.authenticate(token);
        if (p) store.revokeGrant(p.grantId);
      }
    }
    return c.body(null, 200);
  });

  return app;
}
