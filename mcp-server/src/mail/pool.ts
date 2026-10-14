import type { Deps } from '../deps.js';
import type { GrantRow } from '../store/db.js';
import type { MailClient } from './types.js';
import { MailError } from './types.js';
import { ImapMailbox } from './imap.js';
import { unseal, wipe } from '../crypto/seal.js';

export type MailClientFactory = (grant: GrantRow, password: string) => MailClient;

interface Entry {
  client: MailClient;
  lastUsed: number;
  inFlight: number;
}

/**
 * One pooled IMAP session per grant. Credentials are unsealed only while opening a
 * connection and wiped immediately after. Idle sessions close after `idleMs`.
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

  async acquire(grantId: string): Promise<MailClient> {
    const existing = this.entries.get(grantId);
    if (existing) {
      existing.lastUsed = Date.now();
      existing.inFlight++;
      return existing.client;
    }
    const grant = this.deps.store.getGrant(grantId);
    if (!grant || grant.revoked_at) throw new MailError('imap_auth_failed', 'grant revoked');
    if (!this.deps.keys) throw new MailError('imap_unavailable', 'server key pair not loaded; run rc-connector keygen');
    if (this.entries.size >= this.maxSessions) await this.evictOldest();

    const secret = await unseal(grant.sealed, this.deps.keys);
    let client: MailClient;
    try {
      client = this.factory(grant, Buffer.from(secret).toString('utf8'));
    } finally {
      wipe(secret);
    }
    const entry: Entry = { client, lastUsed: Date.now(), inFlight: 1 };
    this.entries.set(grantId, entry);
    this.deps.store.touchGrant(grantId);
    return client;
  }

  /** Unseals the mailbox password for a short-lived use (SMTP submit), wiping it afterwards. */
  async withSecret<T>(grantId: string, fn: (password: string) => Promise<T>): Promise<T> {
    const grant = this.deps.store.getGrant(grantId);
    if (!grant || grant.revoked_at) throw new MailError('imap_auth_failed', 'grant revoked');
    if (!this.deps.keys) throw new MailError('imap_unavailable', 'server key pair not loaded');
    const secret = await unseal(grant.sealed, this.deps.keys);
    try {
      return await fn(Buffer.from(secret).toString('utf8'));
    } finally {
      wipe(secret);
    }
  }

  release(grantId: string): void {
    const e = this.entries.get(grantId);
    if (e) e.inFlight = Math.max(0, e.inFlight - 1);
  }

  /** Drop a session (e.g. after an auth failure or revoke). */
  async invalidate(grantId: string): Promise<void> {
    const e = this.entries.get(grantId);
    if (!e) return;
    this.entries.delete(grantId);
    await e.client.close().catch(() => undefined);
  }

  get size(): number { return this.entries.size; }

  private async evictOldest(): Promise<void> {
    let oldest: [string, Entry] | undefined;
    for (const kv of this.entries) if (kv[1].inFlight === 0 && (!oldest || kv[1].lastUsed < oldest[1].lastUsed)) oldest = kv;
    if (oldest) await this.invalidate(oldest[0]);
  }

  async sweep(now = Date.now()): Promise<void> {
    for (const [id, e] of this.entries) {
      if (e.inFlight === 0 && now - e.lastUsed > this.idleMs) await this.invalidate(id);
    }
  }

  async closeAll(): Promise<void> {
    clearInterval(this.timer);
    for (const id of [...this.entries.keys()]) await this.invalidate(id);
  }
}

function defaultFactory(deps: Deps): MailClientFactory {
  return (grant, password) =>
    new ImapMailbox({
      host: grant.imap_host,
      port: grant.imap_port,
      secure: deps.cfg.IMAP_TLS,
      rejectUnauthorized: !deps.cfg.IMAP_TLS_INSECURE,
      user: grant.username,
      pass: password,
    });
}
