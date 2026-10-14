import { describe, it, expect } from 'vitest';
import { makeApp, internalHeaders, sealedFor, fullFlow, registerClient, pkcePair } from '../test/harness.js';
import { MailboxDirectory } from '../mail/directory.js';
import { newLinkCode, normalizeLinkCode } from './routes.js';

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

  describe('ADR-002 link codes', () => {
    const json = (deps: Awaited<ReturnType<typeof makeApp>>['deps'], body: unknown) => ({ method: 'POST', headers: internalHeaders(deps), body: JSON.stringify(body) });

    it('code format and normalisation', () => {
      const code = newLinkCode();
      expect(code).toMatch(/^LINK-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
      expect(normalizeLinkCode(' link-abcd-ef23 ')).toBe('ABCDEF23');
      expect(normalizeLinkCode('ABCDEF23')).toBe('ABCDEF23');
    });

    it('owner mints a code, the other mailbox redeems it once, both sides see and can unlink the account', async () => {
      const { app, deps } = await makeApp();
      const f = await fullFlow(app, deps, { username: 'contact@eksneks.test' });
      const gid = f.grant.grant_id;

      // only the grant owner can mint
      expect((await app.request('/internal/link-codes', json(deps, { grant_id: gid, user: 'mallory@example.test' }))).status).toBe(404);
      const minted = await app.request('/internal/link-codes', json(deps, { grant_id: gid, user: 'contact@eksneks.test' }));
      expect(minted.status).toBe(201);
      const { code } = await minted.json() as { code: string };

      // preview without consuming
      const preview = await (await app.request(`/internal/link-codes/${code}`, { headers: internalHeaders(deps) })).json() as { client_name: string; primary: string };
      expect(preview).toMatchObject({ client_name: 'Test AI', primary: 'contact@eksneks.test' });

      // the primary mailbox itself cannot be linked again
      const self = await app.request('/internal/link-codes/redeem', json(deps, { code, username: 'contact@eksneks.test', sealed: await sealedFor(deps) }));
      expect(self.status).toBe(409);

      // redeem as the other mailbox (lowercase code with spaces still accepted)
      const redeemed = await app.request('/internal/link-codes/redeem', json(deps, { code: code.toLowerCase().replace(/-/g, ' '), username: 'contact@yazzicars.test', email: 'contact@yazzicars.test', sealed: await sealedFor(deps, 'pw2'), alias: 'Yazzicars' }));
      expect(redeemed.status).toBe(201);
      const acc = await redeemed.json() as { account_id: string; alias: string; client_name: string };
      expect(acc).toMatchObject({ alias: 'yazzicars', client_name: 'Test AI' });

      // single use
      expect((await app.request('/internal/link-codes/redeem', json(deps, { code, username: 'third@example.test', sealed: await sealedFor(deps) }))).status).toBe(410);

      // owner's grant list shows both accounts; the linked user sees the link on their side
      const grants = await (await app.request('/internal/grants?user=contact@eksneks.test', { headers: internalHeaders(deps) })).json() as Array<{ accounts: Array<{ alias: string; primary: boolean }> }>;
      expect(grants[0]!.accounts.map((a) => [a.alias, a.primary])).toEqual([['eksneks', true], ['yazzicars', false]]);
      const links = await (await app.request('/internal/links?user=contact@yazzicars.test', { headers: internalHeaders(deps) })).json() as Array<{ id: string; alias: string; client_name: string; primary: string }>;
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({ alias: 'yazzicars', client_name: 'Test AI', primary: 'contact@eksneks.test' });

      // unlink: strangers 404, primary refused, linked user allowed
      expect((await app.request(`/internal/accounts/${acc.account_id}?user=mallory@example.test`, { method: 'DELETE', headers: internalHeaders(deps) })).status).toBe(404);
      const primaryId = grants[0]!.accounts[0] as unknown as { id: string };
      expect((await app.request(`/internal/accounts/${primaryId.id}?user=contact@eksneks.test`, { method: 'DELETE', headers: internalHeaders(deps) })).status).toBe(400);
      const un = await app.request(`/internal/accounts/${acc.account_id}?user=contact@yazzicars.test`, { method: 'DELETE', headers: internalHeaders(deps) });
      expect(await un.json()).toEqual({ unlinked: true });
      expect(deps.store.listAccounts(gid)).toHaveLength(1);
    });

    it('rejects bad aliases, duplicate aliases, expired codes and caps active codes', async () => {
      const { app, deps } = await makeApp();
      const f = await fullFlow(app, deps, { username: 'owner@example.test' });
      const gid = f.grant.grant_id;
      const mint = async () => (await (await app.request('/internal/link-codes', json(deps, { grant_id: gid, user: 'owner@example.test' }))).json() as { code: string }).code;
      const c1 = await mint();
      expect((await app.request('/internal/link-codes/redeem', json(deps, { code: c1, username: 'b@example.test', sealed: await sealedFor(deps), alias: 'Bad Alias!' }))).status).toBe(400);
      // alias clash with the primary ("example")
      expect((await app.request('/internal/link-codes/redeem', json(deps, { code: c1, username: 'b@example.test', sealed: await sealedFor(deps), alias: 'example' }))).status).toBe(409);
      // default alias dedupes instead of failing when none is supplied
      const ok = await app.request('/internal/link-codes/redeem', json(deps, { code: c1, username: 'b@example.test', sealed: await sealedFor(deps) }));
      expect(ok.status).toBe(201);
      expect(((await ok.json()) as { alias: string }).alias).toBe('example-2');
      // expired
      const c2 = await mint();
      deps.store.db.prepare('UPDATE link_codes SET expires_at = 1').run();
      expect((await app.request('/internal/link-codes/redeem', json(deps, { code: c2, username: 'c@example.test', sealed: await sealedFor(deps) }))).status).toBe(410);
      expect((await app.request(`/internal/link-codes/${c2}`, { headers: internalHeaders(deps) })).status).toBe(410);
      // cap
      for (let i = 0; i < 5; i++) await mint();
      expect((await app.request('/internal/link-codes', json(deps, { grant_id: gid, user: 'owner@example.test' }))).status).toBe(429);
    });
  });
});

