<?php
use PHPUnit\Framework\TestCase;

final class SignatureTest extends TestCase
{
    private const KEY = 'test-internal-key-0123456789abcdef0123456789abcdef';

    public function testConsentSignatureMatchesNodeHmac(): void
    {
        $sig = new rc_connector_signature(self::KEY);
        $req = str_repeat('ab', 16);
        $good = hash_hmac('sha256', $req, self::KEY);
        $this->assertTrue($sig->verifyConsent($req, $good));
        $this->assertFalse($sig->verifyConsent($req, strrev($good)));
        $this->assertFalse($sig->verifyConsent('not-hex', $good));
        $this->assertFalse($sig->verifyConsent($req, 'short'));
    }

    public function testContactsSignatureIncludesUserTsQueryAndExpires(): void
    {
        $sig = new rc_connector_signature(self::KEY);
        $now = 1_800_000_000;
        $ts  = (string) $now;
        $good = hash_hmac('sha256', "alice@example.test|$ts|ana", self::KEY);
        $this->assertTrue($sig->verifyContacts('alice@example.test', $ts, 'ana', $good, $now));
        $this->assertTrue($sig->verifyContacts('alice@example.test', $ts, 'ana', $good, $now + 59));
        $this->assertFalse($sig->verifyContacts('alice@example.test', $ts, 'ana', $good, $now + 61), 'expired');
        $this->assertFalse($sig->verifyContacts('bob@example.test', $ts, 'ana', $good, $now), 'other user');
        $this->assertFalse($sig->verifyContacts('alice@example.test', $ts, 'anb', $good, $now), 'other query');
    }

    public function testShortKeyRejected(): void
    {
        $this->expectException(InvalidArgumentException::class);
        new rc_connector_signature('short');
    }
}
