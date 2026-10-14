import { describe, it, expect } from 'vitest';
import { makeApp, internalHeaders, sealedFor, fullFlow } from '../test/harness.js';

describe('internal API', () => {
  it('rejects missing or wrong key', async () => {
    const { app } = await makeApp();
    expect((await app.request('/internal/healthz')).status).toBe(401);
    expect((await app.request('/internal/healthz', { headers: { 'x-internal-key': 'nope' } })).status).toBe(401);
  });

  it('creates a PAT that authenticates and lists under the user, then revokes', async () => {
    const { app, deps } = await makeApp();
    const res = await app.request('/internal/pats', { method: 'POST', headers: internalHeaders(deps), body: JSON.stringify({ username: 'bob@example.test', sealed: await sealedFor(deps), scopes: ['mail:read', 'contacts:read'], label: 'laptop' }) });
    expect(res.status).toBe(201);
    const { token, grant_id } = await res.json() as { token: string; grant_id: string };
    expect(token.startsWith('rcc_')).toBe(true);
    const p = await deps.tokens.authenticate(token);
    expect(p?.kind).toBe('pat');
    expect(p?.scopes).toEqual(['mail:read', 'contacts:read']);

    const list = await (await app.request('/internal/grants?user=bob@example.test', { headers: internalHeaders(deps) })).json() as Array<{ id: string; client_name: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]?.client_name).toBe('laptop');

    const wrongUser = await app.request(`/internal/grants/${grant_id}?user=alice@example.test`, { method: 'DELETE', headers: internalHeaders(deps) });
    expect(wrongUser.status).toBe(404);
    const del = await app.request(`/internal/grants/${grant_id}?user=bob@example.test`, { method: 'DELETE', headers: internalHeaders(deps) });
    expect(await del.json()).toEqual({ revoked: true });
    expect(await deps.tokens.authenticate(token)).toBeUndefined();
  });

  it('grant scopes must be a subset of requested scopes; sealed must be a real box', async () => {
    const { app, deps } = await makeApp();
    const f = await fullFlow(app, deps, { scopes: ['mail:read'] });
    // new request to test rejections
    const authz = await app.request(`/oauth/authorize?response_type=code&client_id=${f.client.client_id}&redirect_uri=${encodeURIComponent('https://ai.example.test/cb')}&scope=mail:read&code_challenge=${f.challenge}`);
    const req = new URL(authz.headers.get('location')!).searchParams.get('req')!;
    const escalate = await app.request('/internal/grants', { method: 'POST', headers: internalHeaders(deps), body: JSON.stringify({ request_id: req, username: 'a@b', sealed: await sealedFor(deps), scopes: ['mail:read', 'mail:send'] }) });
    expect(escalate.status).toBe(400);
    const shortSealed = await app.request('/internal/grants', { method: 'POST', headers: internalHeaders(deps), body: JSON.stringify({ request_id: req, username: 'a@b', sealed: Buffer.from('tooshort').toString('base64'), scopes: ['mail:read'] }) });
    expect(shortSealed.status).toBe(400);
    const info = await (await app.request(`/internal/auth-requests/${req}`, { headers: internalHeaders(deps) })).json() as { status: string; client_name: string; scopes: string[] };
    expect(info.status).toBe('pending');
    expect(info.client_name).toBe('Test AI');
    expect(info.scopes).toEqual(['mail:read']);
    expect((info as unknown as { redirect_host: string }).redirect_host).toBe('ai.example.test');
  });

  it('refuses plaintext mail transport to non-loopback hosts', async () => {
    const { app, deps } = await makeApp();
    const bad = await app.request('/internal/pats', { method: 'POST', headers: internalHeaders(deps), body: JSON.stringify({ username: 'bob@example.test', imap_host: 'imap.example.test', imap_tls: 'none', sealed: await sealedFor(deps), scopes: ['mail:read'] }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('tls_required');
    const ok = await app.request('/internal/pats', { method: 'POST', headers: internalHeaders(deps), body: JSON.stringify({ username: 'bob@example.test', imap_host: 'localhost', imap_tls: 'none', smtp_host: '127.0.0.1', smtp_tls: 'none', sealed: await sealedFor(deps), scopes: ['mail:read'] }) });
    expect(ok.status).toBe(201);
  });

  it('audit endpoint returns rows for the user', async () => {
    const { app, deps } = await makeApp();
    const f = await fullFlow(app, deps);
    deps.store.insertAudit({ grant_id: f.grant.grant_id, username: 'alice@example.test', tool: 'search_messages', folder: 'INBOX', outcome: 'ok', ms: 12, ip: null });
    const rows = await (await app.request('/internal/audit?user=alice@example.test', { headers: internalHeaders(deps) })).json() as Array<{ tool: string }>;
    expect(rows[0]?.tool).toBe('search_messages');
  });
});
