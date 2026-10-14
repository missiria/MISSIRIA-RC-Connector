import type { Deps } from '../deps.js';
import type { AccountRow } from '../store/db.js';
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

  /**
   * Resolves the account a tool call targets: the alias when given, else the grant's primary
   * mailbox. Throws for revoked grants and unknown aliases (listing the valid ones).
   */
  resolve(grantId: string, alias?: string | null): AccountRow {
    const grant = this.deps.store.getGrant(grantId);
    if (!grant || grant.revoked_at) throw new MailError('imap_auth_failed', 'grant revoked');
    const account = alias ? this.deps.store.getAccountByAlias(grantId, alias) : this.deps.store.getPrimaryAccount(grantId);
    if (!account) {
      if (!alias) throw new MailError('imap_unavailable', 'this connection has no primary mailbox');
      const known = this.deps.store.listAccounts(grantId).map((a) => a.alias);
      throw new MailError('unknown_account', `unknown mailbox alias "${alias}"; linked mailboxes: ${known.join(', ') || 'none'}. Call list_accounts.`);
    }
    return account;
  }

  async acquire(grantId: string, alias?: string | null): Promise<MailClient> {
    const account = this.resolve(grantId, alias);
    const existing = this.entries.get(account.id);
    if (existing) {
      existing.lastUsed = Date.now();
      existing.inFlight++;
      return existing.client;
    }
    if (!this.deps.keys) throw new MailError('imap_unavailable', 'server key pair not loaded; run rc-connector keygen');
    if (this.entries.size >= this.maxSessions) await this.evictOldest();

    const secret = await unseal(account.sealed, this.deps.keys);
    let client: MailClient;
    try {
      client = this.factory(account, Buffer.from(secret).toString('utf8'));
    } finally {
      wipe(secret);
    }
    const entry: Entry = { client, lastUsed: Date.now(), inFlight: 1 };
    this.entries.set(account.id, entry);
    this.deps.store.touchGrant(grantId);
    this.deps.store.touchAccount(account.id);
    return client;
  }

  /** Unseals the mailbox password for a short-lived use (SMTP submit), wiping it afterwards. */
  async withSecret<T>(grantId: string, alias: string | null | undefined, fn: (password: string, account: AccountRow) => Promise<T>): Promise<T> {
    const account = this.resolve(grantId, alias);
    if (!this.deps.keys) throw new MailError('imap_unavailable', 'server key pair not loaded');
    const secret = await unseal(account.sealed, this.deps.keys);
    try {
      return await fn(Buffer.from(secret).toString('utf8'), account);
    } finally {
      wipe(secret);
    }
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

  get size(): number { return this.entries.size; }

  /** Account id for a grant/alias pair, tolerant of grants revoked mid-call. */
  private keyFor(grantId: string, alias?: string | null): string | undefined {
    const account = alias ? this.deps.store.getAccountByAlias(grantId, alias) : this.deps.store.getPrimaryAccount(grantId);
    return account?.id;
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
