/** Mail abstraction used by the MCP tools. ImapMailbox implements it over imapflow; tests use a mock. */

export interface Address {
  name: string;
  address: string;
}

export interface FolderInfo {
  path: string;
  name: string;
  specialUse: string | null; // \Inbox \Sent \Drafts \Trash \Junk \Archive
  unseen: number | null;
  total: number | null;
}

export interface SearchFilters {
  folder: string;
  query?: string | undefined; // free text (subject + body)
  from?: string | undefined;
  to?: string | undefined;
  subject?: string | undefined;
  since?: string | undefined; // ISO date
  before?: string | undefined;
  unseen?: boolean | undefined;
  flagged?: boolean | undefined;
  hasAttachment?: boolean | undefined;
  limit: number;
  page: number;
}

export interface MessageSummary {
  uid: number;
  folder: string;
  date: string | null;
  from: Address[];
  to: Address[];
  subject: string;
  snippet: string;
  flags: string[];
  hasAttachments: boolean;
  size: number | null;
  messageId: string | null;
}

export interface SearchResult {
  messages: MessageSummary[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export interface AttachmentInfo {
  part: string;
  filename: string;
  mime: string;
  size: number | null;
  inline: boolean;
}

export interface MessageDetail extends MessageSummary {
  cc: Address[];
  replyTo: Address[];
  inReplyTo: string | null;
  references: string[];
  text: string | null;
  html: string | null;
  attachments: AttachmentInfo[];
  truncated: boolean;
}

export interface AttachmentContent {
  filename: string;
  mime: string;
  size: number;
  base64: string;
}

export interface Quota {
  usedBytes: number | null;
  limitBytes: number | null;
  usedMessages: number | null;
  limitMessages: number | null;
}

export type Flag = 'seen' | 'flagged' | 'answered';

export interface OutgoingMessage {
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  text: string;
  html?: string | undefined;
  inReplyTo?: string | undefined;
  references?: string[] | undefined;
  attachments: Array<{ filename: string; mime: string; content: Buffer }>;
}

export interface MailClient {
  listFolders(): Promise<FolderInfo[]>;
  search(filters: SearchFilters): Promise<SearchResult>;
  getMessage(folder: string, uid: number, opts: { format: 'text' | 'html' | 'both'; maxChars: number }): Promise<MessageDetail | null>;
  getAttachment(folder: string, uid: number, part: string, maxBytes: number): Promise<AttachmentContent | null>;
  getThread(folder: string, uid: number, limit: number): Promise<MessageSummary[]>;
  getQuota(): Promise<Quota>;
  // write (P4)
  move(folder: string, uid: number, toFolder: string): Promise<void>;
  setFlags(folder: string, uid: number, add: Flag[], remove: Flag[]): Promise<string[]>;
  trash(folder: string, uid: number): Promise<string>;
  appendDraft(raw: Buffer): Promise<{ folder: string; uid: number | null }>;
  appendSent(raw: Buffer): Promise<void>;
  specialFolder(use: 'sent' | 'drafts' | 'trash'): Promise<string>;
  close(): Promise<void>;
}

export class MailError extends Error {
  constructor(
    public readonly code: 'imap_auth_failed' | 'imap_unavailable' | 'not_found' | 'too_large' | 'invalid_argument',
    message: string,
  ) {
    super(message);
    this.name = 'MailError';
  }
}
