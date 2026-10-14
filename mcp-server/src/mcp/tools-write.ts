import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './server.js';
import { ToolError, toolError } from './server.js';
import type { Address, OutgoingMessage } from '../mail/types.js';
import { buildRaw } from '../mail/smtp.js';
import { searchContacts } from '../mail/contacts.js';
import { accountArg } from './tools-read.js';
import type { AccountRow } from '../store/db.js';

const folderArg = z.string().min(1).max(500).default('INBOX').describe('IMAP folder path');
const refArg = z.string().max(900).optional().describe('Message handle "alias:folder/uid" as returned on every message; replaces folder + uid and selects the mailbox.');
const uidArg = z.number().int().positive().describe('Message UID within the folder');
const addressArg = z.string().email().max(320);
/** base64 expands 3 bytes to 4 chars (+ padding); cap the string before any decoding happens. */
const base64MaxChars = (maxBytes: number) => Math.ceil(maxBytes / 3) * 4 + 4;
const attachmentArg = (maxBytes: number) =>
  z.object({
    filename: z.string().min(1).max(255),
    mime: z.string().min(3).max(120).default('application/octet-stream'),
    base64: z.string().min(1).max(base64MaxChars(maxBytes)),
  });
const bodyShape = (maxBytes: number) => ({
  subject: z.string().max(998),
  text: z.string().max(500_000).describe('Plain-text body (always required; used as the fallback part)'),
  html: z.string().max(1_000_000).optional().describe('Optional HTML body'),
  attachments: z.array(attachmentArg(maxBytes)).max(10).optional(),
});

const MAX_RECIPIENTS = 25;

/** Sender identity of the mailbox a tool targets: its Roundcube identity, else its login name. */
function senderFor(ctx: ToolContext, account: AccountRow): Address {
  if (account.email) return { name: '', address: account.email };
  const u = account.username;
  const address = u.includes('@') ? u : `${u}@${new URL(ctx.deps.cfg.WEBMAIL_URL).hostname.replace(/^(webmail|mail|imap)\./, '')}`;
  return { name: '', address };
}

/**
 * Sending must never guess the mailbox: when a connection reaches more than one, the caller has
 * to name it (account, from, or a folder prefix on replies). Reading may default to the primary
 * mailbox; a message leaving under the wrong brand cannot be taken back.
 */
function requireExplicitMailbox(ctx: ToolContext, a: { account?: string | undefined }, tool: string): void {
  if (a.account) return;
  const reachable = ctx.deps.pool?.listReachable(ctx.principal.grantId) ?? [];
  if (reachable.length > 1) {
    throw new ToolError('ambiguous_mailbox', `${tool}: this connection reaches ${reachable.length} mailboxes, so say which one sends: pass account (alias, address or domain) or from (the sender address). Call list_accounts to see them. Nothing was sent.`);
  }
}

/** The address a reply should carry: the recipient address in the mailbox's own domain, else the mailbox address. */
export function replyFrom(mailbox: Address, recipients: Address[]): Address {
  const domain = mailbox.address.slice(mailbox.address.lastIndexOf('@') + 1).toLowerCase();
  const hit = recipients.find((r) => r.address.slice(r.address.lastIndexOf('@') + 1).toLowerCase() === domain);
  return hit ? { name: '', address: hit.address } : mailbox;
}

function decodeAttachments(list: Array<{ filename: string; mime: string; base64: string }> | undefined, maxBytes: number) {
  // Estimate from string length first so oversized payloads are rejected before Buffer.from allocates.
  const estimated = (list ?? []).reduce((n, a) => n + Math.floor((a.base64.length * 3) / 4), 0);
  if (estimated > maxBytes) throw new ToolError('too_large', `attachments total about ${estimated} bytes exceed the limit of ${maxBytes}`);
  let total = 0;
  const out = (list ?? []).map((a) => {
    const content = Buffer.from(a.base64, 'base64');
    total += content.length;
    return { filename: a.filename, mime: a.mime, content };
  });
  if (total > maxBytes) throw new ToolError('too_large', `attachments total ${total} bytes exceed the limit of ${maxBytes}`);
  return out;
}

