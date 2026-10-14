import { existsSync, readFileSync } from 'node:fs';
import { allMailboxesConfigured, loadConfig, serverMailEndpoint, type Config } from './config.js';
import { createLogger } from './log.js';
import { isLoopbackHost, openStore } from './store/db.js';
import { TokenService } from './oauth/tokens.js';
import { readKeyPair } from './crypto/seal.js';
import { IdentityMap, MailboxDirectory } from './mail/directory.js';
import type { Deps } from './deps.js';
import { join } from 'node:path';

export function buildDeps(env: NodeJS.ProcessEnv = process.env, { requireKeys = true } = {}): Deps {
  const cfg: Config = loadConfig(env);
  const log = createLogger(cfg.LOG_LEVEL, cfg.LOG_FILE);
  const store = openStore(cfg.DB_PATH);
  const tokens = new TokenService(cfg, store);
  const deps: Deps = { cfg, store, tokens, log };
  if (existsSync(join(cfg.KEYS_DIR, 'server.sk'))) {
    deps.keys = readKeyPair(cfg.KEYS_DIR);
  } else if (requireKeys) {
    throw new Error(`No key pair in ${cfg.KEYS_DIR}. Run: rc-connector keygen --out ${cfg.KEYS_DIR}`);
  } else {
    log.warn({ keysDir: cfg.KEYS_DIR }, 'no key pair found; mail tools disabled until keygen runs');
  }
  if (cfg.MAILBOX_IDENTITIES) {
    deps.identities = IdentityMap.fromFile(cfg.MAILBOX_IDENTITIES);
    log.info({ mailboxes: deps.identities.count }, 'reply identities loaded');
  }
  if (allMailboxesConfigured(cfg)) {
    // ADR-003: one server-held credential reaches every mailbox. Loud on purpose.
    const masterSecret = readFileSync(cfg.ALL_MAILBOXES_SECRET_FILE!, 'utf8').replace(/\r?\n$/, '');
    if (!masterSecret) throw new Error(`${cfg.ALL_MAILBOXES_SECRET_FILE} is empty`);
    const directory = MailboxDirectory.fromFile(cfg.MAILBOX_DIRECTORY!);
    // The master credential only ever travels to the configured endpoint; plaintext is loopback-only.
    const ep = serverMailEndpoint(cfg);
    if ((ep.imap_tls === 'none' && !isLoopbackHost(ep.imap_host)) || (ep.smtp_tls === 'none' && !isLoopbackHost(ep.smtp_host))) {
      throw new Error('all-mailboxes mode: IMAP_TLS/SMTP_STARTTLS may only be off for loopback IMAP_HOST/SMTP_HOST');
    }
    deps.allMailboxes = { masterSecret, directory };
    log.warn({ masterUser: cfg.ALL_MAILBOXES_USER, mailboxes: directory.count, admins: cfg.ALL_MAILBOXES_ADMINS }, 'all-mailboxes mode configured: admin connections can reach every mailbox of this server');
  } else if (cfg.ALL_MAILBOXES_USER || cfg.ALL_MAILBOXES_SECRET_FILE || cfg.MAILBOX_DIRECTORY) {
    log.warn('all-mailboxes mode partially configured (need ALL_MAILBOXES_USER, ALL_MAILBOXES_SECRET_FILE and MAILBOX_DIRECTORY); mode disabled');
  }
  return deps;
}
