import { Hono } from 'hono';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { SCOPES, isScope } from '../config.js';
import { now, TLS_MODES, isLoopbackHost, isAlias, defaultAlias, type TlsMode } from '../store/db.js';
import { constantTimeEqual, randomId, randomToken, sha256Hex } from '../crypto/seal.js';
import { randomInt } from 'node:crypto';
import { redirectHost } from '../oauth/routes.js';

/** Facts about one mailbox as sent by the plugin (no scopes). */
const mailboxFacts = z.object({
  username: z.string().min(1).max(320),
  email: z.string().email().max(320).optional(),
  imap_host: z.string().min(1).optional(),
  imap_port: z.coerce.number().int().min(1).max(65535).optional(),
  imap_tls: z.enum(TLS_MODES as [string, ...string[]]).optional(),
  smtp_tls: z.enum(TLS_MODES as [string, ...string[]]).optional(),
  smtp_host: z.string().min(1).optional(),
  smtp_port: z.coerce.number().int().min(1).max(65535).optional(),
  sealed: z.string().min(64), // base64 of ≥ 48 bytes
});
const mailboxSchema = mailboxFacts.extend({ scopes: z.array(z.string()).min(1) });

/** Link codes (ADR-002): LINK-XXXX-XXXX from an alphabet without look-alike characters. */
const LINK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LINK_CODE_TTL_SECONDS = 600;
const MAX_ACTIVE_LINK_CODES = 5;
export function newLinkCode(): string {
  const group = () => Array.from({ length: 4 }, () => LINK_ALPHABET[randomInt(LINK_ALPHABET.length)]).join('');
  return `LINK-${group()}-${group()}`;
}
/** Canonical form used for hashing: uppercase, no separators, no LINK prefix. */
export function normalizeLinkCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^LINK/, '');
}

/** Resolves the TLS mode for a mail host, refusing plaintext to anything but loopback. */
function tlsFor(requested: string | undefined, host: string, fallback: TlsMode): TlsMode | undefined {
  const mode = (requested as TlsMode | undefined) ?? fallback;
  if (mode === 'none' && !isLoopbackHost(host)) return undefined;
  return mode;
}

function decodeSealed(b64: string): Uint8Array | undefined {
  const buf = Buffer.from(b64, 'base64');
  return buf.length >= 48 ? new Uint8Array(buf) : undefined;
}

type MailboxInput = z.infer<typeof mailboxFacts>;
type ResolvedMailbox = { imap_host: string; imap_port: number; imap_tls: TlsMode; smtp_host: string; smtp_port: number; smtp_tls: TlsMode; sealed: Uint8Array };

/** Applies server defaults and the loopback-only plaintext rule. Returns an error code when refused. */
function resolveMailbox(cfg: Deps['cfg'], b: MailboxInput): { ok: true; value: ResolvedMailbox } | { ok: false; error: string; detail: string } {
  const sealed = decodeSealed(b.sealed);
  if (!sealed) return { ok: false, error: 'invalid_sealed', detail: 'sealed box too short' };
  const imapHost = b.imap_host ?? cfg.IMAP_HOST;
  const smtpHost = b.smtp_host ?? cfg.SMTP_HOST;
  const imapTls = tlsFor(b.imap_tls, imapHost, cfg.IMAP_TLS ? 'implicit' : 'none');
  const smtpTls = tlsFor(b.smtp_tls, smtpHost, cfg.SMTP_STARTTLS ? 'starttls' : 'none');
  if (!imapTls || !smtpTls) return { ok: false, error: 'tls_required', detail: 'plaintext IMAP/SMTP is only allowed to loopback hosts' };
  return { ok: true, value: { imap_host: imapHost, imap_port: b.imap_port ?? cfg.IMAP_PORT, imap_tls: imapTls, smtp_host: smtpHost, smtp_port: b.smtp_port ?? cfg.SMTP_PORT, smtp_tls: smtpTls, sealed } };
}

const accountView = (a: { id: string; alias: string; username: string; email: string | null; is_primary: boolean; created_at: number; last_used_at: number | null }) => ({
  id: a.id, alias: a.alias, username: a.username, email: a.email ?? a.username, primary: a.is_primary, created_at: a.created_at, last_used_at: a.last_used_at,
});

