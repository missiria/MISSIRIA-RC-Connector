import { describe, it, expect } from 'vitest';
import { SessionPool } from './pool.js';
import { makeDeps, sealedFor } from '../test/harness.js';
import type { MailClient } from './types.js';

function fakeClient(): MailClient & { closed: boolean } {
  const c = { closed: false } as MailClient & { closed: boolean };
  c.close = async () => { c.closed = true; };
  return c;
}

describe('SessionPool', () => {
  it('unseals once per grant, reuses, sweeps idle sessions and refuses revoked grants', async () => {
    const deps = await makeDeps();
    const seen: string[] = [];
    const clients: Array<MailClient & { closed: boolean }> = [];
    const pool = new SessionPool(deps, (_g, pass) => { seen.push(pass); const c = fakeClient(); clients.push(c); return c; }, 1000);
    const grant = deps.store.insertGrant({ id: 'g1', kind: 'pat', username: 'u@example.test', email: null, imap_host: 'h', imap_port: 993, imap_tls: 'implicit', smtp_host: 'h', smtp_port: 587, smtp_tls: 'starttls', sealed: Buffer.from(await sealedFor(deps, 'pw-1'), 'base64'), scopes: ['mail:read'], client_id: null, label: null });
    const a = await pool.acquire(grant.id);
    pool.release(grant.id);
    const b = await pool.acquire(grant.id);
    pool.release(grant.id);
    expect(a).toBe(b);
    expect(seen).toEqual(['pw-1']);
    await pool.sweep(Date.now() + 5000);
    expect(pool.size).toBe(0);
    expect(clients[0]!.closed).toBe(true);
    deps.store.revokeGrant(grant.id);
    await expect(pool.acquire(grant.id)).rejects.toThrow(/revoked/);
    await pool.closeAll();
  });

  it('ADR-002: sessions are keyed per account and unknown aliases are rejected with the known list', async () => {
    const deps = await makeDeps();
    const users: string[] = [];
    const pool = new SessionPool(deps, (acc) => { users.push(acc.username); return fakeClient(); }, 1000);
    deps.store.insertGrant({ id: 'g1', kind: 'pat', username: 'a@example.test', email: null, imap_host: 'h', imap_port: 993, imap_tls: 'implicit', smtp_host: 'h', smtp_port: 587, smtp_tls: 'starttls', sealed: Buffer.from(await sealedFor(deps, 'pw-a'), 'base64'), scopes: ['mail:read'], client_id: null, label: null });
    const linked = deps.store.insertAccount({ grant_id: 'g1', alias: 'brand', username: 'b@brand.test', email: null, imap_host: 'h', imap_port: 993, imap_tls: 'implicit', smtp_host: 'h', smtp_port: 587, smtp_tls: 'starttls', sealed: Buffer.from(await sealedFor(deps, 'pw-b'), 'base64'), is_primary: false });
    await pool.acquire('g1');
    await pool.acquire('g1', 'brand');
    expect(users).toEqual(['a@example.test', 'b@brand.test']);
    expect(pool.size).toBe(2);
    await expect(pool.acquire('g1', 'ghost')).rejects.toThrow(/unknown mailbox alias "ghost".*brand/);
    await pool.withSecret('g1', 'brand', async (pw, acc) => { expect(pw).toBe('pw-b'); expect(acc.id).toBe(linked.id); });
    await pool.invalidateAccount(linked.id);
    expect(pool.size).toBe(1);
    await pool.closeAll();
  });
});
