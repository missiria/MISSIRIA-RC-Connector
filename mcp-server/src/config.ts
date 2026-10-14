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
});

export type Config = z.infer<typeof schema>;

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