export function internalRoutes(deps: Deps): Hono {
  const { cfg, store, tokens, log } = deps;
  const app = new Hono();

  app.use('*', async (c, next) => {
    const key = c.req.header('x-internal-key') ?? '';
    if (!key || !constantTimeEqual(key, cfg.INTERNAL_KEY)) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });

  app.get('/healthz', (c) => c.json({ ok: true, keysLoaded: Boolean(deps.keys), scopes: [...SCOPES] }));

  app.get('/auth-requests/:id', (c) => {
    const ar = store.getAuthRequest(c.req.param('id'));
    if (!ar) return c.json({ error: 'not_found' }, 404);
    const client = store.getClient(ar.client_id);
    const expired = ar.expires_at < now();
    return c.json({
      id: ar.id,
      status: expired && ar.status === 'pending' ? 'expired' : ar.status,
      client_name: client?.client_name ?? 'Unknown client',
      client_id: ar.client_id,
      // Shown on the consent screen so the user can spot a client_name that does not match where tokens go.
      redirect_host: redirectHost(ar.redirect_uri),
      scopes: ar.scope.split(' '),
      expires_at: ar.expires_at,
    });
  });

  // Called by the Roundcube plugin when the user approves the consent screen.
  app.post('/grants', async (c) => {
    const parsed = mailboxSchema.extend({ request_id: z.string().min(1) }).safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.issues[0]?.message }, 400);
    const b = parsed.data;
    const ar = store.getAuthRequest(b.request_id);
    if (!ar || ar.status !== 'pending') return c.json({ error: 'request_not_pending' }, 409);
    if (ar.expires_at < now()) {
      store.setAuthRequestStatus(ar.id, 'expired');
      return c.json({ error: 'request_expired' }, 410);
    }
    const requested = new Set(ar.scope.split(' '));
    const scopes = [...new Set(b.scopes)].filter(isScope);
    if (scopes.length === 0 || !scopes.every((s) => requested.has(s))) return c.json({ error: 'invalid_scopes', detail: 'granted scopes must be a non-empty subset of requested scopes' }, 400);
    const mb = resolveMailbox(cfg, b);
    if (!mb.ok) return c.json({ error: mb.error, detail: mb.detail }, 400);

    const grant = store.insertGrant({ id: randomId(), kind: 'oauth', username: b.username, email: b.email ?? null, ...mb.value, scopes, client_id: ar.client_id, label: null });
    const code = randomToken(32);
    store.approveAuthRequest(ar.id, grant.id, sha256Hex(code), now() + cfg.CODE_TTL_SECONDS);
    log.info({ grantId: grant.id, username: b.username, scopes }, 'grant created via consent');
    return c.json({ code, grant_id: grant.id, callback: `${cfg.PUBLIC_URL}/oauth/callback?req=${encodeURIComponent(ar.id)}&code=${encodeURIComponent(code)}` }, 201);
  });

  // Personal access tokens for CLI clients, created from Roundcube settings.
  app.post('/pats', async (c) => {
    const parsed = mailboxSchema.extend({ label: z.string().trim().min(1).max(80).default('CLI token') }).safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.issues[0]?.message }, 400);
    const b = parsed.data;
    const scopes = [...new Set(b.scopes)].filter(isScope);
    if (scopes.length === 0) return c.json({ error: 'invalid_scopes' }, 400);
    const mb = resolveMailbox(cfg, b);
    if (!mb.ok) return c.json({ error: mb.error, detail: mb.detail }, 400);
    const grant = store.insertGrant({ id: randomId(), kind: 'pat', username: b.username, email: b.email ?? null, ...mb.value, scopes, client_id: null, label: b.label });
    const token = tokens.issuePat(grant);
    log.info({ grantId: grant.id, username: b.username, scopes }, 'PAT created');
    return c.json({ token, grant_id: grant.id, scopes }, 201);
  });

  app.get('/grants', (c) => {
    const user = c.req.query('user');
    if (!user) return c.json({ error: 'user required' }, 400);
    return c.json(
      store.listGrantsForUser(user).map((g) => ({
        id: g.id,
        kind: g.kind,
        client_name: g.kind === 'pat' ? g.label : g.client_name,
        scopes: g.scopes,
        created_at: g.created_at,
        last_used_at: g.last_used_at,
        accounts: store.listAccounts(g.id).map(accountView),
      })),
    );
  });

  // ---- ADR-002: several mailboxes per grant

  // Step 1 (grant owner, logged in as the primary mailbox): mint a one-time link code.
  app.post('/link-codes', async (c) => {
    const parsed = z.object({ grant_id: z.string().min(1), user: z.string().min(1) }).safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
    const g = store.getGrant(parsed.data.grant_id);
    if (!g || g.revoked_at || g.username !== parsed.data.user) return c.json({ error: 'not_found' }, 404);
    if (store.countActiveLinkCodes(g.id) >= MAX_ACTIVE_LINK_CODES) return c.json({ error: 'too_many_codes', detail: `at most ${MAX_ACTIVE_LINK_CODES} unused codes per connection; wait for them to expire` }, 429);
    const code = newLinkCode();
    const expires_at = now() + LINK_CODE_TTL_SECONDS;
    store.insertLinkCode({ hash: sha256Hex(normalizeLinkCode(code)), grant_id: g.id, created_by: g.username, expires_at });
    log.info({ grantId: g.id, username: g.username }, 'link code created');
    return c.json({ code, expires_at, suggested_alias_rule: 'brand label of the mail domain' }, 201);
  });

  // Preview for the join screen: which connection does this code belong to? (does not consume the code)
  app.get('/link-codes/:code', (c) => {
    const lc = store.getLinkCode(sha256Hex(normalizeLinkCode(c.req.param('code'))));
    const g = lc ? store.getGrant(lc.grant_id) : undefined;
    if (!lc || !g || g.revoked_at) return c.json({ error: 'not_found' }, 404);
    if (lc.used_at) return c.json({ error: 'code_used' }, 410);
    if (lc.expires_at < now()) return c.json({ error: 'code_expired' }, 410);
    const client = g.client_id ? store.getClient(g.client_id) : undefined;
    return c.json({ client_name: g.kind === 'pat' ? g.label : client?.client_name ?? 'Unknown client', kind: g.kind, scopes: g.scopes, primary: g.email ?? g.username, expires_at: lc.expires_at, suggested_alias: null });
  });

  // Step 2 (logged in as the other mailbox): redeem the code with that mailbox's sealed password.
  app.post('/link-codes/redeem', async (c) => {
    const parsed = mailboxFacts.extend({ code: z.string().min(8).max(40), alias: z.string().trim().min(1).max(32).optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.issues[0]?.message }, 400);
    const b = parsed.data;
    const hash = sha256Hex(normalizeLinkCode(b.code));
    const lc = store.getLinkCode(hash);
    const g = lc ? store.getGrant(lc.grant_id) : undefined;
    if (!lc || !g || g.revoked_at) return c.json({ error: 'code_invalid' }, 404);
    if (lc.used_at) return c.json({ error: 'code_used' }, 410);
    if (lc.expires_at < now()) return c.json({ error: 'code_expired' }, 410);
    const alias = (b.alias ?? defaultAlias(b.username, b.email ?? null)).toLowerCase();
    if (!isAlias(alias)) return c.json({ error: 'invalid_alias', detail: 'use 1-32 lowercase letters, digits, - or _' }, 400);
    if (store.listAccounts(g.id).some((a) => a.username === b.username)) return c.json({ error: 'already_linked', detail: 'this mailbox is already part of that connection' }, 409);
    // An alias the user typed must be free; a derived default is deduplicated by insertAccount instead.
    if (b.alias && store.getAccountByAlias(g.id, alias)) return c.json({ error: 'alias_taken' }, 409);
    const mb = resolveMailbox(cfg, b);
    if (!mb.ok) return c.json({ error: mb.error, detail: mb.detail }, 400);

    let account;
    try {
      account = store.transaction(() => {
        if (!store.useLinkCode(hash)) throw new Error('code_race');
        return store.insertAccount({ grant_id: g.id, alias, username: b.username, email: b.email ?? null, ...mb.value, is_primary: false });
      });
    } catch (e) {
      if (e instanceof Error && e.message === 'code_race') return c.json({ error: 'code_used' }, 410);
      throw e;
    }
    const client = g.client_id ? store.getClient(g.client_id) : undefined;
    log.info({ grantId: g.id, accountId: account.id, username: b.username, alias }, 'mailbox linked');
    return c.json({ account_id: account.id, alias: account.alias, client_name: g.kind === 'pat' ? g.label : client?.client_name ?? 'Unknown client', primary: g.email ?? g.username, scopes: g.scopes }, 201);
  });

  // Connections that other mailboxes linked this user into (shown on the user's own settings page).
  app.get('/links', (c) => {
    const user = c.req.query('user');
    if (!user) return c.json({ error: 'user required' }, 400);
    return c.json(
      store.listLinkedAccountsForUser(user).map((a) => ({
        id: a.id,
        alias: a.alias,
        grant_id: a.grant_id,
        client_name: a.grant_kind === 'pat' ? a.grant_label : a.client_name,
        primary: a.primary_email ?? a.primary_username,
        created_at: a.created_at,
        last_used_at: a.last_used_at,
      })),
    );
  });

  // Unlink: allowed to the linked mailbox itself and to the grant owner. Primary accounts cannot be unlinked (revoke instead).
  app.delete('/accounts/:id', async (c) => {
    const a = store.getAccount(c.req.param('id'));
    const user = c.req.query('user');
    const g = a ? store.getGrant(a.grant_id) : undefined;
    if (!a || !g || a.revoked_at || !user || (user !== a.username && user !== g.username)) return c.json({ error: 'not_found' }, 404);
    if (a.is_primary) return c.json({ error: 'primary_account', detail: 'revoke the connection instead' }, 400);
    const ok = store.revokeAccount(a.id);
    if (ok) {
      await deps.pool?.invalidateAccount(a.id);
      log.info({ grantId: g.id, accountId: a.id, username: a.username, by: user }, 'mailbox unlinked');
    }
    return c.json({ unlinked: ok });
  });

  app.delete('/grants/:id', (c) => {
    const g = store.getGrant(c.req.param('id'));
    const user = c.req.query('user');
    if (!g || (user && g.username !== user)) return c.json({ error: 'not_found' }, 404);
    const ok = store.revokeGrant(g.id);
    if (ok) log.info({ grantId: g.id, username: g.username }, 'grant revoked');
    return c.json({ revoked: ok });
  });

  app.get('/audit', (c) => {
    const user = c.req.query('user');
    if (!user) return c.json({ error: 'user required' }, 400);
    const limit = Number(c.req.query('limit') ?? 100);
    return c.json(store.listAuditForUser(user, Number.isFinite(limit) ? limit : 100));
  });

  return app;
}
