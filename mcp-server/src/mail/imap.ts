import { ImapFlow } from 'imapflow';
import type { FetchMessageObject, MessageStructureObject, MessageAddressObject, SearchObject } from 'imapflow';
import type { Address, AttachmentContent, AttachmentInfo, Flag, FolderInfo, MailClient, MessageDetail, MessageSummary, Quota, SearchFilters, SearchResult } from './types.js';
import { MailError } from './types.js';
import { addressList, htmlToText, parseRaw, referencesOf, sanitizeMailHtml, snippetOf, truncate } from './parse.js';

export interface ImapCredentials {
  host: string;
  port: number;
  secure: boolean;
  rejectUnauthorized: boolean;
  user: string;
  pass: string;
}

const FLAG_MAP: Record<Flag, string> = { seen: '\\Seen', flagged: '\\Flagged', answered: '\\Answered' };

function addr(list: MessageAddressObject[] | undefined): Address[] {
  return (list ?? []).filter((a) => a.address).map((a) => ({ name: a.name ?? '', address: a.address! }));
}

function isoDate(d: Date | string | undefined): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function walkStructure(node: MessageStructureObject | undefined, out: AttachmentInfo[]): void {
  if (!node) return;
  const isMultipart = node.type.startsWith('multipart/');
  if (!isMultipart) {
    const disp = (node.disposition ?? '').toLowerCase();
    const filename = node.dispositionParameters?.['filename'] ?? node.parameters?.['name'];
    const isBody = (node.type === 'text/plain' || node.type === 'text/html') && disp !== 'attachment';
    if (!isBody && node.part) {
      out.push({ part: node.part, filename: filename ?? `part-${node.part}`, mime: node.type, size: node.size ?? null, inline: disp === 'inline' });
    }
  }
  for (const child of node.childNodes ?? []) walkStructure(child, out);
}

function hasAttachments(node: MessageStructureObject | undefined): boolean {
  const list: AttachmentInfo[] = [];
  walkStructure(node, list);
  return list.some((a) => !a.inline || !a.mime.startsWith('image/'));
}

/** imapflow-backed MailClient. One instance = one authenticated IMAP connection. */
export class ImapMailbox implements MailClient {
  private client: ImapFlow;
  private connected = false;
  private folderCache: FolderInfo[] | null = null;

  constructor(private readonly creds: ImapCredentials) {
    this.client = new ImapFlow({
      host: creds.host,
      port: creds.port,
      secure: creds.secure,
      tls: { rejectUnauthorized: creds.rejectUnauthorized },
      auth: { user: creds.user, pass: creds.pass },
      logger: false,
      emitLogs: false,
      connectionTimeout: 15000,
      greetingTimeout: 10000,
      socketTimeout: 5 * 60 * 1000,
    });
    this.client.on('close', () => { this.connected = false; });
    this.client.on('error', () => { this.connected = false; });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    try {
      await this.client.connect();
      this.connected = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = (e as { authenticationFailed?: boolean }).authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(msg) ? 'imap_auth_failed' : 'imap_unavailable';
      throw new MailError(code, code === 'imap_auth_failed' ? 'IMAP authentication failed. If the mailbox password changed, revoke this connection in Roundcube and connect again.' : `IMAP server unavailable: ${msg}`);
    }
  }

  get isConnected(): boolean { return this.connected; }

  private async withFolder<T>(folder: string, fn: () => Promise<T>): Promise<T> {
    await this.connect();
    const lock = await this.client.getMailboxLock(folder).catch(() => { throw new MailError('not_found', `folder not found: ${folder}`); });
    try {
      return await fn();
    } finally {
      lock.release();
    }
  }

  async listFolders(): Promise<FolderInfo[]> {
    await this.connect();
    const list = await this.client.list({ statusQuery: { messages: true, unseen: true } });
    const folders = list.map((f) => ({
      path: f.path,
      name: f.name,
      specialUse: f.specialUse ?? (f.path.toUpperCase() === 'INBOX' ? '\\Inbox' : null),
      unseen: f.status?.unseen ?? null,
      total: f.status?.messages ?? null,
    }));
    this.folderCache = folders;
    return folders;
  }

