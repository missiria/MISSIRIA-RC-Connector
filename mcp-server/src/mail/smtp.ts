import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import type { OutgoingMessage } from './types.js';
import { MailError } from './types.js';

export interface SmtpCredentials {
  host: string;
  port: number;
  tls: 'implicit' | 'starttls' | 'none';
  user: string;
  pass: string;
}

export interface SmtpSender {
  send(creds: SmtpCredentials, raw: Buffer, envelope: { from: string; to: string[] }): Promise<{ messageId: string | null; response: string }>;
}

const fmt = (a: { name: string; address: string }) => (a.name ? `"${a.name.replace(/"/g, "'")}" <${a.address}>` : a.address);

/** Builds the RFC 5322 message once; the same bytes go to SMTP and to the Sent/Drafts folder. */
export async function buildRaw(msg: OutgoingMessage): Promise<{ raw: Buffer; messageId: string }> {
  const messageId = `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 12)}@${msg.from.address.split('@')[1] ?? 'rc-connector'}>`;
  const composer = new MailComposer({
    from: fmt(msg.from),
    to: msg.to.map(fmt),
    cc: msg.cc.map(fmt),
    bcc: msg.bcc.map(fmt),
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    inReplyTo: msg.inReplyTo,
    references: msg.references?.join(' '),
    messageId,
    date: new Date(),
    attachments: msg.attachments.map((a) => ({ filename: a.filename, contentType: a.mime, content: a.content })),
    headers: { 'X-Mailer': 'MISSIRIA RC Connector' },
  });
  const raw = await composer.compile().build();
  return { raw, messageId };
}

export class NodemailerSender implements SmtpSender {
  async send(creds: SmtpCredentials, raw: Buffer, envelope: { from: string; to: string[] }) {
    const transport = nodemailer.createTransport({
      host: creds.host,
      port: creds.port,
      secure: creds.tls === 'implicit',
      // 'starttls' = STARTTLS required; 'none' (loopback only) keeps nodemailer's opportunistic STARTTLS
      requireTLS: creds.tls === 'starttls',
      auth: { user: creds.user, pass: creds.pass },
      connectionTimeout: 15000,
      socketTimeout: 60000,
    });
    try {
      const info = await transport.sendMail({ envelope, raw });
      return { messageId: info.messageId ?? null, response: info.response };
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (/auth|535|credentials/i.test(m)) throw new MailError('imap_auth_failed', 'SMTP authentication failed. Revoke this connection in Roundcube and connect again.');
      throw new MailError('imap_unavailable', `SMTP error: ${m}`);
    } finally {
      transport.close();
    }
  }
}
