import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
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
  // v2 (ADR-002): several mailboxes per grant. Every grant owns one primary account plus linked ones.
  `
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL REFERENCES grants(id),
    alias TEXT NOT NULL,
    username TEXT NOT NULL,
    email TEXT,
    imap_host TEXT NOT NULL,
    imap_port INTEGER NOT NULL,
    imap_tls TEXT NOT NULL DEFAULT 'implicit',
    smtp_host TEXT NOT NULL,
    smtp_port INTEGER NOT NULL,
    smtp_tls TEXT NOT NULL DEFAULT 'starttls',
    sealed BLOB NOT NULL,
    is_primary INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS accounts_grant ON accounts(grant_id);
  CREATE INDEX IF NOT EXISTS accounts_username ON accounts(username);
  CREATE UNIQUE INDEX IF NOT EXISTS accounts_live_alias ON accounts(grant_id, alias) WHERE revoked_at IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS accounts_live_user ON accounts(grant_id, username) WHERE revoked_at IS NULL;
  CREATE TABLE IF NOT EXISTS link_codes (
    hash TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL REFERENCES grants(id),
    created_by TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS link_codes_grant ON link_codes(grant_id);
  ALTER TABLE audit ADD COLUMN account TEXT;
  `,
  // v3: the login name of the mailbox a call ran against, so linked mailbox owners see activity on their mailbox.
  `
  ALTER TABLE audit ADD COLUMN account_user TEXT;
  CREATE INDEX IF NOT EXISTS audit_account_user_created ON audit(account_user, created_at DESC);
  `,
];

/** Data steps that run right after the SQL of the same version (1-based). */
const DATA_MIGRATIONS: Record<number, (db: DatabaseSync) => void> = {
  // Backfill: every pre-ADR-002 grant becomes its own primary account.
  2: (db) => {
    const grants = db.prepare('SELECT * FROM grants WHERE id NOT IN (SELECT grant_id FROM accounts)').all() as unknown as GrantRow[];
    const insert = db.prepare(
      `INSERT INTO accounts(id, grant_id, alias, username, email, imap_host, imap_port, imap_tls, smtp_host, smtp_port, smtp_tls, sealed, is_primary, created_at, last_used_at, revoked_at)
       VALUES (@id, @grant_id, @alias, @username, @email, @imap_host, @imap_port, @imap_tls, @smtp_host, @smtp_port, @smtp_tls, @sealed, 1, @created_at, @last_used_at, @revoked_at)`,
    );
    for (const g of grants) {
      insert.run({
        id: randomHex(), grant_id: g.id, alias: defaultAlias(g.username, g.email), username: g.username, email: g.email,
        imap_host: g.imap_host, imap_port: g.imap_port, imap_tls: g.imap_tls, smtp_host: g.smtp_host, smtp_port: g.smtp_port, smtp_tls: g.smtp_tls,
        sealed: g.sealed, created_at: g.created_at, last_used_at: g.last_used_at, revoked_at: g.revoked_at,
      });
    }
  },
};

function randomHex(): string {
  return randomBytes(16).toString('hex');
}

/** Mailbox alias used in tool calls: short, lowercase, URL/shell safe. */
export const ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export function isAlias(s: string): boolean {
  return ALIAS_RE.test(s);
}

/**
 * Default alias for a mailbox: the brand label of its domain (contact@yazzicars.com → "yazzicars",
 * sales@mail.example.co.uk → "example"), else a sanitised username.
 */
export function defaultAlias(username: string, email: string | null): string {
  const addr = (email ?? username).toLowerCase();
  let base = addr;
  const at = addr.lastIndexOf('@');
  if (at > 0) {
    const labels = addr.slice(at + 1).split('.').filter(Boolean);
    if (labels.length >= 2) {
      const sld = labels[labels.length - 2]!;
      base = sld.length <= 3 && labels.length >= 3 ? labels[labels.length - 3]! : sld;
    } else base = addr.slice(0, at);
  }
  base = base.replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+/, '').replace(/-+$/, '').slice(0, 32);
  return isAlias(base) ? base : 'mailbox';
}

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

