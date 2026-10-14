import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../app.js';
import { mcpRoutes } from './routes.js';
import { makeDeps, fullFlow } from '../test/harness.js';
import { SessionPool } from '../mail/pool.js';
import type { Deps } from '../deps.js';
import type { MailClient, MessageDetail, Flag } from '../mail/types.js';
import type { SmtpSender, SmtpCredentials } from '../mail/smtp.js';
import { parseRaw } from '../mail/parse.js';

class CaptureSmtp implements SmtpSender {
  sent: Array<{ creds: SmtpCredentials; raw: Buffer; envelope: { from: string; to: string[] } }> = [];
  async send(creds: SmtpCredentials, raw: Buffer, envelope: { from: string; to: string[] }) {
    this.sent.push({ creds, raw, envelope });
    return { messageId: null, response: '250 OK' };
  }
}

class WriteMock implements MailClient {
  appendedSent: Buffer[] = [];
  drafts: Buffer[] = [];
  moves: Array<[string, number, string]> = [];
  flags: Array<[number, Flag[], Flag[]]> = [];
  async listFolders() { return []; }
  async search() { return { messages: [], total: 0, page: 0, limit: 20, hasMore: false }; }
  async getMessage(folder: string, uid: number): Promise<MessageDetail | null> {
    if (uid !== 7) return null;
    return { uid, folder, date: '2026-10-13T09:00:00.000Z', from: [{ name: 'Ana', address: 'ana@example.test' }], to: [{ name: '', address: 'alice@example.test' }, { name: '', address: 'carl@example.test' }], cc: [{ name: '', address: 'dora@example.test' }], replyTo: [], subject: 'Quote request', snippet: '', flags: [], hasAttachments: false, size: 1, messageId: '<q7@example.test>', inReplyTo: null, references: ['<q0@example.test>'], text: 'Can you send a quote?', html: null, attachments: [], truncated: false };
  }
  async getAttachment() { return null; }
  async getThread() { return []; }
  async getQuota() { return { usedBytes: null, limitBytes: null, usedMessages: null, limitMessages: null }; }
  async move(folder: string, uid: number, to: string) { this.moves.push([folder, uid, to]); }
  async setFlags(_f: string, uid: number, add: Flag[], remove: Flag[]) { this.flags.push([uid, add, remove]); return add; }
  async trash(folder: string, uid: number) { this.moves.push([folder, uid, 'Trash']); return 'Trash'; }
  async appendDraft(raw: Buffer) { this.drafts.push(raw); return { folder: 'Drafts', uid: 11 }; }
  async appendSent(raw: Buffer) { this.appendedSent.push(raw); }
  async specialFolder() { return 'Sent'; }
  async close() {}
}

const text = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text);

