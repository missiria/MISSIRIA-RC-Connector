import { describe, it, expect } from 'vitest';
import { sanitizeMailHtml, htmlToText, snippetOf, truncate, parseRaw, addressList } from './parse.js';

describe('mail parsing helpers', () => {
  it('sanitizes html: drops scripts, styles, images and event handlers', () => {
    const dirty = `<div onclick="x()"><style>p{}</style><script>alert(1)</script><p>Hi <b>there</b></p><img src="https://t.example/pixel.gif"><a href="javascript:evil()">x</a><a href="https://ok.example">ok</a></div>`;
    const clean = sanitizeMailHtml(dirty);
    expect(clean).not.toMatch(/script|style|img|onclick|javascript/);
    expect(clean).toContain('<b>there</b>');
    expect(clean).toContain('href="https://ok.example"');
    expect(clean).toContain('rel="noopener noreferrer nofollow"');
  });

  it('converts html to text and snippets', () => {
    expect(htmlToText('<p>Hello<br>World</p>')).toBe('Hello\nWorld');
    expect(snippetOf('a   b\n\nc', 3)).toBe('a …');
    const t = truncate('x'.repeat(10), 4);
    expect(t.truncated).toBe(true);
    expect(t.text.startsWith('xxxx')).toBe(true);
  });

  it('parses a multipart message with an attachment', async () => {
    const raw = Buffer.from([
      'From: Ana <ana@example.test>',
      'To: Bob <bob@example.test>',
      'Subject: =?UTF-8?B?RmFjdHVyZSBu4oCZMTIz?=',
      'Message-ID: <m1@example.test>',
      'In-Reply-To: <m0@example.test>',
      'References: <m0@example.test>',
      'Date: Tue, 14 Oct 2026 10:00:00 +0200',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="B"',
      '',
      '--B',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Bonjour, voici la facture.',
      '--B',
      'Content-Type: application/pdf; name="facture.pdf"',
      'Content-Disposition: attachment; filename="facture.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('%PDF-1.4 fake').toString('base64'),
      '--B--',
      '',
    ].join('\r\n'));
    const p = await parseRaw(raw);
    expect(p.subject).toBe('Facture n’123');
    expect(addressList(p.from)).toEqual([{ name: 'Ana', address: 'ana@example.test' }]);
    expect(p.text?.trim()).toBe('Bonjour, voici la facture.');
    expect(p.attachments).toHaveLength(1);
    expect(p.attachments[0]?.filename).toBe('facture.pdf');
    expect(p.inReplyTo).toBe('<m0@example.test>');
  });
});
