import { DatabaseSync } from 'node:sqlite';
import type { Scope } from '../config.js';

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS clients (
    client_id TEXT PRIMARY KEY,
    client_secret_hash TEXT,
    client_name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    token_endpoint_auth_method TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_requests (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clients(client_id),
    redirect_uri TEXT NOT NULL,
    state TEXT,
    scope TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    code_challenge_method TEXT NOT NULL,
    resource TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    grant_id TEXT,
    code_hash TEXT,
    code_expires_at INTEGER,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS auth_requests_code_hash ON auth_requests(code_hash);
  CREATE TABLE IF NOT EXISTS grants (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    username TEXT NOT NULL,
    email TEXT,
    imap_host TEXT NOT NULL,
    imap_port INTEGER NOT NULL,
    imap_tls TEXT NOT NULL DEFAULT 'implicit',
    smtp_host TEXT NOT NULL,
    smtp_port INTEGER NOT NULL,
    smtp_tls TEXT NOT NULL DEFAULT 'starttls',
    sealed BLOB NOT NULL,
    scopes TEXT NOT NULL,
    client_id TEXT,
    label TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS grants_username ON grants(username);
  CREATE TABLE IF NOT EXISTS tokens (
    hash TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL REFERENCES grants(id),
    kind TEXT NOT NULL,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS tokens_grant ON tokens(grant_id);
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    grant_id TEXT NOT NULL,
    username TEXT NOT NULL,
    tool TEXT NOT NULL,
    folder TEXT,
    outcome TEXT NOT NULL,
    ms INTEGER NOT NULL,
    ip TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS audit_username_created ON audit(username, created_at DESC);
  CREATE TABLE IF NOT EXISTS send_log (
    grant_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS send_log_grant_created ON send_log(grant_id, created_at);
  `,
];

export type GrantKind = 'oauth' | 'pat';
/** implicit = TLS on connect (993/465), starttls = upgrade after connect, none = plaintext (loopback only). */
export type TlsMode = 'implicit' | 'starttls' | 'none';
export const TLS_MODES: TlsMode[] = ['implicit', 'starttls', 'none'];

/** Plaintext mail connections are only acceptable to the local host. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.startsWith('127.');
}
export type TokenKind = 'access' | 'refresh' | 'pat';
export type AuthRequestStatus = 'pending' | 'approved' | 'denied' | 'consumed' | 'expired';

export interface ClientRow {
  client_id: string;
  client_secret_hash: string | null;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  created_at: number;
}

export interface AuthRequestRow {
  id: string;
  client_id: string;
  redirect_uri: string;
  state: string | null;
  scope: string;
  code_challenge: string;
  code_challenge_method: string;
  resource: string | null;
  status: AuthRequestStatus;
  grant_id: string | null;
  code_hash: string | null;
  code_expires_at: number | null;
  expires_at: number;
  created_at: number;
}

export interface GrantRow {
  id: string;
  kind: GrantKind;
  username: string;
  /** Primary identity address from Roundcube; falls back to username when null. */
  email: string | null;
  imap_host: string;
  imap_port: number;
  imap_tls: TlsMode;
  smtp_host: string;
  smtp_port: number;
  smtp_tls: TlsMode;
  sealed: Uint8Array;
  scopes: Scope[];
  client_id: string | null;
  label: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface TokenRow {
  hash: string;
  grant_id: string;
  kind: TokenKind;
  expires_at: number | null;
  created_at: number;
  revoked_at: number | null;
}

export interface AuditRow {
  id: number;
  grant_id: string;
  username: string;
  tool: string;
  folder: string | null;
  outcome: string;
  ms: number;
  ip: string | null;
  created_at: number;
}

export const now = (): number => Math.floor(Date.now() / 1000);

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
  }

  /** Runs fn inside BEGIN/COMMIT, rolling back on throw. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  migrate(): number {
    const hasVersion = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get() as { name: string } | undefined;
    let version = 0;
    if (hasVersion) {
      const row = this.db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null };
      version = row.v ?? 0;
    }
    this.transaction(() => {
      for (let i = version; i < MIGRATIONS.length; i++) {
        this.db.exec(MIGRATIONS[i]!);
        this.db.prepare('INSERT INTO schema_version(version) VALUES (?)').run(i + 1);
      }
    });
    return MIGRATIONS.length;
  }

  close(): void {
    this.db.close();
  }

  // ---- clients
  insertClient(c: Omit<ClientRow, 'created_at'>): ClientRow {
    const row = { ...c, created_at: now() };
    this.db
      .prepare(
        `INSERT INTO clients(client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method, created_at)
         VALUES (@client_id, @client_secret_hash, @client_name, @redirect_uris, @token_endpoint_auth_method, @created_at)`,
      )
      .run({ ...row, redirect_uris: JSON.stringify(row.redirect_uris) });
    return row;
  }

  getClient(clientId: string): ClientRow | undefined {
    const r = this.db.prepare('SELECT * FROM clients WHERE client_id = ?').get(clientId) as
      | (Omit<ClientRow, 'redirect_uris'> & { redirect_uris: string })
      | undefined;
    return r ? { ...r, redirect_uris: JSON.parse(r.redirect_uris) as string[] } : undefined;
  }

  // ---- auth requests
  insertAuthRequest(a: Omit<AuthRequestRow, 'created_at' | 'status' | 'grant_id' | 'code_hash' | 'code_expires_at'>): AuthRequestRow {
    const row: AuthRequestRow = { ...a, status: 'pending', grant_id: null, code_hash: null, code_expires_at: null, created_at: now() };
    this.db
      .prepare(
        `INSERT INTO auth_requests(id, client_id, redirect_uri, state, scope, code_challenge, code_challenge_method, resource, status, expires_at, created_at)
         VALUES (@id, @client_id, @redirect_uri, @state, @scope, @code_challenge, @code_challenge_method, @resource, @status, @expires_at, @created_at)`,
      )
      .run({
        id: row.id, client_id: row.client_id, redirect_uri: row.redirect_uri, state: row.state, scope: row.scope,
        code_challenge: row.code_challenge, code_challenge_method: row.code_challenge_method, resource: row.resource,
        status: row.status, expires_at: row.expires_at, created_at: row.created_at,
      });
    return row;
  }

  getAuthRequest(id: string): AuthRequestRow | undefined {
    return this.db.prepare('SELECT * FROM auth_requests WHERE id = ?').get(id) as AuthRequestRow | undefined;
  }

  getAuthRequestByCodeHash(codeHash: string): AuthRequestRow | undefined {
    return this.db.prepare('SELECT * FROM auth_requests WHERE code_hash = ?').get(codeHash) as AuthRequestRow | undefined;
  }

  approveAuthRequest(id: string, grantId: string, codeHash: string, codeExpiresAt: number): void {
    const res = this.db
      .prepare(`UPDATE auth_requests SET status='approved', grant_id=?, code_hash=?, code_expires_at=? WHERE id=? AND status='pending'`)
      .run(grantId, codeHash, codeExpiresAt, id);
    if (res.changes !== 1) throw new Error('auth request is not pending');
  }

  setAuthRequestStatus(id: string, status: AuthRequestStatus): void {
    this.db.prepare('UPDATE auth_requests SET status=? WHERE id=?').run(status, id);
  }

  /** Marks the code consumed atomically; returns false if it was already consumed (replay). */
  consumeAuthRequest(id: string): boolean {
    const res = this.db.prepare(`UPDATE auth_requests SET status='consumed' WHERE id=? AND status='approved'`).run(id);
    return res.changes === 1;
  }

  // ---- grants
  insertGrant(g: Omit<GrantRow, 'created_at' | 'last_used_at' | 'revoked_at'>): GrantRow {
    const row: GrantRow = { ...g, created_at: now(), last_used_at: null, revoked_at: null };
    this.db
      .prepare(
        `INSERT INTO grants(id, kind, username, email, imap_host, imap_port, imap_tls, smtp_host, smtp_port, smtp_tls, sealed, scopes, client_id, label, created_at)
         VALUES (@id, @kind, @username, @email, @imap_host, @imap_port, @imap_tls, @smtp_host, @smtp_port, @smtp_tls, @sealed, @scopes, @client_id, @label, @created_at)`,
      )
      .run({
        id: row.id, kind: row.kind, username: row.username, email: row.email, imap_host: row.imap_host, imap_port: row.imap_port,
        imap_tls: row.imap_tls, smtp_host: row.smtp_host, smtp_tls: row.smtp_tls, smtp_port: row.smtp_port, sealed: row.sealed, scopes: row.scopes.join(' '),
        client_id: row.client_id, label: row.label, created_at: row.created_at,
      });
    return row;
  }

  getGrant(id: string): GrantRow | undefined {
    const r = this.db.prepare('SELECT * FROM grants WHERE id = ?').get(id) as unknown as (Omit<GrantRow, 'scopes'> & { scopes: string }) | undefined;
    return r ? { ...r, scopes: r.scopes.split(' ').filter(Boolean) as Scope[] } : undefined;
  }

  listGrantsForUser(username: string): Array<GrantRow & { client_name: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT g.*, c.client_name FROM grants g LEFT JOIN clients c ON c.client_id = g.client_id
         WHERE g.username = ? AND g.revoked_at IS NULL ORDER BY g.created_at DESC`,
      )
      .all(username) as unknown as Array<Omit<GrantRow, 'scopes'> & { scopes: string; client_name: string | null }>;
    return rows.map((r) => ({ ...r, scopes: r.scopes.split(' ').filter(Boolean) as Scope[] }));
  }

  touchGrant(id: string): void {
    this.db.prepare('UPDATE grants SET last_used_at=? WHERE id=?').run(now(), id);
  }

  /** Revokes the grant and every token attached to it. Returns false if unknown or already revoked. */
  revokeGrant(id: string): boolean {
    const t = now();
    return this.transaction(() => {
      const res = this.db.prepare('UPDATE grants SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(t, id);
      if (res.changes !== 1) return false;
      this.db.prepare('UPDATE tokens SET revoked_at=? WHERE grant_id=? AND revoked_at IS NULL').run(t, id);
      return true;
    });
  }

  // ---- tokens
  insertToken(t: Omit<TokenRow, 'created_at' | 'revoked_at'>): TokenRow {
    const row: TokenRow = { ...t, created_at: now(), revoked_at: null };
    this.db
      .prepare(`INSERT INTO tokens(hash, grant_id, kind, expires_at, created_at) VALUES (@hash, @grant_id, @kind, @expires_at, @created_at)`)
      .run({ hash: row.hash, grant_id: row.grant_id, kind: row.kind, expires_at: row.expires_at, created_at: row.created_at });
    return row;
  }

  getToken(hash: string): TokenRow | undefined {
    return this.db.prepare('SELECT * FROM tokens WHERE hash = ?').get(hash) as TokenRow | undefined;
  }

  revokeToken(hash: string): boolean {
    return this.db.prepare('UPDATE tokens SET revoked_at=? WHERE hash=? AND revoked_at IS NULL').run(now(), hash).changes === 1;
  }

  // ---- audit
  insertAudit(a: Omit<AuditRow, 'id' | 'created_at'>): void {
    this.db
      .prepare(
        `INSERT INTO audit(grant_id, username, tool, folder, outcome, ms, ip, created_at)
         VALUES (@grant_id, @username, @tool, @folder, @outcome, @ms, @ip, @created_at)`,
      )
      .run({ ...a, created_at: now() });
  }

  listAuditForUser(username: string, limit = 100): AuditRow[] {
    return this.db
      .prepare('SELECT * FROM audit WHERE username = ? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(username, Math.min(Math.max(limit, 1), 500)) as unknown as AuditRow[];
  }

  // ---- send rate limiting
  countSendsSince(grantId: string, since: number): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM send_log WHERE grant_id=? AND created_at>=?').get(grantId, since) as { n: number };
    return r.n;
  }

  recordSend(grantId: string): void {
    this.db.prepare('INSERT INTO send_log(grant_id, created_at) VALUES (?, ?)').run(grantId, now());
  }

  /**
   * Atomically reserves a send slot: counts sends in the window and inserts the
   * reservation in one IMMEDIATE transaction, so concurrent calls cannot both pass.
   */
  reserveSend(grantId: string, limitPerWindow: number, windowSeconds = 3600): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const used = this.countSendsSince(grantId, now() - windowSeconds);
      if (used >= limitPerWindow) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.db.prepare('INSERT INTO send_log(grant_id, created_at) VALUES (?, ?)').run(grantId, now());
      this.db.exec('COMMIT');
      return true;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Gives back the most recent reservation (SMTP submit failed). */
  releaseSend(grantId: string): void {
    this.db.prepare('DELETE FROM send_log WHERE rowid = (SELECT rowid FROM send_log WHERE grant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1)').run(grantId);
  }

  // ---- housekeeping
  purge({ auditRetentionDays = 90 } = {}): { auth_requests: number; tokens: number; audit: number; send_log: number } {
    const t = now();
    const res = this.transaction(() => ({
      auth_requests: Number(this.db.prepare('DELETE FROM auth_requests WHERE expires_at < ? AND status != ?').run(t - 3600, 'approved').changes),
      tokens: Number(this.db.prepare('DELETE FROM tokens WHERE (expires_at IS NOT NULL AND expires_at < ?) OR revoked_at < ?').run(t, t - 86400).changes),
      audit: Number(this.db.prepare('DELETE FROM audit WHERE created_at < ?').run(t - auditRetentionDays * 86400).changes),
      send_log: Number(this.db.prepare('DELETE FROM send_log WHERE created_at < ?').run(t - 2 * 86400).changes),
    }));
    this.db.exec('VACUUM');
    return res;
  }
}

export function openStore(path: string): Store {
  const s = new Store(path);
  s.migrate();
  return s;
}