  async specialFolder(use: 'sent' | 'drafts' | 'trash'): Promise<string> {
    const folders = this.folderCache ?? (await this.listFolders());
    const flag = { sent: '\\Sent', drafts: '\\Drafts', trash: '\\Trash' }[use];
    const byUse = folders.find((f) => f.specialUse === flag);
    if (byUse) return byUse.path;
    const names = { sent: ['Sent', 'Sent Items', 'Sent Messages', 'Envoyés'], drafts: ['Drafts', 'Brouillons'], trash: ['Trash', 'Deleted Items', 'Corbeille', 'Deleted'] }[use];
    const byName = folders.find((f) => names.some((n) => f.name.toLowerCase() === n.toLowerCase()));
    if (byName) return byName.path;
    throw new MailError('not_found', `no ${use} folder found on this mailbox`);
  }

  async search(filters: SearchFilters): Promise<SearchResult> {
    const query: SearchObject = {};
    if (filters.from) query.from = filters.from;
    if (filters.to) query.to = filters.to;
    if (filters.subject) query.subject = filters.subject;
    if (filters.query) query.or = [{ subject: filters.query }, { body: filters.query }, { from: filters.query }];
    if (filters.since) query.since = new Date(filters.since);
    if (filters.before) query.before = new Date(filters.before);
    if (filters.unseen) query.seen = false;
    if (filters.flagged) query.flagged = true;
    if (Object.keys(query).length === 0) query.all = true;

    return this.withFolder(filters.folder, async () => {
      const uidsRaw = await this.client.search(query, { uid: true });
      const uids = (Array.isArray(uidsRaw) ? uidsRaw : []).sort((a, b) => b - a);
      // When filtering on attachments we must inspect structure; fetch a wider window then filter.
      const window = filters.hasAttachment ? Math.min(uids.length, filters.limit * 5 + filters.page * filters.limit) : uids.length;
      const candidates = uids.slice(0, window);
      const start = filters.page * filters.limit;
      const pageUids = filters.hasAttachment ? candidates : candidates.slice(start, start + filters.limit);
      const summaries = pageUids.length ? await this.fetchSummaries(filters.folder, pageUids) : [];
      let result = summaries;
      let total = uids.length;
      if (filters.hasAttachment) {
        const withAtt = summaries.filter((m) => m.hasAttachments);
        total = withAtt.length;
        result = withAtt.slice(start, start + filters.limit);
      }
      return { messages: result, total, page: filters.page, limit: filters.limit, hasMore: start + result.length < total };
    });
  }

  private async fetchSummaries(folder: string, uids: number[]): Promise<MessageSummary[]> {
    const out: MessageSummary[] = [];
    for await (const msg of this.client.fetch(uids.join(','), { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, size: true }, { uid: true })) {
      out.push(this.summaryOf(folder, msg, ''));
    }
    out.sort((a, b) => b.uid - a.uid);
    return out;
  }

  private summaryOf(folder: string, msg: FetchMessageObject, snippet: string): MessageSummary {
    const env = msg.envelope;
    return {
      uid: msg.uid,
      folder,
      date: isoDate(env?.date ?? msg.internalDate),
      from: addr(env?.from),
      to: addr(env?.to),
      subject: env?.subject ?? '(no subject)',
      snippet,
      flags: [...(msg.flags ?? [])].map((f) => f.replace(/^\\/, '').toLowerCase()),
      hasAttachments: hasAttachments(msg.bodyStructure),
      size: msg.size ?? null,
      messageId: env?.messageId ?? null,
    };
  }

  async getMessage(folder: string, uid: number, opts: { format: 'text' | 'html' | 'both'; maxChars: number }): Promise<MessageDetail | null> {
    return this.withFolder(folder, async () => {
      const msg = await this.client.fetchOne(String(uid), { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, size: true, source: true }, { uid: true });
      if (!msg || !msg.source) return null;
      const parsed = await parseRaw(msg.source);
      const attachments: AttachmentInfo[] = [];
      walkStructure(msg.bodyStructure, attachments);
      const rawText = parsed.text ?? (parsed.html ? htmlToText(parsed.html) : '');
      const summary = this.summaryOf(folder, msg, snippetOf(rawText));
      const text = opts.format === 'html' ? null : truncate(rawText, opts.maxChars);
      const html = opts.format === 'text' || !parsed.html ? null : truncate(sanitizeMailHtml(parsed.html), opts.maxChars);
      return {
        ...summary,
        cc: addressList(parsed.cc),
        replyTo: addressList(parsed.replyTo),
        inReplyTo: parsed.inReplyTo ?? null,
        references: referencesOf(parsed),
        text: text?.text ?? null,
        html: html?.text ?? null,
        attachments,
        truncated: Boolean(text?.truncated || html?.truncated),
      };
    });
  }