describe('internal API — ADR-003 server-wide reach', () => {
  const dirDeps = async (admins = 'admin@example.test') => {
    const { app, deps } = await makeApp({ ALL_MAILBOXES_USER: 'rccmaster', ALL_MAILBOXES_ADMINS: admins } as never);
    deps.allMailboxes = { masterSecret: 'master-pw', directory: MailboxDirectory.fromLines(['contact@eksneks.test', 'contact@yazzicars.test']) };
    return { app, deps };
  };

  it('toggle is owner-only, admin-only and needs the mode configured', async () => {
    const { app, deps } = await dirDeps();
    const f = await fullFlow(app, deps, { username: 'admin@example.test' });
    const other = await fullFlow(app, deps, { username: 'bob@example.test' });
    const h = internalHeaders(deps);
    const post = (id: string, user: string, enabled: boolean) => app.request(`/internal/grants/${id}/all-mailboxes`, { method: 'POST', headers: h, body: JSON.stringify({ user, enabled }) });

    expect((await post(f.grant.grant_id, 'bob@example.test', true)).status).toBe(404); // not the owner
    expect((await post(other.grant.grant_id, 'bob@example.test', true)).status).toBe(403); // owner but not admin
    const on = await post(f.grant.grant_id, 'admin@example.test', true);
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ all_mailboxes: true, directory_count: 2 });
    expect(deps.store.getGrant(f.grant.grant_id)?.all_mailboxes).toBe(true);

    const list = await (await app.request('/internal/grants?user=admin@example.test', { headers: h })).json() as Array<{ all_mailboxes: boolean; all_mailboxes_available: boolean; directory_count: number }>;
    expect(list[0]).toMatchObject({ all_mailboxes: true, all_mailboxes_available: true, directory_count: 2 });
    const bobList = await (await app.request('/internal/grants?user=bob@example.test', { headers: h })).json() as Array<{ all_mailboxes: boolean; all_mailboxes_available: boolean }>;
    expect(bobList[0]).toMatchObject({ all_mailboxes: false, all_mailboxes_available: false });

    expect((await post(f.grant.grant_id, 'admin@example.test', false)).status).toBe(200);
    expect(deps.store.getGrant(f.grant.grant_id)?.all_mailboxes).toBe(false);

    const health = await (await app.request('/internal/healthz', { headers: h })).json() as { allMailboxes: { configured: boolean; count: number } };
    expect(health.allMailboxes).toEqual({ configured: true, count: 2, admins: 1 });
    expect(await (await app.request('/internal/all-mailboxes?user=admin@example.test', { headers: h })).json()).toEqual({ configured: true, available: true, count: 2 });
    expect(await (await app.request('/internal/all-mailboxes?user=bob@example.test', { headers: h })).json()).toEqual({ configured: true, available: false, count: 2 });
  });

  it('consent may enable the mode for admins only; unconfigured servers refuse it', async () => {
    const { app, deps } = await dirDeps();
    const h = internalHeaders(deps);
    const client = await registerClient(app);
    const start = async () => {
      const authz = await app.request(`/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent('https://ai.example.test/cb')}&scope=mail:read&code_challenge=${pkcePair().challenge}&code_challenge_method=S256`);
      return new URL(authz.headers.get('location')!).searchParams.get('req')!;
    };
    const denied = await app.request('/internal/grants', { method: 'POST', headers: h, body: JSON.stringify({ request_id: await start(), username: 'bob@example.test', sealed: await sealedFor(deps), scopes: ['mail:read'], all_mailboxes: true }) });
    expect(denied.status).toBe(403);
    const ok = await app.request('/internal/grants', { method: 'POST', headers: h, body: JSON.stringify({ request_id: await start(), username: 'admin@example.test', sealed: await sealedFor(deps), scopes: ['mail:read'], all_mailboxes: true }) });
    expect(ok.status).toBe(201);
    const { grant_id } = await ok.json() as { grant_id: string };
    expect(deps.store.getGrant(grant_id)?.all_mailboxes).toBe(true);

    const plain = await makeApp();
    const f = await fullFlow(plain.app, plain.deps, { username: 'admin@example.test' });
    const res = await plain.app.request(`/internal/grants/${f.grant.grant_id}/all-mailboxes`, { method: 'POST', headers: internalHeaders(plain.deps), body: JSON.stringify({ user: 'admin@example.test', enabled: true }) });
    expect(res.status).toBe(409);
    expect((await (await plain.app.request('/internal/grants?user=admin@example.test', { headers: internalHeaders(plain.deps) })).json() as Array<{ all_mailboxes_available: boolean }>)[0]?.all_mailboxes_available).toBe(false);
  });
});
