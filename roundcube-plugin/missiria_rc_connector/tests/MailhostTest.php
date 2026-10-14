<?php
use PHPUnit\Framework\TestCase;

final class MailhostTest extends TestCase
{
    public function testImapFromSession(): void
    {
        $this->assertSame(['host' => 'localhost', 'port' => 993, 'tls' => 'implicit'], rc_connector_mailhost::imap('localhost', 993, 'ssl'));
        $this->assertSame(['host' => 'mail.example.test', 'port' => 143, 'tls' => 'starttls'], rc_connector_mailhost::imap('mail.example.test', 143, null), 'remote plain → STARTTLS required');
        $this->assertSame(['host' => 'localhost', 'port' => 143, 'tls' => 'none'], rc_connector_mailhost::imap('localhost', 143, null), 'loopback may stay plain');
        $this->assertSame(['host' => 'mail.example.test', 'port' => 143, 'tls' => 'starttls'], rc_connector_mailhost::imap('mail.example.test', 143, 'tls'));
        $this->assertSame(['host' => 'mail.example.test', 'port' => 143, 'tls' => 'starttls'], rc_connector_mailhost::imap('tls://mail.example.test', null, null));
        $this->assertSame(['host' => 'mail.example.test', 'port' => 993, 'tls' => 'implicit'], rc_connector_mailhost::imap('ssl://mail.example.test', null, null));
    }

    public function testSmtpArrayWithoutMatchingHostFailsClosed(): void
    {
        $this->expectException(InvalidArgumentException::class);
        rc_connector_mailhost::smtp(['imap.a' => 'a.example.test'], null, 'imap.z');
    }

    public function testSmtpFromConfigVariants(): void
    {
        $this->assertSame(['host' => 'localhost', 'port' => 587, 'tls' => 'none'], rc_connector_mailhost::smtp('localhost', 587, 'imap.example.test'));
        $this->assertSame(['host' => 'smtp.example.test', 'port' => 465, 'tls' => 'implicit'], rc_connector_mailhost::smtp('ssl://smtp.example.test:465', null, 'x'));
        $this->assertSame(['host' => 'imap.example.test', 'port' => 587, 'tls' => 'starttls'], rc_connector_mailhost::smtp('tls://%h:587', null, 'imap.example.test'));
        $this->assertSame(['host' => 'b.example.test', 'port' => 587, 'tls' => 'starttls'], rc_connector_mailhost::smtp(['imap.a' => 'a.example.test', 'imap.b' => 'b.example.test'], null, 'imap.b'));
        $this->assertSame(['host' => '127.0.0.1', 'port' => 25, 'tls' => 'none'], rc_connector_mailhost::smtp('127.0.0.1:25', null, 'x'));
        $this->assertSame('raw.example.test', rc_connector_mailhost::smtp(['ssl://imap.b' => 'raw.example.test'], null, 'imap.b', 'ssl://imap.b')['host']);
        $this->assertSame('localhost', rc_connector_mailhost::smtp('', null, 'x')['host']);
    }
}
