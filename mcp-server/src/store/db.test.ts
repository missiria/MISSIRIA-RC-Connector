import { describe, it, expect } from 'vitest';
import { openStore, now, defaultAlias, MIGRATIONS, Store } from './db.js';
import { DatabaseSync } from 'node:sqlite';

function grantFixture(id: string, username = 'alice@example.test') {
  return {
    id, kind: 'oauth' as const, username, imap_host: 'imap.example.test', imap_port: 993, imap_tls: 'implicit' as const, email: null,
    smtp_host: 'smtp.example.test', smtp_port: 587, smtp_tls: 'starttls' as const, sealed: Buffer.from('sealed'), scopes: ['mail:read' as const],
    client_id: null, label: null,
  };
}

describe('Store', () => {
  it('migrates idempotently', () => {
    const s = openStore(':memory:');
    expect(s.migrate()).toBe(2);
    expect(s.migrate()).toBe(2);
    s.close();
  });

  it('stores clients with redirect uri arrays', () => {
    const s = openStore(':memory:');
    s.insertClient({ client_id: 'c1', client_secret_hash: null, client_name: 'ChatGPT', redirect_uris: ['https://a/cb', 'https://b/cb'], token_endpoint_auth_method: 'none' });
    expect(s.getClient('c1')?.redirect_uris).toEqual(['https://a/cb', 'https://b/cb']);
    expect(s.getClient('nope')).toBeUndefined();
  });

  it('revoking a grant revokes all its tokens', () => {
    const s = openStore(':memory:');
    s.insertGrant(grantFixture('g1'));
    s.insertToken({ hash: 'h1', grant_id: 'g1', kind: 'refresh', expires_at: now() + 100 });
    s.insertToken({ hash: 'h2', grant_id: 'g1', kind: 'pat', expires_at: null });
    expect(s.revokeGrant('g1')).toBe(true);
    expect(s.revokeGrant('g1')).toBe(false);
    expect(s.getToken('h1')?.revoked_at).not.toBeNull();
    expect(s.getToken('h2')?.revoked_at).not.toBeNull();
    expect(s.listGrantsForUser('alice@example.test')).toHaveLength(0);
  });

  it('lists grants per user with client name and parses scopes', () => {
    const s = openStore(':memory:');
    s.insertClient({ client_id: 'c1', client_secret_hash: null, client_name: 'Claude', redirect_uris: ['https://a/cb'], token_endpoint_auth_method: 'none' });
    s.insertGrant({ ...grantFixture('g1'), client_id: 'c1', scopes: ['mail:read', 'mail:send'] });
    s.insertGrant({ ...grantFixture('g2', 'bob@example.test'), kind: 'pat', label: 'laptop' });
    const alice = s.listGrantsForUser('alice@example.test');
    expect(alice).toHaveLength(1);
    expect(alice[0]?.client_name).toBe('Claude');
    expect(alice[0]?.scopes).toEqual(['mail:read', 'mail:send']);
    expect(s.listGrantsForUser('bob@example.test')[0]?.label).toBe('laptop');
  });

  it('auth request approve + consume is single-use', () => {
    const s = openStore(':memory:');
    s.insertClient({ client_id: 'c1', client_secret_hash: null, client_name: 'x', redirect_uris: ['https://a/cb'], token_endpoint_auth_method: 'none' });
    s.insertAuthRequest({ id: 'r1', client_id: 'c1', redirect_uri: 'https://a/cb', state: 's', scope: 'mail:read', code_challenge: 'cc', code_challenge_method: 'S256', resource: null, expires_at: now() + 600 });
    s.insertGrant(grantFixture('g1'));
    s.approveAuthRequest('r1', 'g1', 'codehash', now() + 120);
    expect(() => s.approveAuthRequest('r1', 'g1', 'codehash', now() + 120)).toThrow(/not pending/);
    expect(s.getAuthRequestByCodeHash('codehash')?.id).toBe('r1');
    expect(s.consumeAuthRequest('r1')).toBe(true);
    expect(s.consumeAuthRequest('r1')).toBe(false);
  });

  it('audit list is newest first and capped', () => {
    const s = openStore(':memory:');
    s.insertGrant(grantFixture('g1'));
    for (let i = 0; i < 5; i++) s.insertAudit({ grant_id: 'g1', username: 'alice@example.test', tool: `t${i}`, folder: null, outcome: 'ok', ms: 1, ip: null });
    const rows = s.listAuditForUser('alice@example.test', 3);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.tool).toBe('t4');
  });

  it('reserveSend is atomic and releasable', () => {
    const s = openStore(':memory:');
    s.insertGrant(grantFixture('g1'));
    expect(s.reserveSend('g1', 2)).toBe(true);
    expect(s.reserveSend('g1', 2)).toBe(true);
    expect(s.reserveSend('g1', 2)).toBe(false);
    s.releaseSend('g1');
    expect(s.reserveSend('g1', 2)).toBe(true);
    expect(s.countSendsSince('g1', 0)).toBe(2);
  });

  it('send rate counter', () => {
    const s = openStore(':memory:');
    s.insertGrant(grantFixture('g1'));
    s.recordSend('g1'); s.recordSend('g1');
    expect(s.countSendsSince('g1', now() - 3600)).toBe(2);
    expect(s.countSendsSince('g1', now() + 10)).toBe(0);
  });

  it('ADR-002: insertGrant creates a primary account; aliases derive from the domain and dedupe', () => {
    const s = openStore(':memory:');
    s.insertGrant(grantFixture('g1', 'contact@yazzicars.test'));
    const primary = s.getPrimaryAccount('g1');
    expect(primary).toMatchObject({ alias: 'yazzicars', username: 'contact@yazzicars.test', is_primary: true });
    const linked = s.insertAccount({ grant_id: 'g1', alias: 'yazzicars', username: 'other@yazzicars.test', email: null, imap_host: 'h', imap_port: 993, imap_tls: 'implicit', smtp_host: 'h', smtp_port: 587, smtp_tls: 'starttls', sealed: Buffer.from('x'), is_primary: false });
    expect(linked.alias).toBe('yazzicars-2');
    expect(s.listAccounts('g1').map((a) => a.alias)).toEqual(['yazzicars', 'yazzicars-2']);
    expect(s.getAccountByAlias('g1', 'YAZZICARS-2')?.id).toBe(linked.id);
    expect(s.revokeAccount(primary!.id)).toBe(false); // primary cannot be unlinked
    expect(s.revokeAccount(linked.id)).toBe(true);
    expect(s.listAccounts('g1')).toHaveLength(1);
    s.revokeGrant('g1');
    expect(s.getPrimaryAccount('g1')).toBeUndefined();
  });

  it('ADR-002: defaultAlias picks the brand label', () => {
    expect(defaultAlias('contact@eksneks.com', null)).toBe('eksneks');
    expect(defaultAlias('x', 'sales@mail.example.co.uk')).toBe('example');
    expect(defaultAlias('contact_yazzicars', null)).toBe('contact_yazzicars');
    expect(defaultAlias('Weird Name!!', null)).toBe('weird-name');
    expect(defaultAlias('@@', null)).toBe('mailbox');
  });

  it('ADR-002: migrating a v1 database backfills one primary account per grant', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(MIGRATIONS[0]!);
    db.prepare('INSERT INTO schema_version(version) VALUES (1)').run();
    db.prepare(`INSERT INTO grants(id, kind, username, email, imap_host, imap_port, imap_tls, smtp_host, smtp_port, smtp_tls, sealed, scopes, client_id, label, created_at)
                VALUES ('g1','oauth','contact@eksneks.com','contact@eksneks.com','127.0.0.1',143,'none','mail.eksneks.com',587,'starttls',x'00','mail:read',NULL,NULL,1)`).run();
    db.close();
    // Reopen through the Store on a file-less path is not possible; replay the same steps through a Store on :memory:
    const s = new Store(':memory:');
    s.db.exec(MIGRATIONS[0]!);
    s.db.prepare('INSERT INTO schema_version(version) VALUES (1)').run();
    s.db.prepare(`INSERT INTO grants(id, kind, username, email, imap_host, imap_port, imap_tls, smtp_host, smtp_port, smtp_tls, sealed, scopes, client_id, label, created_at)
                  VALUES ('g1','oauth','contact@eksneks.com','contact@eksneks.com','127.0.0.1',143,'none','mail.eksneks.com',587,'starttls',x'00','mail:read',NULL,NULL,1)`).run();
    expect(s.migrate()).toBe(2);
    expect(s.getPrimaryAccount('g1')).toMatchObject({ alias: 'eksneks', username: 'contact@eksneks.com', imap_tls: 'none', is_primary: true });
    expect(s.migrate()).toBe(2);
    expect(s.listAccounts('g1')).toHaveLength(1);
  });

  it('ADR-002: link codes are single use and expire', () => {
    const s = openStore(':memory:');
    s.insertGrant(grantFixture('g1'));
    s.insertLinkCode({ hash: 'h1', grant_id: 'g1', created_by: 'alice@example.test', expires_at: now() + 600 });
    s.insertLinkCode({ hash: 'h2', grant_id: 'g1', created_by: 'alice@example.test', expires_at: now() - 1 });
    expect(s.countActiveLinkCodes('g1')).toBe(1);
    expect(s.useLinkCode('h1')).toBe(true);
    expect(s.useLinkCode('h1')).toBe(false);
    expect(s.useLinkCode('h2')).toBe(false);
    expect(s.countActiveLinkCodes('g1')).toBe(0);
  });
});
