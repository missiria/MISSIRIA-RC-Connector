<?php
use PHPUnit\Framework\TestCase;

final class SealerTest extends TestCase
{
    public function testSealsForTheServerKeyAndWipesPlaintext(): void
    {
        $kp = sodium_crypto_box_keypair();
        $pk = sodium_crypto_box_publickey($kp);
        $sealer = new rc_connector_sealer('base64:' . base64_encode($pk));
        $secret = 'imap-pa$$word-ü';
        $sealed = $sealer->seal($secret);
        $this->assertSame('', trim($secret, "\0"), 'plaintext must be zeroed');
        $opened = sodium_crypto_box_seal_open(base64_decode($sealed), $kp);
        $this->assertSame('imap-pa$$word-ü', $opened);
        $this->assertGreaterThanOrEqual(48 + strlen('imap-pa$$word-ü'), strlen(base64_decode($sealed)));
    }

    public function testRejectsBadKeys(): void
    {
        $this->expectException(InvalidArgumentException::class);
        new rc_connector_sealer('base64:AAAA');
    }

    public function testAcceptsKeyWithoutPrefix(): void
    {
        $pk = sodium_crypto_box_publickey(sodium_crypto_box_keypair());
        $this->assertInstanceOf(rc_connector_sealer::class, new rc_connector_sealer(base64_encode($pk)));
    }
}
