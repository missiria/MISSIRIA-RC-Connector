<?php
use PHPUnit\Framework\TestCase;

final class ScopesTest extends TestCase
{
    public function testOfferableFiltersUnknownAndWriteScopes(): void
    {
        $this->assertSame(['mail:read', 'mail:send'], rc_connector_scopes::offerable(['mail:read', 'mail:send', 'mail:nuke'], true));
        $this->assertSame(['mail:read', 'contacts:read'], rc_connector_scopes::offerable(['mail:read', 'mail:send', 'mail:write', 'contacts:read'], false));
    }

    public function testGrantedNeverEscalates(): void
    {
        $offer = ['mail:read', 'mail:send'];
        $this->assertSame(['mail:read'], rc_connector_scopes::granted(['mail:read', 'mail:write', 'contacts:read'], $offer));
        $this->assertSame([], rc_connector_scopes::granted([], $offer));
    }
}
