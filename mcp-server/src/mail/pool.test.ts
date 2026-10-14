import { describe, it, expect } from 'vitest';
import { SessionPool } from './pool.js';
import { makeDeps, sealedFor } from '../test/harness.js';
import type { MailClient } from './types.js';
import { MailboxDirectory } from './directory.js';

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

describe('SessionPool — ADR-003 server-wide reach', () => {
  async function depsWithDirectory() {
    const deps = await makeDeps({ ALL_MAILBOXES_USER: 'rccmaster', ALL_MAILBOXES_ADMINS: 'admin@example.test' } as never);
    deps.allMailboxes = { masterSecret: 'master-pw', directory: MailboxDirectory.fromLines(['contact@eksneks.test', 'contact@yazzicars.test', 'billing@eksneks.test']) };
    return deps;
  }

  it('opens directory mailboxes with the master login and never unseals for them', async () => {
    const deps = await depsWithDirectory();
    const opened: Array<[string, string]> = [];
    const pool = new SessionPool(deps, (acc, pass) => { opened.push([acc.username, pass]); return fakeClient(); }, 1000);
    deps.store.insertGrant({ id: 'g1', kind: 'oauth', username: 'admin@example.test', email: null, imap_host: 'h', imap_port: 993, imap_tls: 'implicit', smtp_host: 'h', smtp_port: 587, smtp_tls: 'starttls', sealed: Buffer.from(await sealedFor(deps, 'pw-admin'), 'base64'), scopes: ['mail:read'], client_id: null, label: null, all_mailboxes: true });

    expect(pool.listReachable('g1').map((a) => a.alias)).toEqual(['example', 'eksneks', 'yazzicars', 'eksneks-billing']);
    await pool.acquire('g1');
    await pool.acquire('g1', 'yazzicars');
    await pool.acquire('g1', 'billing@eksneks.test');
    await pool.acquire('g1', 'eksneks.test'); // bare domain → contact@
    expect(opened).toEqual([
      ['admin@example.test', 'pw-admin'],
      ['contact@yazzicars.test*rccmaster', 'master-pw'],
      ['billing@eksneks.test*rccmaster', 'master-pw'],
      ['contact@eksneks.test*rccmaster', 'master-pw'],
    ]);
    expect(pool.size).toBe(4);
    // same virtual mailbox through a different key reuses the session
    await pool.acquire('g1', 'contact@eksneks.test');
    expect(pool.size).toBe(4);
    await pool.withSecret('g1', 'yazzicars', async (pw, acc) => {
      expect(pw).toBe('master-pw');
      expect(acc.username).toBe('contact@yazzicars.test*rccmaster');
      expect(acc.email).toBe('contact@yazzicars.test');
      expect(acc.virtual).toBe(true);
    });
    await expect(pool.acquire('g1', 'ghost')).rejects.toThrow(/every mailbox of the server/);

    // switching off drops the virtual sessions and the directory lookups
    deps.store.setGrantAllMailboxes('g1', false);
    await pool.invalidateVirtual('g1');
    expect(pool.size).toBe(1);
    await expect(pool.acquire('g1', 'yazzicars')).rejects.toThrow(/unknown mailbox alias/);
    await pool.closeAll();
  });

  it('virtual accounts use the server-configured mail endpoint, never the hosts stored on the grant', async () => {
    const deps = await makeDeps({ ALL_MAILBOXES_USER: 'rccmaster', ALL_MAILBOXES_ADMINS: 'admin@example.test', IMAP_HOST: '127.0.0.1', IMAP_PORT: 143, IMAP_TLS: false, SMTP_HOST: 'mail.example.test', SMTP_PORT: 587, SMTP_STARTTLS: true } as never);
    deps.allMailboxes = { masterSecret: 'master-pw', directory: MailboxDirectory.fromLines(['contact@yazzicars.test']) };
    const opened: Array<{ host: string; port: number; tls: string }> = [];
    const pool = new SessionPool(deps, (acc) => { opened.push({ host: acc.imap_host, port: acc.imap_port, tls: acc.imap_tls }); return fakeClient(); }, 1000);
    // a grant whose hosts point elsewhere (as a compromised web host could submit)
    deps.store.insertGrant({ id: 'g1', kind: 'oauth', username: 'admin@example.test', email: null, imap_host: 'evil.example.test', imap_port: 993, imap_tls: 'implicit', smtp_host: 'evil.example.test', smtp_port: 465, smtp_tls: 'implicit', sealed: Buffer.from(await sealedFor(deps, 'pw'), 'base64'), scopes: ['mail:read'], client_id: null, label: null, all_mailboxes: true });
    await pool.acquire('g1', 'yazzicars');
    expect(opened).toEqual([{ host: '127.0.0.1', port: 143, tls: 'none' }]);
    await pool.withSecret('g1', 'yazzicars', async (_pw, acc) => expect(acc).toMatchObject({ smtp_host: 'mail.example.test', smtp_port: 587, smtp_tls: 'starttls' }));
    // the primary (sealed) account keeps its own hosts
    await pool.acquire('g1');
    expect(opened[1]).toEqual({ host: 'evil.example.test', port: 993, tls: 'implicit' });
    await pool.closeAll();
  });

  it('reach ends when the owner is no longer an admin, even with the flag still set', async () => {
    const deps = await makeDeps({ ALL_MAILBOXES_USER: 'rccmaster', ALL_MAILBOXES_ADMINS: 'someone-else@example.test' } as never);
    deps.allMailboxes = { masterSecret: 'master-pw', directory: MailboxDirectory.fromLines(['contact@yazzicars.test']) };
    const pool = new SessionPool(deps, () => fakeClient(), 1000);
    deps.store.insertGrant({ id: 'g1', kind: 'oauth', username: 'admin@example.test', email: null, imap_host: 'h', imap_port: 993, imap_tls: 'implicit', smtp_host: 'h', smtp_port: 587, smtp_tls: 'starttls', sealed: Buffer.from(await sealedFor(deps, 'pw'), 'base64'), scopes: ['mail:read'], client_id: null, label: null, all_mailboxes: true });
    expect(pool.listReachable('g1')).toHaveLength(1);
    await expect(pool.acquire('g1', 'yazzicars')).rejects.toThrow(/unknown mailbox alias/);
    await pool.closeAll();
  });

  it('a linked account wins over the directory entry for the same mailbox', async () => {
    const deps = await depsWithDirectory();
    const opened: string[] = [];
    const pool = new SessionPool(deps, (acc) => { opened.push(acc.username); return fakeClient(); }, 1000);
    deps.store.insertGrant({ id: 'g1', kind: 'oauth', username: 'admin@example.test', email: null, imap_host: 'h', imap_port: 993, imap_tls: 'implicit', smtp_host: 'h', smtp_port: 587, smtp_tls: 'starttls', sealed: Buffer.from(await sealedFor(deps, 'pw-admin'), 'base64'), scopes: ['mail:read'], client_id: null, label: null, all_mailboxes: true });
    deps.store.insertAccount({ grant_id: 'g1', alias: 'yz', username: 'contact@yazzicars.test', email: null, imap_host: 'h', imap_port: 993, imap_tls: 'implicit', smtp_host: 'h', smtp_port: 587, smtp_tls: 'starttls', sealed: Buffer.from(await sealedFor(deps, 'pw-yz'), 'base64'), is_primary: false });
    await pool.acquire('g1', 'yazzicars'); // directory alias → but the mailbox is linked → sealed creds
    expect(opened).toEqual(['contact@yazzicars.test']);
    expect(pool.listReachable('g1').filter((a) => a.username === 'contact@yazzicars.test')).toHaveLength(1);
    await pool.closeAll();
  });

  it('flag without server configuration keeps ADR-002 behaviour', async () => {
    const deps = await makeDeps();
    const pool = new SessionPool(deps, () => fakeClient(), 1000);
    deps.store.insertGrant({ id: 'g1', kind: 'oauth', username: 'admin@example.test', email: null, imap_host: 'h', imap_port: 993, imap_tls: 'implicit', smtp_host: 'h', smtp_port: 587, smtp_tls: 'starttls', sealed: Buffer.from(await sealedFor(deps, 'pw'), 'base64'), scopes: ['mail:read'], client_id: null, label: null, all_mailboxes: true });
    expect(pool.listReachable('g1')).toHaveLength(1);
    await expect(pool.acquire('g1', 'yazzicars')).rejects.toThrow(/linked mailboxes: example/);
    await pool.closeAll();
  });
});