async function setup(scopes: string[], env: Record<string, string> = {}) {
  const deps: Deps = await makeDeps(env as never);
  const mail = new WriteMock();
  const smtp = new CaptureSmtp();
  deps.pool = new SessionPool(deps, () => mail);
  deps.smtp = smtp;
  deps.fetch = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    expect(u.searchParams.get('_action')).toBe('contacts');
    expect(u.searchParams.get('sig')).toMatch(/^[0-9a-f]{64}$/);
    expect(u.searchParams.get('host')).toBe('127.0.0.1');
    return new Response(JSON.stringify({ contacts: [{ name: 'Ana', email: 'ana@example.test' }] }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const app = createApp(deps, mcpRoutes);
  const f = await fullFlow(app, deps, { scopes });
  const client = new Client({ name: 't', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('https://mcp.example.test/mcp'), {
    fetch: async (url, init) => app.request(url.toString(), init as RequestInit),
    requestInit: { headers: { authorization: `Bearer ${f.tokens.access_token}` } },
  }));
  return { deps, mail, smtp, client, f };
}

describe('write tools', () => {
  it('send_message submits via SMTP with the unsealed password and copies to Sent', async () => {
    const { client, smtp, mail, deps } = await setup(['mail:read', 'mail:send']);
    const r = await client.callTool({ name: 'send_message', arguments: { to: ['bob@example.test'], cc: ['carl@example.test'], subject: 'Hello', text: 'Hi Bob', attachments: [{ filename: 'a.txt', mime: 'text/plain', base64: Buffer.from('abc').toString('base64') }] } });
    expect(r.isError).toBeFalsy();
    expect(smtp.sent).toHaveLength(1);
    expect(smtp.sent[0]!.creds).toMatchObject({ user: 'alice@example.test', pass: 'imap-pass', port: 587, tls: 'starttls' });
    expect(smtp.sent[0]!.envelope.to.sort()).toEqual(['bob@example.test', 'carl@example.test']);
    const parsed = await parseRaw(smtp.sent[0]!.raw);
    expect(parsed.subject).toBe('Hello');
    expect(parsed.attachments[0]?.filename).toBe('a.txt');
    expect(parsed.headers.get('x-mailer')).toBe('MISSIRIA RC Connector');
    expect(mail.appendedSent).toHaveLength(1);
    expect(deps.store.countSendsSince('x', 0)).toBe(0);
    expect(text(r).summary).toContain('Sent "Hello"');
  });

  it('reply_message threads correctly, strips self, honours reply_all and flags answered', async () => {
    const { client, smtp, mail } = await setup(['mail:read', 'mail:send']);
    const r = await client.callTool({ name: 'reply_message', arguments: { uid: 7, text: 'Sure, attached.', reply_all: true } });
    expect(r.isError).toBeFalsy();
    const parsed = await parseRaw(smtp.sent[0]!.raw);
    expect(parsed.subject).toBe('Re: Quote request');
    expect(parsed.inReplyTo).toBe('<q7@example.test>');
    expect(String(parsed.references)).toContain('<q0@example.test>');
    expect(String(parsed.references)).toContain('<q7@example.test>');
    expect(parsed.text).toContain('> Can you send a quote?');
    const out = text(r);
    expect(out.to).toEqual(['ana@example.test']);
    expect(out.cc.sort()).toEqual(['carl@example.test', 'dora@example.test']); // alice (self) removed
    expect(mail.flags).toEqual([[7, ['answered'], []]]);
  });

  it('enforces scope, recipient cap, rate limit and DISABLE_SEND', async () => {
    const readOnly = await setup(['mail:read']);
    const denied = await readOnly.client.callTool({ name: 'send_message', arguments: { to: ['b@example.test'], subject: 's', text: 't' } });
    expect(text(denied).error).toBe('insufficient_scope');

    const limited = await setup(['mail:read', 'mail:send'], { SEND_RATE_PER_HOUR: '1' });
    await limited.client.callTool({ name: 'send_message', arguments: { to: ['b@example.test'], subject: '1', text: 't' } });
    const second = await limited.client.callTool({ name: 'send_message', arguments: { to: ['b@example.test'], subject: '2', text: 't' } });
    expect(text(second).error).toBe('rate_limited');
    expect(limited.smtp.sent).toHaveLength(1);
    expect(limited.deps.store.listAuditForUser('alice@example.test').some((a) => a.outcome === 'rate_limited')).toBe(true);

    const disabled = await setup(['mail:read', 'mail:send'], { DISABLE_SEND: 'true' });
    const off = await disabled.client.callTool({ name: 'send_message', arguments: { to: ['b@example.test'], subject: 's', text: 't' } });
    expect(text(off).error).toBe('send_disabled');
  });

  it('oversized base64 attachments are rejected by schema before decoding; failed SMTP releases the slot', async () => {
    const { client, smtp, deps, f } = await setup(['mail:read', 'mail:send'], { ATTACHMENT_MAX_BYTES: '30', SEND_RATE_PER_HOUR: '1' });
    const big = await client.callTool({ name: 'send_message', arguments: { to: ['b@example.test'], subject: 's', text: 't', attachments: [{ filename: 'x.bin', base64: 'A'.repeat(200) }] } });
    expect(big.isError).toBe(true);
    expect(smtp.sent).toHaveLength(0);
    smtp.send = async () => { throw new Error('connect ECONNREFUSED'); };
    const failed = await client.callTool({ name: 'send_message', arguments: { to: ['b@example.test'], subject: 's', text: 't' } });
    expect(text(failed).error).toBe('internal_error');
    expect(deps.store.countSendsSince(f.grant.grant_id, 0)).toBe(0); // reservation released
  });

  it('reply_message needs mail:read too', async () => {
    const { client } = await setup(['mail:send']);
    const r = await client.callTool({ name: 'reply_message', arguments: { uid: 7, text: 'x' } });
    expect(text(r).error).toBe('insufficient_scope');
  });

  it('draft, move, flags, trash and contacts', async () => {
    const { client, mail } = await setup(['mail:read', 'mail:write', 'contacts:read']);
    const d = await client.callTool({ name: 'create_draft', arguments: { to: ['b@example.test'], subject: 'Draft', text: 'wip' } });
    expect(text(d)).toMatchObject({ folder: 'Drafts', uid: 11 });
    expect((await parseRaw(mail.drafts[0]!)).subject).toBe('Draft');

    await client.callTool({ name: 'move_message', arguments: { uid: 7, to_folder: 'Archive' } });
    const fl = await client.callTool({ name: 'set_flags', arguments: { uid: 7, add: ['seen'], remove: ['flagged'] } });
    expect(text(fl).flags).toEqual(['seen']);
    const del = await client.callTool({ name: 'delete_message', arguments: { uid: 7 } });
    expect(text(del).moved_to).toBe('Trash');
    expect(mail.moves).toEqual([['INBOX', 7, 'Archive'], ['INBOX', 7, 'Trash']]);

    const c = await client.callTool({ name: 'search_contacts', arguments: { q: 'ana' } });
    expect(text(c).contacts).toEqual([{ name: 'Ana', email: 'ana@example.test' }]);

    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['send_message', 'reply_message', 'create_draft', 'move_message', 'set_flags', 'delete_message', 'search_contacts']));
  });
});
