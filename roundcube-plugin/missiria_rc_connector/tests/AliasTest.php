<?php
use PHPUnit\Framework\TestCase;

final class AliasTest extends TestCase
{
    public function testSuggestUsesTheBrandLabel(): void
    {
        $this->assertSame('yazzicars', rc_connector_alias::suggest('contact@yazzicars.com'));
        $this->assertSame('eksneks', rc_connector_alias::suggest('contact_eksneks', 'contact@eksneks.com'));
        $this->assertSame('example', rc_connector_alias::suggest('sales@mail.example.co.uk'));
        $this->assertSame('contact_yazzicars', rc_connector_alias::suggest('contact_yazzicars'));
        $this->assertSame('mailbox', rc_connector_alias::suggest('@@'));
    }

    public function testNormalizeAndValidate(): void
    {
        $this->assertSame('yazz-cars', rc_connector_alias::normalize(' Yazz Cars '));
        $this->assertSame('', rc_connector_alias::normalize('---'));
        $this->assertSame(32, strlen(rc_connector_alias::normalize(str_repeat('a', 40))));
        $this->assertTrue(rc_connector_alias::isValid('a_b-1'));
        $this->assertFalse(rc_connector_alias::isValid('-a'));
        $this->assertFalse(rc_connector_alias::isValid('A'));
    }
}
