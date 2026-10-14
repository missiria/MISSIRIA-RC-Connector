import type { Deps } from '../deps.js';
import { hmacHex } from '../crypto/seal.js';
import { MailError } from './types.js';

export interface Contact {
  name: string;
  email: string;
}

/**
 * Address-book lookup through the Roundcube plugin. The plugin verifies
 * sig = HMAC-SHA256(INTERNAL_KEY, `${user}|${ts}|${q}`) and rejects ts older than 60 s.
 */
export async function searchContacts(deps: Deps, username: string, q: string, limit: number, fetchImpl: typeof fetch = fetch): Promise<Contact[]> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = hmacHex(deps.cfg.INTERNAL_KEY, `${username}|${ts}|${q}`);
  const url = new URL(`${deps.cfg.WEBMAIL_URL}/`);
  url.searchParams.set('_task', 'rcconnector');
  url.searchParams.set('_action', 'contacts');
  url.searchParams.set('user', username);
  url.searchParams.set('q', q);
  url.searchParams.set('ts', ts);
  url.searchParams.set('sig', sig);
  url.searchParams.set('limit', String(limit));
  const res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'missiria-rc-connector' }, signal: AbortSignal.timeout(5000) }).catch((e: unknown) => {
    throw new MailError('imap_unavailable', `contacts lookup failed: ${e instanceof Error ? e.message : String(e)}`);
  });
  if (!res.ok) throw new MailError('imap_unavailable', `contacts lookup returned HTTP ${res.status}`);
  const data = (await res.json()) as { contacts?: Array<{ name?: string; email?: string }> };
  return (data.contacts ?? []).filter((c) => c.email).slice(0, limit).map((c) => ({ name: c.name ?? '', email: c.email! }));
}
