import type { Deps } from '../deps.js';
import type { AccountRow, GrantRow } from '../store/db.js';
import type { MailClient } from './types.js';
import { MailError } from './types.js';
import { ImapMailbox } from './imap.js';
import { unseal, wipe } from '../crypto/seal.js';

export type MailClientFactory = (account: AccountRow, password: string) => MailClient;

interface Entry {
  client: MailClient;
  lastUsed: number;
  inFlight: number;
}

/**
 * One pooled IMAP session per account (grant + mailbox alias, ADR-002). Credentials are
 * unsealed only while opening a connection and wiped immediately after. Idle sessions
 * close after `idleMs`.
 *
 * ADR-003: a grant flagged `all_mailboxes` may also open any mailbox of the server
 * directory. Such accounts are *virtual* (not stored): the session logs in with the
 * mail-server master credential as `<mailbox><sep><master user>`.
 */
export class SessionPool {
  private readonly entries = new Map<string, Entry>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly deps: Deps,
    private readonly factory: MailClientFactory = defaultFactory(deps),
    private readonly idleMs = 5 * 60 * 1000,
    private readonly maxSessions = 200,
  ) {
    this.timer = setInterval(() => void this.sweep(), 30_000);
    this.timer.unref();
  }

  /** True when this grant reaches every server mailbox (flag set and the mode is configured). */
  reachesAll(grant: GrantRow): boolean {
    return grant.all_mailboxes && Boolean(this.deps.allMailboxes);
  }

  /**
   * Resolves the account a tool call targets: the alias when given, else the grant's primary
   * mailbox. Linked accounts win; with server-wide reach the directory is consulted next (alias,
   * address or bare domain). Throws for revoked grants and unknown aliases (listing the valid ones).
   */
  resolve(grantId: string, alias?: string | null): AccountRow {
    const grant = this.deps.store.getGrant(grantId);
    if (!grant || grant.revoked_at) throw new MailError('imap_auth_failed', 'grant revoked');
    const account = alias ? this.deps.store.getAccountByAlias(grantId, alias) : this.deps.store.getPrimaryAccount(grantId);
    if (account) return account;
    if (!alias) throw new MailError('imap_unavailable', 'this connection has no primary mailbox');
    if (this.reachesAll(grant)) {
      const entry = this.deps.allMailboxes!.directory.resolve(alias);
      if (entry) {
        const linked = this.deps.store.listAccounts(grantId).find((a) => a.username.toLowerCase() === entry.login);
        if (linked) return linked;
        return this.virtualAccount(grant, entry.login, entry.alias);
      }
      throw new MailError('unknown_account', `unknown mailbox "${alias}". This connection reaches every mailbox of the server: call list_accounts and pass one of its aliases (or the full address).`);
    }
    const known = this.deps.store.listAccounts(grantId).map((a) => a.alias);
    throw new MailError('unknown_account', `unknown mailbox alias "${alias}"; linked mailboxes: ${known.join(', ') || 'none'}. Call list_accounts.`);
  }

  /** Every mailbox a grant can target: linked accounts first, then the rest of the server directory. */
  listReachable(grantId: string): AccountRow[] {
    const grant = this.deps.store.getGrant(grantId);
    if (!grant || grant.revoked_at) return [];
    const linked = this.deps.store.listAccounts(grantId);
    if (!this.reachesAll(grant)) return linked;
    const have = new Set(linked.map((a) => a.username.toLowerCase()));
    const extra = this.deps.allMailboxes!.directory.entries().filter((e) => !have.has(e.login)).map((e) => this.virtualAccount(grant, e.login, e.alias));
    return [...linked, ...extra];
  }

  private virtualAccount(grant: GrantRow, login: string, alias: string): AccountRow {
    return {
      id: `${grant.id}:dir:${login}`,
      grant_id: grant.id,
      alias,
      username: login,
      email: login,
      imap_host: grant.imap_host,
      imap_port: grant.imap_port,
      imap_tls: grant.imap_tls,
      smtp_host: grant.smtp_host,
      smtp_port: grant.smtp_port,
      smtp_tls: grant.smtp_tls,
      sealed: new Uint8Array(0),
      is_primary: false,
      created_at: grant.created_at,
      last_used_at: null,
      revoked_at: null,
      virtual: true,
    };
  }

  /** Login name used on the wire for an account: the master form for virtual ones. */
  loginFor(account: AccountRow): string {
    if (!account.virtual) return account.username;
    const { ALL_MAILBOXES_USER: user, ALL_MAILBOXES_SEPARATOR: sep } = this.deps.cfg;
    return `${account.username}${sep}${user}`;
  }

  /** Runs fn with the account's password: the unsealed per-mailbox one, or the master secret for virtual accounts. */
  private async withPassword<T>(account: AccountRow, fn: (password: string) => Promise<T>): Promise<T> {
    if (account.virtual) {
      if (!this.deps.allMailboxes) throw new MailError('imap_unavailable', 'server-wide mailbox access is not configured');
      return fn(this.deps.allMailboxes.masterSecret);
    }
    if (!this.deps.keys) throw new MailError('imap_unavailable', 'server key pair not loaded; run rc-connector keygen');
    const secret = await unseal(account.sealed, this.deps.keys);
    try {
      return await fn(Buffer.from(secret).toString('utf8'));
    } finally {
      wipe(secret);
    }
  }

  async acquire(grantId: string, alias?: string | null): Promise<MailClient> {
    const account = this.resolve(grantId, alias);
    const existing = this.entries.get(account.id);
    if (existing) {
      existing.lastUsed = Date.now();
      existing.inFlight++;
      return existing.client;
    }
    if (this.entries.size >= this.maxSessions) await this.evictOldest();

    const client = await this.withPassword(account, async (password) => this.factory({ ...account, username: this.loginFor(account) }, password));
    const entry: Entry = { client, lastUsed: Date.now(), inFlight: 1 };
    this.entries.set(account.id, entry);
    this.deps.store.touchGrant(grantId);
    if (!account.virtual) this.deps.store.touchAccount(account.id);
    return client;
  }

  /**
   * Runs fn with the credentials for a short-lived use (SMTP submit), wiping them afterwards.
   * `account.username` is the wire login (master form for virtual accounts); `account.email` stays the real address.
   */
  async withSecret<T>(grantId: string, alias: string | null | undefined, fn: (password: string, account: AccountRow) => Promise<T>): Promise<T> {
    const account = this.resolve(grantId, alias);
    return this.withPassword(account, (password) => fn(password, { ...account, username: this.loginFor(account) }));
  }

  release(grantId: string, alias?: string | null): void {
    const e = this.entries.get(this.keyFor(grantId, alias) ?? '');
    if (e) e.inFlight = Math.max(0, e.inFlight - 1);
  }

  /** Drop a session (e.g. after an auth failure, unlink or revoke). */
  async invalidate(grantId: string, alias?: string | null): Promise<void> {
    const key = this.keyFor(grantId, alias);
    if (key) await this.invalidateAccount(key);
  }

  async invalidateAccount(accountId: string): Promise<void> {
    const e = this.entries.get(accountId);
    if (!e) return;
    this.entries.delete(accountId);
    await e.client.close().catch(() => undefined);
  }

  /** Drops every virtual (directory) session of a grant, e.g. when server-wide reach is switched off. */
  async invalidateVirtual(grantId: string): Promise<void> {
    const prefix = `${grantId}:dir:`;
    for (const id of [...this.entries.keys()]) if (id.startsWith(prefix)) await this.invalidateAccount(id);
  }

  get size(): number { return this.entries.size; }

  /** Account id for a grant/alias pair, tolerant of grants revoked mid-call. */
  private keyFor(grantId: string, alias?: string | null): string | undefined {
    try {
      return this.resolve(grantId, alias).id;
    } catch {
      return undefined;
    }
  }

  private async evictOldest(): Promise<void> {
    let oldest: [string, Entry] | undefined;
    for (const kv of this.entries) if (kv[1].inFlight === 0 && (!oldest || kv[1].lastUsed < oldest[1].lastUsed)) oldest = kv;
    if (oldest) await this.invalidateAccount(oldest[0]);
  }

  async sweep(now = Date.now()): Promise<void> {
    for (const [id, e] of this.entries) {
      if (e.inFlight === 0 && now - e.lastUsed > this.idleMs) await this.invalidateAccount(id);
    }
  }

  async closeAll(): Promise<void> {
    clearInterval(this.timer);
    for (const id of [...this.entries.keys()]) await this.invalidateAccount(id);
  }
}

function defaultFactory(deps: Deps): MailClientFactory {
  return (account, password) =>
    new ImapMailbox({
      host: account.imap_host,
      port: account.imap_port,
      tls: account.imap_tls,
      rejectUnauthorized: !deps.cfg.IMAP_TLS_INSECURE,
      user: account.username,
      pass: password,
    });
}