  async getAttachment(folder: string, uid: number, part: string, maxBytes: number): Promise<AttachmentContent | null> {
    return this.withFolder(folder, async () => {
      const dl = await this.client.download(String(uid), part, { uid: true, maxBytes: maxBytes + 1 });
      if (!dl.content || !dl.meta) return null;
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of dl.content) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        size += b.length;
        if (size > maxBytes) throw new MailError('too_large', `attachment exceeds ${maxBytes} bytes`);
        chunks.push(b);
      }
      const content = Buffer.concat(chunks);
      return { filename: dl.meta.filename ?? `part-${part}`, mime: dl.meta.contentType ?? 'application/octet-stream', size: content.length, base64: content.toString('base64') };
    });
  }

  async getThread(folder: string, uid: number, limit: number): Promise<MessageSummary[]> {
    const root = await this.withFolder(folder, async () => this.client.fetchOne(String(uid), { uid: true, envelope: true, headers: ['references', 'in-reply-to', 'message-id'] }, { uid: true }));
    if (!root) throw new MailError('not_found', `message ${uid} not found in ${folder}`);
    const ids = new Set<string>();
    const headerText = root.headers?.toString('utf8') ?? '';
    for (const m of headerText.matchAll(/<[^>]+>/g)) ids.add(m[0]);
    if (root.envelope?.messageId) ids.add(root.envelope.messageId);
    if (root.envelope?.inReplyTo) ids.add(root.envelope.inReplyTo);
    if (ids.size === 0) return [];

    const folders = [folder];
    try { const sent = await this.specialFolder('sent'); if (sent !== folder) folders.push(sent); } catch { /* no sent folder */ }
    const found: MessageSummary[] = [];
    for (const f of folders) {
      await this.withFolder(f, async () => {
        const or: SearchObject[] = [];
        for (const id of ids) { or.push({ header: { 'message-id': id } }); or.push({ header: { references: id } }); }
        const uids = await this.client.search({ or }, { uid: true });
        const list = Array.isArray(uids) ? uids.slice(-limit) : [];
        if (list.length) found.push(...(await this.fetchSummaries(f, list)));
      });
    }
    found.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
    return found.slice(0, limit);
  }

  async getQuota(): Promise<Quota> {
    await this.connect();
    const q = await this.client.getQuota();
    if (!q) return { usedBytes: null, limitBytes: null, usedMessages: null, limitMessages: null };
    return {
      usedBytes: q.storage?.usage ?? null,
      limitBytes: q.storage?.limit ?? null,
      usedMessages: q.message?.usage ?? null,
      limitMessages: q.message?.limit ?? null,
    };
  }

  async move(folder: string, uid: number, toFolder: string): Promise<void> {
    await this.withFolder(folder, async () => {
      const res = await this.client.messageMove(String(uid), toFolder, { uid: true });
      if (!res) throw new MailError('not_found', `could not move ${uid} to ${toFolder}`);
    });
  }

  async setFlags(folder: string, uid: number, add: Flag[], remove: Flag[]): Promise<string[]> {
    return this.withFolder(folder, async () => {
      if (add.length) await this.client.messageFlagsAdd(String(uid), add.map((f) => FLAG_MAP[f]), { uid: true });
      if (remove.length) await this.client.messageFlagsRemove(String(uid), remove.map((f) => FLAG_MAP[f]), { uid: true });
      const msg = await this.client.fetchOne(String(uid), { uid: true, flags: true }, { uid: true });
      const flags = msg && msg.flags ? [...msg.flags] : [];
      return flags.map((f) => f.replace(/^\\/, '').toLowerCase());
    });
  }

  async trash(folder: string, uid: number): Promise<string> {
    const trash = await this.specialFolder('trash');
    if (trash === folder) throw new MailError('invalid_argument', 'message is already in Trash; permanent deletion is not available through this connector');
    await this.move(folder, uid, trash);
    return trash;
  }

  async appendDraft(raw: Buffer): Promise<{ folder: string; uid: number | null }> {
    const drafts = await this.specialFolder('drafts');
    await this.connect();
    const res = await this.client.append(drafts, raw, ['\\Draft', '\\Seen']);
    return { folder: drafts, uid: res ? res.uid ?? null : null };
  }

  async appendSent(raw: Buffer): Promise<void> {
    const sent = await this.specialFolder('sent');
    await this.connect();
    await this.client.append(sent, raw, ['\\Seen']);
  }

  async close(): Promise<void> {
    try {
      if (this.connected) await this.client.logout();
    } catch { /* ignore */ } finally {
      this.client.close();
      this.connected = false;
    }
  }
}
