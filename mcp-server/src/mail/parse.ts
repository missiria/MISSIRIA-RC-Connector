import { simpleParser, type ParsedMail, type AddressObject } from 'mailparser';
import { convert } from 'html-to-text';
import sanitizeHtml from 'sanitize-html';
import type { Address } from './types.js';

export function addressList(a: AddressObject | AddressObject[] | undefined): Address[] {
  if (!a) return [];
  const arr = Array.isArray(a) ? a : [a];
  const out: Address[] = [];
  for (const obj of arr) for (const v of obj.value) if (v.address) out.push({ name: v.name ?? '', address: v.address });
  return out;
}

export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true, ignoreHref: false } },
      { selector: 'img', format: 'skip' },
      { selector: 'style', format: 'skip' },
      { selector: 'script', format: 'skip' },
    ],
  }).trim();
}

/** Strips scripts, styles, forms, remote images and tracking pixels. Keeps basic formatting. */
export function sanitizeMailHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'a', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'div', 'span', 'hr', 'sub', 'sup'],
    allowedAttributes: { a: ['href', 'title', 'rel'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'] },
    allowedSchemes: ['https', 'http', 'mailto'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    transformTags: {
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, rel: 'noopener noreferrer nofollow' } }),
    },
  }).trim();
}

export function snippetOf(text: string, max = 200): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function truncate(s: string, maxChars: number): { text: string; truncated: boolean } {
  if (s.length <= maxChars) return { text: s, truncated: false };
  return { text: s.slice(0, maxChars) + `\n\n[… truncated, ${s.length - maxChars} more characters]`, truncated: true };
}

export async function parseRaw(raw: Buffer): Promise<ParsedMail> {
  return simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
}

export function referencesOf(parsed: ParsedMail): string[] {
  const r = parsed.references;
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}