async function submit(ctx: ToolContext, tool: string, msg: OutgoingMessage, alias: string | undefined): Promise<{ messageId: string; recipients: number }> {
  const { deps, principal } = ctx;
  if (deps.cfg.DISABLE_SEND) throw new ToolError('send_disabled', 'Sending is disabled on this server by the administrator (DISABLE_SEND).');
  if (!deps.smtp) throw new ToolError('mail_unavailable', 'SMTP sender not configured');
  const recipients = [...msg.to, ...msg.cc, ...msg.bcc];
  if (recipients.length === 0) throw new ToolError('invalid_argument', 'at least one recipient is required');
  if (recipients.length > MAX_RECIPIENTS) throw new ToolError('invalid_argument', `at most ${MAX_RECIPIENTS} recipients per message`);
  const account = ctx.account(alias);
  const { raw, messageId } = await buildRaw(msg);
  // Reserve the slot atomically (count + insert in one transaction) so parallel calls cannot exceed the limit.
  if (!deps.store.reserveSend(principal.grantId, deps.cfg.SEND_RATE_PER_HOUR)) {
    deps.store.insertAudit({ grant_id: principal.grantId, username: principal.username, tool, folder: null, outcome: 'rate_limited', ms: 0, ip: ctx.ip, account: account.alias, account_user: account.username });
    throw new ToolError('rate_limited', `send limit of ${deps.cfg.SEND_RATE_PER_HOUR} messages per hour reached for this connection`);
  }
  try {
    // `login` is the wire login: the mailbox itself, or the master form for server mailboxes (ADR-003).
    await deps.pool!.withSecret(principal.grantId, alias, (pass, login) =>
      deps.smtp!.send({ host: login.smtp_host, port: login.smtp_port, tls: login.smtp_tls, user: login.username, pass }, raw, { from: msg.from.address, to: recipients.map((r) => r.address) }),
    );
  } catch (e) {
    deps.store.releaseSend(principal.grantId);
    throw e;
  }
  // Copy to Sent; failure here must not be reported as a failed send.
  await ctx.withMail(`${tool}:sent_copy`, null, (m) => m.appendSent(raw), alias).catch(() => undefined);
  return { messageId, recipients: recipients.length };
}

const toAddr = (list: string[] | undefined): Address[] => (list ?? []).map((a) => ({ name: '', address: a }));

