import type { Config } from './config.js';
import type { Store } from './store/db.js';
import type { TokenService } from './oauth/tokens.js';
import type { Logger } from './log.js';
import type { KeyPair } from './crypto/seal.js';
import type { SessionPool } from './mail/pool.js';
import type { SmtpSender } from './mail/smtp.js';
import type { MailboxDirectory, IdentityMap } from './mail/directory.js';

export interface Deps {
  cfg: Config;
  store: Store;
  tokens: TokenService;
  log: Logger;
  /** Present once keys are loaded; mail tools refuse to run without it. */
  keys?: KeyPair;
  /** IMAP session pool; created at boot (or with a mock factory in tests). */
  pool?: SessionPool;
  /** SMTP submission; NodemailerSender in production, a capture mock in tests. */
  smtp?: SmtpSender;
  /** fetch used for the Roundcube contacts endpoint (injectable for tests). */
  fetch?: typeof fetch;
  /** ADR-003: server-wide mode. Both present only when ALL_MAILBOXES_* and MAILBOX_DIRECTORY are configured. */
  allMailboxes?: { masterSecret: string; directory: MailboxDirectory };
  /** Addresses that deliver into each mailbox (from the MTA alias map); replies may only use these as From. */
  identities?: IdentityMap;
}
