import { describe, it, expect } from 'vitest';
import { openStore, now } from './db.js';

function grantFixture(id: string, username = 'alice@example.test') {
  return {
    id, kind: 'oauth' as const, username, imap_host: 'imap.example.test', imap_port: 993,
    smtp_host: 'smtp.example.test', smtp_port: 587, sealed: Buffer.from('sealed'), scopes: ['mail:read' as const],
    client_id: null, label: null,
  };
}

describe('Store', () => {
  it('migrates idempotently', () => {
    const s = openStore(':memory:');
    expect(s.migrate()).toBe(1);
    expect(s.migrate()).toBe(1);
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

  it('send rate counter', () => {
    const s = openStore(':memory:');
    s.insertGrant(grantFixture('g1'));
    s.recordSend('g1'); s.recordSend('g1');
    expect(s.countSendsSince('g1', now() - 3600)).toBe(2);
    expect(s.countSendsSince('g1', now() + 10)).toBe(0);
  });
});
