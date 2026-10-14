import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdentityMap, MailboxDirectory, directoryAlias, parseDirectory } from './directory.js';

// The real list of a 36-mailbox host (ADR-003 target); aliases must be unique and predictable.
const LIVE = [
  'contact@eksneks.com', 'contact@ekscars.com', 'contact@yazzicars.com', 'contact@iptv-premium-europe.com', 'contact@iptv-rapide.com',
  'contact@iptv-kings.com', 'contact@iptv-ott-globale.com', 'contact@iptv-lion.com', 'contact@iptv-ott-adulte.com', 'contact@iptv-shark.com',
  'contact@iptv-smarters-europe.com', 'contact@iptv-smarters-x.com', 'contact@mundovea.com', 'contact@lujo-vision.com', 'contact@puntomira.com',
  'contact@iptv-adulte-europe.com', 'contact@flashcanal.com', 'contact@sabrina-missiria-group.com', 'tour@sabrina-missiria-group.com',
  'info@sabrina-missiria-group.com', 'contact@mediteranien-mecanic-shop.com', 'contact@godailyliving.com', 'billing@eksneks.com',
  'contact@akhiyat-driver-cars.com', 'dmarc@eksneks.com', 'contact@iptv-x.com', 'contact@x-iptv.fr', 'contact@iptvxhub.com',
  'contact@iptv-x-france.com', 'contact@abonnement-iptv-x.fr', 'contact@rifcars.com', 'noreply@rifcars.com', 'partners@yazzicars.com',
  'contact@missiria.dev', 'billing@missiria.dev', 'support@missiria.dev',
];

describe('ADR-003 mailbox directory', () => {
  it('derives brand aliases; non-contact logins get a localpart suffix', () => {
    expect(directoryAlias('contact@yazzicars.com')).toBe('yazzicars');
    expect(directoryAlias('partners@yazzicars.com')).toBe('yazzicars-partners');
    expect(directoryAlias('billing@eksneks.com')).toBe('eksneks-billing');
    expect(directoryAlias('tour@sabrina-missiria-group.com')).toBe('sabrina-missiria-group-tour');
    expect(directoryAlias('contact@abonnement-iptv-x.fr')).toBe('abonnement-iptv-x');
    expect(directoryAlias('legacy_user')).toBe('legacy_user');
  });

  it('parses the live list without alias collisions and honours overrides and comments', () => {
    const entries = parseDirectory(LIVE.join('\n'));
    expect(entries).toHaveLength(LIVE.length);
    expect(new Set(entries.map((e) => e.alias)).size).toBe(LIVE.length);
    const withOverride = parseDirectory('# generated\ncontact@eksneks.com  hq\nbilling@eksneks.com\n\ncontact@eksneks.com dup\n');
    expect(withOverride.map((e) => e.alias)).toEqual(['hq', 'eksneks-billing']);
    // two logins wanting the same alias: second gets -2
    expect(parseDirectory('a@one.test same\nb@two.test same').map((e) => e.alias)).toEqual(['same', 'same-2']);
  });

  it('resolves by alias, address or bare domain (contact@ wins on shared domains)', () => {
    const d = MailboxDirectory.fromLines(LIVE);
    expect(d.count).toBe(36);
    expect(d.resolve('yazzicars')?.login).toBe('contact@yazzicars.com');
    expect(d.resolve('Partners@yazzicars.com')?.alias).toBe('yazzicars-partners');
    expect(d.resolve('iptv-premium-europe.com')?.login).toBe('contact@iptv-premium-europe.com');
    expect(d.resolve('eksneks.com')?.login).toBe('contact@eksneks.com');
    expect(d.resolve('nope')).toBeUndefined();
    expect(d.resolve('')).toBeUndefined();
  });

  it('reloads the file when its mtime changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rcc-dir-'));
    const file = join(dir, 'mailboxes');
    writeFileSync(file, 'a@one.test\n');
    const d = MailboxDirectory.fromFile(file);
    expect(d.count).toBe(1);
    writeFileSync(file, 'a@one.test\nb@two.test\n');
    utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect(d.count).toBe(2);
  });

  it('identity map: per-login allowed From addresses, lower-cased, comments ignored', () => {
    const m = IdentityMap.fromLines(['# generated', 'contact@eksneks.com Support@eksneks.com info@eksneks.com', 'contact@yazzicars.com', '']);
    expect([...m.for('contact@eksneks.com')]).toEqual(['support@eksneks.com', 'info@eksneks.com']);
    expect(m.for('contact@yazzicars.com').size).toBe(0);
    expect(m.for('nobody@x.test').size).toBe(0);
    expect(m.count).toBe(2);
  });
});