/** One mailbox reachable through a grant (ADR-002). The primary account is created with the grant. */
export interface AccountRow {
  id: string;
  grant_id: string;
  alias: string;
  username: string;
  email: string | null;
  imap_host: string;
  imap_port: number;
  imap_tls: TlsMode;
  smtp_host: string;
  smtp_port: number;
  smtp_tls: TlsMode;
  sealed: Uint8Array;
  is_primary: boolean;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface LinkCodeRow {
  hash: string;
  grant_id: string;
  created_by: string;
  expires_at: number;
  used_at: number | null;
  created_at: number;
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
  /** Mailbox alias the call ran against (null for calls that are not mailbox-bound). */
  account: string | null;
  /** Login name of that mailbox; audit is listed to its owner as well as to the grant owner. */
  account_user: string | null;
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
        DATA_MIGRATIONS[i + 1]?.(this.db);
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
  /** Inserts a grant together with its primary account (same mailbox facts). */
  insertGrant(g: Omit<GrantRow, 'created_at' | 'last_used_at' | 'revoked_at'>, alias?: string): GrantRow {
    const row: GrantRow = { ...g, created_at: now(), last_used_at: null, revoked_at: null };
    return this.transaction(() => {
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
      this.insertAccount({
        grant_id: row.id, alias: alias ?? defaultAlias(row.username, row.email), username: row.username, email: row.email,
        imap_host: row.imap_host, imap_port: row.imap_port, imap_tls: row.imap_tls, smtp_host: row.smtp_host, smtp_port: row.smtp_port, smtp_tls: row.smtp_tls,
        sealed: row.sealed, is_primary: true,
      });
      return row;
    });
  }

  // ---- accounts (ADR-002)
  /** Inserts an account. The alias gets a numeric suffix if it is already taken on this grant. */
  insertAccount(a: Omit<AccountRow, 'id' | 'created_at' | 'last_used_at' | 'revoked_at'>): AccountRow {
    let alias = a.alias;
    for (let n = 2; this.getAccountByAlias(a.grant_id, alias); n++) alias = `${a.alias.slice(0, 29)}-${n}`;
    const row: AccountRow = { ...a, alias, id: randomHex(), created_at: now(), last_used_at: null, revoked_at: null };
    this.db
      .prepare(
        `INSERT INTO accounts(id, grant_id, alias, username, email, imap_host, imap_port, imap_tls, smtp_host, smtp_port, smtp_tls, sealed, is_primary, created_at)
         VALUES (@id, @grant_id, @alias, @username, @email, @imap_host, @imap_port, @imap_tls, @smtp_host, @smtp_port, @smtp_tls, @sealed, @is_primary, @created_at)`,
      )
      .run({
        id: row.id, grant_id: row.grant_id, alias: row.alias, username: row.username, email: row.email, imap_host: row.imap_host, imap_port: row.imap_port,
        imap_tls: row.imap_tls, smtp_host: row.smtp_host, smtp_port: row.smtp_port, smtp_tls: row.smtp_tls, sealed: row.sealed, is_primary: row.is_primary ? 1 : 0, created_at: row.created_at,
      });
    return row;
  }

  private account(r: unknown): AccountRow | undefined {
    const row = r as (Omit<AccountRow, 'is_primary'> & { is_primary: number }) | undefined;
    return row ? { ...row, is_primary: row.is_primary === 1 } : undefined;
  }

  getAccount(id: string): AccountRow | undefined {
    return this.account(this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
  }

  /** Live account of a grant by alias (case-insensitive). */
  getAccountByAlias(grantId: string, alias: string): AccountRow | undefined {
    return this.account(this.db.prepare('SELECT * FROM accounts WHERE grant_id = ? AND alias = ? AND revoked_at IS NULL').get(grantId, alias.toLowerCase()));
  }

  getPrimaryAccount(grantId: string): AccountRow | undefined {
    return this.account(this.db.prepare('SELECT * FROM accounts WHERE grant_id = ? AND is_primary = 1 AND revoked_at IS NULL').get(grantId));
  }

  /** Live accounts of a grant, primary first then by creation. */
  listAccounts(grantId: string): AccountRow[] {
    return (this.db.prepare('SELECT * FROM accounts WHERE grant_id = ? AND revoked_at IS NULL ORDER BY is_primary DESC, created_at ASC').all(grantId) as unknown[])
      .map((r) => this.account(r)!)
      .filter(Boolean);
  }

  /** Non-primary accounts of a user: the connections other mailboxes have linked this one into. */
  listLinkedAccountsForUser(username: string): Array<AccountRow & { client_name: string | null; grant_label: string | null; grant_kind: GrantKind; primary_username: string; primary_email: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT a.*, c.client_name, g.label AS grant_label, g.kind AS grant_kind, g.username AS primary_username, g.email AS primary_email
         FROM accounts a JOIN grants g ON g.id = a.grant_id LEFT JOIN clients c ON c.client_id = g.client_id
         WHERE a.username = ? AND a.is_primary = 0 AND a.revoked_at IS NULL AND g.revoked_at IS NULL ORDER BY a.created_at DESC`,
      )
      .all(username) as unknown as Array<Omit<AccountRow, 'is_primary'> & { is_primary: number; client_name: string | null; grant_label: string | null; grant_kind: GrantKind; primary_username: string; primary_email: string | null }>;
    return rows.map((r) => ({ ...r, is_primary: r.is_primary === 1 }));
  }

  touchAccount(id: string): void {
    this.db.prepare('UPDATE accounts SET last_used_at=? WHERE id=?').run(now(), id);
  }

  /** Unlinks a non-primary account. Returns false if unknown, primary or already revoked. */
  revokeAccount(id: string): boolean {
    return this.db.prepare('UPDATE accounts SET revoked_at=? WHERE id=? AND is_primary = 0 AND revoked_at IS NULL').run(now(), id).changes === 1;
  }

  // ---- link codes (ADR-002)
  insertLinkCode(l: Omit<LinkCodeRow, 'created_at' | 'used_at'>): LinkCodeRow {
    const row: LinkCodeRow = { ...l, used_at: null, created_at: now() };
    this.db
      .prepare('INSERT INTO link_codes(hash, grant_id, created_by, expires_at, created_at) VALUES (@hash, @grant_id, @created_by, @expires_at, @created_at)')
      .run({ hash: row.hash, grant_id: row.grant_id, created_by: row.created_by, expires_at: row.expires_at, created_at: row.created_at });
    return row;
  }

  getLinkCode(hash: string): LinkCodeRow | undefined {
    return this.db.prepare('SELECT * FROM link_codes WHERE hash = ?').get(hash) as LinkCodeRow | undefined;
  }

  /** Marks a code used atomically; false when unknown, expired or already used. */
  useLinkCode(hash: string): boolean {
    return this.db.prepare('UPDATE link_codes SET used_at=? WHERE hash=? AND used_at IS NULL AND expires_at >= ?').run(now(), hash, now()).changes === 1;
  }

  countActiveLinkCodes(grantId: string): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM link_codes WHERE grant_id=? AND used_at IS NULL AND expires_at >= ?').get(grantId, now()) as { n: number };
    return r.n;
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
      this.db.prepare('UPDATE accounts SET revoked_at=? WHERE grant_id=? AND revoked_at IS NULL').run(t, id);
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
  insertAudit(a: Omit<AuditRow, 'id' | 'created_at' | 'account' | 'account_user'> & { account?: string | null; account_user?: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO audit(grant_id, username, tool, folder, outcome, ms, ip, account, account_user, created_at)
         VALUES (@grant_id, @username, @tool, @folder, @outcome, @ms, @ip, @account, @account_user, @created_at)`,
      )
      .run({ ...a, account: a.account ?? null, account_user: a.account_user ?? null, created_at: now() });
  }

  /** Activity the user is entitled to see: calls made through their connections, plus calls that touched their mailbox via a link. */
  listAuditForUser(username: string, limit = 100): AuditRow[] {
    return this.db
      .prepare('SELECT * FROM audit WHERE username = ? OR account_user = ? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(username, username, Math.min(Math.max(limit, 1), 500)) as unknown as AuditRow[];
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
  purge({ auditRetentionDays = 90 } = {}): { auth_requests: number; tokens: number; audit: number; send_log: number; link_codes: number } {
    const t = now();
    const res = this.transaction(() => ({
      auth_requests: Number(this.db.prepare('DELETE FROM auth_requests WHERE expires_at < ? AND status != ?').run(t - 3600, 'approved').changes),
      tokens: Number(this.db.prepare('DELETE FROM tokens WHERE (expires_at IS NOT NULL AND expires_at < ?) OR revoked_at < ?').run(t, t - 86400).changes),
      audit: Number(this.db.prepare('DELETE FROM audit WHERE created_at < ?').run(t - auditRetentionDays * 86400).changes),
      send_log: Number(this.db.prepare('DELETE FROM send_log WHERE created_at < ?').run(t - 2 * 86400).changes),
      link_codes: Number(this.db.prepare('DELETE FROM link_codes WHERE expires_at < ? OR used_at IS NOT NULL').run(t - 3600).changes),
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
