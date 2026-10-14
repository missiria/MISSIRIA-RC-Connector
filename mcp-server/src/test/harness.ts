import type { Hono } from 'hono';
import { testConfig, type Config } from '../config.js';
import { openStore } from '../store/db.js';
import { TokenService } from '../oauth/tokens.js';
import { createLogger } from '../log.js';
import { createApp } from '../app.js';
import type { Deps } from '../deps.js';
import { generateKeyPair, seal } from '../crypto/seal.js';
import { computeS256 } from '../oauth/pkce.js';

export async function makeDeps(overrides: Partial<Config> = {}): Promise<Deps> {
  const cfg = testConfig(overrides);
  const store = openStore(':memory:');
  const keys = await generateKeyPair();
  return { cfg, store, tokens: new TokenService(cfg, store), log: createLogger('silent'), keys };
}

export async function makeApp(overrides: Partial<Config> = {}) {
  const deps = await makeDeps(overrides);
  return { deps, app: createApp(deps) };
}

export const internalHeaders = (deps: Deps) => ({ 'x-internal-key': deps.cfg.INTERNAL_KEY, 'content-type': 'application/json' });

export async function sealedFor(deps: Deps, password = 'imap-pass') {
  return Buffer.from(await seal(password, deps.keys!.publicKey)).toString('base64');
}

export async function registerClient(app: Hono, extra: Record<string, unknown> = {}) {
  const res = await app.request('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test AI', redirect_uris: ['https://ai.example.test/cb'], token_endpoint_auth_method: 'none', ...extra }),
  });
  return (await res.json()) as { client_id: string; client_secret?: string };
}

export const pkcePair = () => {
  const verifier = 'v'.repeat(20) + Math.random().toString(36).slice(2).padEnd(30, 'x');
  return { verifier, challenge: computeS256(verifier) };
};

/** Runs DCR → authorize → consent (as the plugin) → callback → token. Returns tokens and ids. */
export async function fullFlow(app: Hono, deps: Deps, opts: { scopes?: string[]; grantScopes?: string[]; username?: string } = {}) {
  const client = await registerClient(app);
  const { verifier, challenge } = pkcePair();
  const scope = (opts.scopes ?? ['mail:read']).join(' ');
  const authz = await app.request(
    `/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent('https://ai.example.test/cb')}&state=xyz&scope=${encodeURIComponent(scope)}&code_challenge=${challenge}&code_challenge_method=S256`,
  );
  const consent = new URL(authz.headers.get('location')!);
  const req = consent.searchParams.get('req')!;
  const grantRes = await app.request('/internal/grants', {
    method: 'POST',
    headers: internalHeaders(deps),
    body: JSON.stringify({ request_id: req, username: opts.username ?? 'alice@example.test', sealed: await sealedFor(deps), scopes: opts.grantScopes ?? opts.scopes ?? ['mail:read'] }),
  });
  const grant = (await grantRes.json()) as { code: string; grant_id: string };
  const cb = await app.request(`/oauth/callback?req=${req}&code=${encodeURIComponent(grant.code)}`);
  const back = new URL(cb.headers.get('location')!);
  const tokenRes = await app.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, redirect_uri: 'https://ai.example.test/cb', client_id: client.client_id, code_verifier: verifier }),
  });
  const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string; scope: string; expires_in: number };
  return { client, verifier, challenge, req, grant, back, tokenRes, tokens };
}
