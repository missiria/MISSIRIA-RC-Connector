import { describe, it, expect } from 'vitest';
import { imapFlowOptions } from './imap.js';
import { smtpTransportOptions } from './smtp.js';

const imap = (tls: 'implicit' | 'starttls' | 'none') => imapFlowOptions({ host: '127.0.0.1', port: 143, tls, rejectUnauthorized: true, user: 'u', pass: 'p' });
const smtp = (tls: 'implicit' | 'starttls' | 'none') => smtpTransportOptions({ host: '127.0.0.1', port: 587, tls, user: 'u', pass: 'p' });

describe('TLS mode → socket policy', () => {
  it('none is plaintext: no opportunistic STARTTLS (loopback cert never matches 127.0.0.1)', () => {
    expect(imap('none')).toMatchObject({ secure: false, doSTARTTLS: false });
    expect(smtp('none')).toMatchObject({ secure: false, requireTLS: false, ignoreTLS: true });
  });
  it('starttls requires the upgrade', () => {
    expect(imap('starttls')).toMatchObject({ secure: false, doSTARTTLS: true });
    expect(smtp('starttls')).toMatchObject({ secure: false, requireTLS: true, ignoreTLS: false });
  });
  it('implicit is TLS on connect and verifies certificates', () => {
    expect(imap('implicit')).toMatchObject({ secure: true, tls: { rejectUnauthorized: true } });
    expect(imap('implicit')).not.toHaveProperty('doSTARTTLS');
    expect(smtp('implicit')).toMatchObject({ secure: true, requireTLS: false, ignoreTLS: false });
  });
});
