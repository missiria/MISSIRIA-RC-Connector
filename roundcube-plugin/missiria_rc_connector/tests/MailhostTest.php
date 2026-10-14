<?php
use PHPUnit\Framework\TestCase;

final class MailhostTest extends TestCase
{
    public function testImapFromSession(): void
    {
        $this->assertSame(['host' => 'localhost', 'port' => 993, 'secure' => true], rc_connector_mailhost::imap('localhost', 993, 'ssl'));
        $this->assertSame(['host' => 'mail.example.test', 'port' => 143, 'secure' => false], rc_connector_mailhost::imap('mail.example.test', 143, null));
        $this->assertSame(['host' => 'mail.example.test', 'port' => 993, 'secure' => true], rc_connector_mailhost::imap('ssl://mail.example.test', null, null));
    }

    public function testSmtpFromConfigVariants(): void
    {
        $this->assertSame(['host' => 'localhost', 'port' => 587, 'secure' => false], rc_connector_mailhost::smtp('localhost', 587, 'imap.example.test'));
        $this->assertSame(['host' => 'smtp.example.test', 'port' => 465, 'secure' => true], rc_connector_mailhost::smtp('ssl://smtp.example.test:465', null, 'x'));
        $this->assertSame(['host' => 'imap.example.test', 'port' => 587, 'secure' => false], rc_connector_mailhost::smtp('tls://%h:587', null, 'imap.example.test'));
        $this->assertSame(['host' => 'b.example.test', 'port' => 587, 'secure' => false], rc_connector_mailhost::smtp(['imap.a' => 'a.example.test', 'imap.b' => 'b.example.test'], null, 'imap.b'));
        $this->assertSame('localhost', rc_connector_mailhost::smtp('', null, 'x')['host']);
    }
}
