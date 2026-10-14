import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.string().default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  BIND: z.string().default('127.0.0.1'),
  PUBLIC_URL: z.string().url().transform((u) => u.replace(/\/+$/, '')),
  WEBMAIL_URL: z.string().url().transform((u) => u.replace(/\/+$/, '')),
  DB_PATH: z.string().default(':memory:'),
  KEYS_DIR: z.string().default('./keys'),
  INTERNAL_KEY: z.string().min(32),
  JWT_SECRET: z.string().min(32),
  IMAP_HOST: z.string().default('127.0.0.1'),
  IMAP_PORT: z.coerce.number().int().default(993),
  IMAP_TLS: bool.default(true),
  IMAP_TLS_INSECURE: bool.default(false),
  SMTP_HOST: z.string().default('127.0.0.1'),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_STARTTLS: bool.default(true),
  ATTACHMENT_MAX_BYTES: z.coerce.number().int().default(5 * 1024 * 1024),
  SEND_RATE_PER_HOUR: z.coerce.number().int().default(30),
  DISABLE_SEND: bool.default(false),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().default(3600),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(30),
  AUTH_REQUEST_TTL_SECONDS: z.coerce.number().int().default(600),
  CODE_TTL_SECONDS: z.coerce.number().int().default(120),
  LOG_LEVEL: z.string().default('info'),
  LOG_FILE: z.string().optional(),
  // ADR-003: "all mailboxes" mode. All unset = feature off.
  /** Roundcube logins allowed to switch a connection to server-wide reach (comma separated). */
  ALL_MAILBOXES_ADMINS: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)),
  /** Mail-server master login (Dovecot master user); the connector logs in as `<mailbox><sep><user>`. */
  ALL_MAILBOXES_USER: z.string().trim().min(1).optional(),
  /** File holding the master secret (one line). Read once at boot. */
  ALL_MAILBOXES_SECRET_FILE: z.string().trim().min(1).optional(),
  ALL_MAILBOXES_SEPARATOR: z.string().min(1).max(4).default('*'),
  /** File listing every mailbox login on the server (one per line, optional alias column). */
  MAILBOX_DIRECTORY: z.string().trim().min(1).optional(),
  /** File listing, per mailbox login, the addresses that deliver into it (reply identities). */
  MAILBOX_IDENTITIES: z.string().trim().min(1).optional(),
});

export type Config = z.infer<typeof schema>;

/** True when every setting of the "all mailboxes" mode is present (the secret itself is checked at boot). */
export function allMailboxesConfigured(cfg: Config): boolean {
  return Boolean(cfg.ALL_MAILBOXES_USER && cfg.ALL_MAILBOXES_SECRET_FILE && cfg.MAILBOX_DIRECTORY);
}

export function isAllMailboxesAdmin(cfg: Config, username: string): boolean {
  return cfg.ALL_MAILBOXES_ADMINS.includes(username.trim().toLowerCase());
}

/**
 * The server-configured mail endpoint. Virtual (directory) accounts use only this, never a
 * host stored on a grant: a grant's hosts come from the web host and must not be able to
 * redirect the master credential elsewhere.
 */
export function serverMailEndpoint(cfg: Config): { imap_host: string; imap_port: number; imap_tls: 'implicit' | 'none'; smtp_host: string; smtp_port: number; smtp_tls: 'starttls' | 'none' } {
  return {
    imap_host: cfg.IMAP_HOST,
    imap_port: cfg.IMAP_PORT,
    imap_tls: cfg.IMAP_TLS ? 'implicit' : 'none',
    smtp_host: cfg.SMTP_HOST,
    smtp_port: cfg.SMTP_PORT,
    smtp_tls: cfg.SMTP_STARTTLS ? 'starttls' : 'none',
  };
}

export const SCOPES = ['mail:read', 'mail:write', 'mail:send', 'contacts:read'] as const;
export type Scope = (typeof SCOPES)[number];
export const DEFAULT_SCOPE: Scope = 'mail:read';

export function isScope(s: string): s is Scope {
  return (SCOPES as readonly string[]).includes(s);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}

/** Configuration for tests: everything in memory, deterministic secrets. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return loadConfig({
    PUBLIC_URL: 'https://mcp.example.test',
    WEBMAIL_URL: 'https://webmail.example.test',
    INTERNAL_KEY: 'test-internal-key-0123456789abcdef0123456789abcdef',
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef0123456789abcdef0123456789',
    DB_PATH: ':memory:',
    ...Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, String(v)])),
  });
}