export function registerWriteTools(server: McpServer, ctx: ToolContext): void {
  const max = ctx.deps.cfg.ATTACHMENT_MAX_BYTES;
  const body = bodyShape(max);

  server.registerTool(
    'send_message',
    {
      title: 'Send an email',
      description: 'Send a new email (scope mail:send). Confirm recipients and content with the user before calling. A copy is stored in Sent. When the connection reaches several mailboxes you MUST say which one sends: `account` or `from` (the sender address, e.g. contact@iptv-premium-europe.com); the call is refused otherwise.',
      inputSchema: { to: z.array(addressArg).min(1).max(MAX_RECIPIENTS), cc: z.array(addressArg).max(MAX_RECIPIENTS).optional(), bcc: z.array(addressArg).max(MAX_RECIPIENTS).optional(), ...body, from: z.string().max(320).optional().describe('Sender mailbox: its address, alias or domain. Same effect as account.'), account: accountArg },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (raw) => {
      const a = ctx.route(raw);
      try {
        ctx.requireScope('mail:send', 'send_message');
        requireExplicitMailbox(ctx, a, 'send_message');
        const account = ctx.account(a.account);
        const res = await submit(ctx, 'send_message', { from: senderFor(ctx, account), to: toAddr(a.to), cc: toAddr(a.cc), bcc: toAddr(a.bcc), subject: a.subject, text: a.text, html: a.html, attachments: decodeAttachments(a.attachments, max) }, a.account);
        ctx.deps.store.insertAudit({ grant_id: ctx.principal.grantId, username: ctx.principal.username, tool: 'send_message', folder: null, outcome: 'ok', ms: 0, ip: ctx.ip, account: account.alias, account_user: account.username });
        return ctx.ok({ ...res, summary: `Sent "${a.subject}" to ${res.recipients} recipient(s).` }, `Sent "${a.subject}" to ${res.recipients} recipient(s).`);
      } catch (e) { return toolError(e); }
    },
  );

  server.registerTool(
    'reply_message',
    {
      title: 'Reply to an email',
      description: 'Reply to a message (scopes mail:send + mail:read). Pass `ref` exactly as returned on the message by search_messages / get_message: the reply leaves from the mailbox, and the address, that received the message. Sets In-Reply-To/References, quotes the original and marks it answered (no mail:write needed). reply_all includes the original Cc. Without `ref`, give folder + uid and name the mailbox (`account` or folder "alias:INBOX"); refused when ambiguous.',
      inputSchema: { ref: z.string().max(900).optional().describe('Reply handle "alias:folder/uid" as returned on every message. Preferred over folder + uid.'), folder: folderArg, uid: uidArg.optional(), text: body.text, html: body.html, reply_all: z.boolean().default(false), attachments: body.attachments, account: accountArg },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (raw) => {
      const a = ctx.route(raw);
      try {
        ctx.requireScope('mail:send', 'reply_message');
        ctx.requireScope('mail:read', 'reply_message'); // the original is read and partially echoed back
        requireExplicitMailbox(ctx, a, 'reply_message');
        if (a.uid === undefined) return toolError(new ToolError('invalid_argument', 'pass ref (as returned on the message) or folder + uid'));
        const uid = a.uid;
        const account = ctx.account(a.account);
        const original = await ctx.withMail('reply_message:read', a.folder, (m) => m.getMessage(a.folder, uid, { format: 'text', maxChars: 20_000 }), a.account);
        if (!original) return toolError(new ToolError('not_found', `message ${uid} not found in ${a.folder}`));
        // Reply from the address the message was sent to when it belongs to this mailbox's domain
        // (support@/info@ aliases delivered into one mailbox), else from the mailbox itself.
        const from = replyFrom(senderFor(ctx, account), [...original.to, ...original.cc]);
        const mine = new Set([from.address.toLowerCase(), senderFor(ctx, account).address.toLowerCase()]);
        const to = (original.replyTo.length ? original.replyTo : original.from).filter((x) => !mine.has(x.address.toLowerCase()));
        const cc = a.reply_all ? [...original.to, ...original.cc].filter((x) => !mine.has(x.address.toLowerCase()) && !to.some((t) => t.address === x.address)) : [];
        const subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
        const quoted = `${a.text}\n\nOn ${original.date ?? 'unknown date'}, ${original.from.map((f) => f.address).join(', ')} wrote:\n${(original.text ?? '').split('\n').map((l) => `> ${l}`).join('\n')}`;
        const references = [...original.references, ...(original.messageId ? [original.messageId] : [])];
        const res = await submit(ctx, 'reply_message', { from, to: to.length ? to : original.from, cc, bcc: [], subject, text: quoted, html: a.html, inReplyTo: original.messageId ?? undefined, references, attachments: decodeAttachments(a.attachments, max) }, a.account);
        ctx.deps.store.insertAudit({ grant_id: ctx.principal.grantId, username: ctx.principal.username, tool: 'reply_message', folder: a.folder, outcome: 'ok', ms: 0, ip: ctx.ip, account: account.alias, account_user: account.username });
        await ctx.withMail('reply_message:flag', a.folder, (m) => m.setFlags(a.folder, uid, ['answered'], []), a.account).catch(() => undefined);
        return ctx.ok({ ...res, subject, from: from.address, account: account.alias, to: to.map((x) => x.address), cc: cc.map((x) => x.address), summary: `Replied to "${original.subject}" from ${from.address}.` }, `Replied to "${original.subject}" from ${from.address}.`);
      } catch (e) { return toolError(e); }
    },
  );

  server.registerTool(
    'create_draft',
    {
      title: 'Save a draft',
      description: 'Save a message in the Drafts folder without sending it (scope mail:write). The user can finish it in Roundcube.',
      inputSchema: { to: z.array(addressArg).max(MAX_RECIPIENTS).optional(), cc: z.array(addressArg).max(MAX_RECIPIENTS).optional(), ...body, account: accountArg },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (a) => {
      try {
        ctx.requireScope('mail:write', 'create_draft');
        const { raw } = await buildRaw({ from: senderFor(ctx, ctx.account(a.account)), to: toAddr(a.to), cc: toAddr(a.cc), bcc: [], subject: a.subject, text: a.text, html: a.html, attachments: decodeAttachments(a.attachments, max) });
        const res = await ctx.withMail('create_draft', null, (m) => m.appendDraft(raw), a.account);
        return ctx.ok({ ...res, summary: `Draft "${a.subject}" saved in ${res.folder}.` }, `Draft "${a.subject}" saved in ${res.folder}.`);
      } catch (e) { return toolError(e); }
    },
  );

  server.registerTool(
    'move_message',
    {
      title: 'Move a message',
      description: 'Move a message to another folder (scope mail:write). Use list_folders for valid folder paths.',
      inputSchema: { folder: folderArg, ref: refArg, uid: uidArg.optional(), to_folder: z.string().min(1).max(500), account: accountArg },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (raw) => {
      const a = ctx.route(raw);
      if (a.uid === undefined) return toolError(new ToolError('invalid_argument', 'pass ref (as returned on the message) or folder + uid'));
      const uid = a.uid;
      try {
        ctx.requireScope('mail:write', 'move_message');
        await ctx.withMail('move_message', a.folder, (m) => m.move(a.folder, uid, a.to_folder), a.account);
        return ctx.ok({ moved: true, from: a.folder, to: a.to_folder, summary: `Moved message ${uid} from ${a.folder} to ${a.to_folder}.` }, `Moved message ${uid} to ${a.to_folder}.`);
      } catch (e) { return toolError(e); }
    },
  );

  server.registerTool(
    'set_flags',
    {
      title: 'Mark read / starred / answered',
      description: 'Add or remove flags on a message (scope mail:write): seen (read), flagged (starred), answered.',
      inputSchema: { folder: folderArg, ref: refArg, uid: uidArg.optional(), add: z.array(z.enum(['seen', 'flagged', 'answered'])).default([]), remove: z.array(z.enum(['seen', 'flagged', 'answered'])).default([]), account: accountArg },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (raw) => {
      const a = ctx.route(raw);
      if (a.uid === undefined) return toolError(new ToolError('invalid_argument', 'pass ref (as returned on the message) or folder + uid'));
      const uid = a.uid;
      try {
        ctx.requireScope('mail:write', 'set_flags');
        if (a.add.length === 0 && a.remove.length === 0) throw new ToolError('invalid_argument', 'specify flags to add or remove');
        const flags = await ctx.withMail('set_flags', a.folder, (m) => m.setFlags(a.folder, uid, a.add, a.remove), a.account);
        return ctx.ok({ flags, summary: `Flags on message ${uid}: ${flags.join(', ') || 'none'}.` }, `Flags updated on message ${uid}.`);
      } catch (e) { return toolError(e); }
    },
  );

  server.registerTool(
    'delete_message',
    {
      title: 'Move a message to Trash',
      description: 'Move a message to the Trash folder (scope mail:write). Nothing is permanently deleted; the user can restore it in Roundcube.',
      inputSchema: { folder: folderArg, ref: refArg, uid: uidArg.optional(), account: accountArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (raw) => {
      const a = ctx.route(raw);
      if (a.uid === undefined) return toolError(new ToolError('invalid_argument', 'pass ref (as returned on the message) or folder + uid'));
      const uid = a.uid;
      try {
        ctx.requireScope('mail:write', 'delete_message');
        const trash = await ctx.withMail('delete_message', a.folder, (m) => m.trash(a.folder, uid), a.account);
        return ctx.ok({ moved_to: trash, summary: `Message ${uid} moved to ${trash}.` }, `Message ${uid} moved to ${trash}.`);
      } catch (e) { return toolError(e); }
    },
  );

  server.registerTool(
    'search_contacts',
    {
      title: 'Search address book',
      description: 'Find contacts (name, email) in the user\'s Roundcube address books (scope contacts:read).',
      inputSchema: { q: z.string().min(1).max(100), limit: z.number().int().min(1).max(50).default(20), account: accountArg },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      try {
        ctx.requireScope('contacts:read', 'search_contacts');
        const started = Date.now();
        let outcome = 'ok';
        let alias: string | null = a.account ?? null;
        let accountUser: string | null = null;
        try {
          const account = ctx.account(a.account);
          alias = account.alias;
          accountUser = account.username;
          const contacts = await searchContacts(ctx.deps, account.username, account.imap_host, a.q, a.limit, ctx.deps.fetch ?? fetch);
          return ctx.ok({ account: account.alias, contacts });
        } catch (e) {
          outcome = e instanceof ToolError ? e.code : 'error';
          throw e;
        } finally {
          ctx.deps.store.insertAudit({ grant_id: ctx.principal.grantId, username: ctx.principal.username, tool: 'search_contacts', folder: null, outcome, ms: Date.now() - started, ip: ctx.ip, account: alias, account_user: accountUser });
        }
      } catch (e) { return toolError(e); }
    },
  );
}
