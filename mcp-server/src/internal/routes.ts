import { Hono } from 'hono';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { SCOPES, isScope } from '../config.js';
import { now, TLS_MODES, isLoopbackHost, type TlsMode } from '../store/db.js';
import { constantTimeEqual, randomId, randomToken, sha256Hex } from '../crypto/seal.js';
import { redirectHost } from '../oauth/routes.js';

const mailboxSchema = z.object({
  username: z.string().min(1).max(320),
  email: z.string().email().max(320).optional(),
  imap_host: z.string().min(1).optional(),
  imap_port: z.coerce.number().int().min(1).max(65535).optional(),
  imap_tls: z.enum(TLS_MODES as [string, ...string[]]).optional(),
  smtp_tls: z.enum(TLS_MODES as [string, ...string[]]).optional(),
  smtp_host: z.string().min(1).optional(),
  smtp_port: z.coerce.number().int().min(1).max(65535).optional(),
  sealed: z.string().min(64), // base64 of ≥ 48 bytes
  scopes: z.array(z.string()).min(1),
});

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
    const sealed = decodeSealed(b.sealed);
    if (!sealed) return c.json({ error: 'invalid_sealed' }, 400);
    const imapHost = b.imap_host ?? cfg.IMAP_HOST;
    const smtpHost = b.smtp_host ?? cfg.SMTP_HOST;
    const imapTls = tlsFor(b.imap_tls, imapHost, cfg.IMAP_TLS ? 'implicit' : 'none');
    const smtpTls = tlsFor(b.smtp_tls, smtpHost, cfg.SMTP_STARTTLS ? 'starttls' : 'none');
    if (!imapTls || !smtpTls) return c.json({ error: 'tls_required', detail: 'plaintext IMAP/SMTP is only allowed to loopback hosts' }, 400);

    const grant = store.insertGrant({
      id: randomId(),
      kind: 'oauth',
      username: b.username,
      email: b.email ?? null,
      imap_host: imapHost,
      imap_port: b.imap_port ?? cfg.IMAP_PORT,
      imap_tls: imapTls,
      smtp_host: smtpHost,
      smtp_port: b.smtp_port ?? cfg.SMTP_PORT,
      smtp_tls: smtpTls,
      sealed,
      scopes,
      client_id: ar.client_id,
      label: null,
    });
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
    const sealed = decodeSealed(b.sealed);
    if (!sealed) return c.json({ error: 'invalid_sealed' }, 400);
    const imapHost = b.imap_host ?? cfg.IMAP_HOST;
    const smtpHost = b.smtp_host ?? cfg.SMTP_HOST;
    const imapTls = tlsFor(b.imap_tls, imapHost, cfg.IMAP_TLS ? 'implicit' : 'none');
    const smtpTls = tlsFor(b.smtp_tls, smtpHost, cfg.SMTP_STARTTLS ? 'starttls' : 'none');
    if (!imapTls || !smtpTls) return c.json({ error: 'tls_required', detail: 'plaintext IMAP/SMTP is only allowed to loopback hosts' }, 400);
    const grant = store.insertGrant({
      id: randomId(),
      kind: 'pat',
      username: b.username,
      email: b.email ?? null,
      imap_host: imapHost,
      imap_port: b.imap_port ?? cfg.IMAP_PORT,
      imap_tls: imapTls,
      smtp_host: smtpHost,
      smtp_port: b.smtp_port ?? cfg.SMTP_PORT,
      smtp_tls: smtpTls,
      sealed,
      scopes,
      client_id: null,
      label: b.label,
    });
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
      })),
    );
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
