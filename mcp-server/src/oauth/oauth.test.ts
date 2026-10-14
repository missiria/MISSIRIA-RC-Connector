import { describe, it, expect } from 'vitest';
import { makeApp, registerClient, pkcePair, internalHeaders, sealedFor, fullFlow } from '../test/harness.js';

describe('discovery', () => {
  it('serves RFC 8414 and RFC 9728 metadata', async () => {
    const { app } = await makeApp();
    const as = await (await app.request('/.well-known/oauth-authorization-server')).json() as Record<string, unknown>;
    expect(as['issuer']).toBe('https://mcp.example.test');
    expect(as['code_challenge_methods_supported']).toEqual(['S256']);
    const pr = await (await app.request('/.well-known/oauth-protected-resource')).json() as Record<string, unknown>;
    expect(pr['resource']).toBe('https://mcp.example.test/mcp');
    expect(pr['authorization_servers']).toEqual(['https://mcp.example.test']);
  });
});

describe('dynamic client registration', () => {
  it('registers a public client', async () => {
    const { app } = await makeApp();
    const res = await app.request('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'], token_endpoint_auth_method: 'none' }) });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body['client_id']).toBeTypeOf('string');
    expect(body['client_secret']).toBeUndefined();
  });
  it('issues a secret for confidential clients and rejects bad redirect uris', async () => {
    const { app } = await makeApp();
    const ok = await (await app.request('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://x.example/cb'] }) })).json() as Record<string, unknown>;
    expect(ok['client_secret']).toBeTypeOf('string');
    const bad = await app.request('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }) });
    expect(bad.status).toBe(400);
    const loopback = await app.request('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:3333/cb', 'cursor://anysphere.cursor-mcp/oauth/callback'] }) });
    expect(loopback.status).toBe(201);
  });
});

