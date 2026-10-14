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
    const grant = deps.store.insertGrant({ id: 'g1', kind: 'pat', username: 'u@example.test', email: null, imap_host: 'h', imap_port: 993, imap_secure: true, smtp_host: 'h', smtp_port: 587, sealed: Buffer.from(await sealedFor(deps, 'pw-1'), 'base64'), scopes: ['mail:read'], client_id: null, label: null });
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
});