describe('authorization code + PKCE flow', () => {
  it('completes DCR → authorize → consent → callback → token → refresh', async () => {
    const { app, deps } = await makeApp();
    const f = await fullFlow(app, deps, { scopes: ['mail:read', 'mail:send'] });
    expect(f.back.origin + f.back.pathname).toBe('https://ai.example.test/cb');
    expect(f.back.searchParams.get('state')).toBe('xyz');
    expect(f.tokenRes.status).toBe(200);
    expect(f.tokens.scope).toBe('mail:read mail:send');
    expect(f.tokens.expires_in).toBe(3600);

    const principal = await deps.tokens.authenticate(f.tokens.access_token);
    expect(principal?.username).toBe('alice@example.test');
    expect(principal?.scopes).toEqual(['mail:read', 'mail:send']);

    // refresh rotates
    const r = await app.request('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: f.tokens.refresh_token, client_id: f.client.client_id }) });
    expect(r.status).toBe(200);
    const nt = await r.json() as { refresh_token: string };
    expect(nt.refresh_token).not.toBe(f.tokens.refresh_token);
    const replay = await app.request('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: f.tokens.refresh_token, client_id: f.client.client_id }) });
    expect(replay.status).toBe(400);
  });

  it('redirects to the Roundcube consent url with an HMAC signature', async () => {
    const { app, deps } = await makeApp();
    const client = await registerClient(app);
    const { challenge } = pkcePair();
    const res = await app.request(`/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent('https://ai.example.test/cb')}&code_challenge=${challenge}&code_challenge_method=S256`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin).toBe(deps.cfg.WEBMAIL_URL);
    expect(loc.searchParams.get('_task')).toBe('rcconnector');
    expect(loc.searchParams.get('_action')).toBe('consent');
    expect(loc.searchParams.get('sig')).toMatch(/^[0-9a-f]{64}$/);
    const ar = deps.store.getAuthRequest(loc.searchParams.get('req')!);
    expect(ar?.scope).toBe('mail:read');
  });

  it('rejects wrong PKCE verifier, code replay and redirect_uri mismatch', async () => {
    const { app, deps } = await makeApp();
    const client = await registerClient(app);
    const { verifier, challenge } = pkcePair();
    const authz = await app.request(`/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent('https://ai.example.test/cb')}&code_challenge=${challenge}&code_challenge_method=S256`);
    const req = new URL(authz.headers.get('location')!).searchParams.get('req')!;
    const g = await (await app.request('/internal/grants', { method: 'POST', headers: internalHeaders(deps), body: JSON.stringify({ request_id: req, username: 'a@b', sealed: await sealedFor(deps), scopes: ['mail:read'] }) })).json() as { code: string };
    const post = (params: Record<string, string>) => app.request('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
    const base = { grant_type: 'authorization_code', code: g.code, redirect_uri: 'https://ai.example.test/cb', client_id: client.client_id };
    expect((await post({ ...base, code_verifier: verifier + 'bad' })).status).toBe(400);
    expect((await post({ ...base, redirect_uri: 'https://ai.example.test/other', code_verifier: verifier })).status).toBe(400);
    expect((await post({ ...base, code_verifier: verifier })).status).toBe(200);
    expect((await post({ ...base, code_verifier: verifier })).status).toBe(400); // replay
  });

  it('fails without PKCE, with unknown scope, and with unregistered redirect_uri', async () => {
    const { app } = await makeApp();
    const client = await registerClient(app);
    const noPkce = await app.request(`/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent('https://ai.example.test/cb')}&state=s`);
    expect(new URL(noPkce.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
    const { challenge } = pkcePair();
    const badScope = await app.request(`/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent('https://ai.example.test/cb')}&scope=mail:nuke&code_challenge=${challenge}`);
    expect(new URL(badScope.headers.get('location')!).searchParams.get('error')).toBe('invalid_scope');
    const badRedirect = await app.request(`/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&code_challenge=${challenge}`);
    expect(badRedirect.status).toBe(400);
  });

  it('user denial redirects with access_denied', async () => {
    const { app } = await makeApp();
    const client = await registerClient(app);
    const { challenge } = pkcePair();
    const authz = await app.request(`/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent('https://ai.example.test/cb')}&state=st&code_challenge=${challenge}`);
    const req = new URL(authz.headers.get('location')!).searchParams.get('req')!;
    const cb = await app.request(`/oauth/callback?req=${req}&error=access_denied`);
    const loc = new URL(cb.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('st');
  });

  it('confidential clients must authenticate (basic or post)', async () => {
    const { app, deps } = await makeApp();
    const client = await registerClient(app, { token_endpoint_auth_method: 'client_secret_basic' });
    const { verifier, challenge } = pkcePair();
    const authz = await app.request(`/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent('https://ai.example.test/cb')}&code_challenge=${challenge}`);
    const req = new URL(authz.headers.get('location')!).searchParams.get('req')!;
    const g = await (await app.request('/internal/grants', { method: 'POST', headers: internalHeaders(deps), body: JSON.stringify({ request_id: req, username: 'a@b', sealed: await sealedFor(deps), scopes: ['mail:read'] }) })).json() as { code: string };
    const params = new URLSearchParams({ grant_type: 'authorization_code', code: g.code, redirect_uri: 'https://ai.example.test/cb', code_verifier: verifier });
    const noAuth = await app.request('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...Object.fromEntries(params), client_id: client.client_id }) });
    expect(noAuth.status).toBe(401);
    const basic = 'Basic ' + Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64');
    const ok = await app.request('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic }, body: params });
    expect(ok.status).toBe(200);
  });
});

describe('revocation and bearer middleware', () => {
  it('revoke endpoint disconnects the grant; /mcp then returns 401 with resource_metadata', async () => {
    const { app, deps } = await makeApp();
    const f = await fullFlow(app, deps);
    const before = await app.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${f.tokens.access_token}` } });
    expect(before.status).toBe(503); // authenticated, MCP not mounted in this test
    await app.request('/oauth/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: f.tokens.refresh_token }) });
    const after = await app.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${f.tokens.access_token}` } });
    expect(after.status).toBe(401);
    expect(after.headers.get('www-authenticate')).toContain('resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource"');
    const anon = await app.request('/mcp', { method: 'POST' });
    expect(anon.status).toBe(401);
  });
});
