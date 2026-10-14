<?php
use PHPUnit\Framework\TestCase;

final class InternalClientTest extends TestCase
{
    /** @var array<int, array> */
    private $calls = [];

    private function client(array $responses): rc_connector_internal_client
    {
        $queue = $responses;
        return new rc_connector_internal_client('http://127.0.0.1:8787/', 'k', 3, function ($method, $url, $headers, $body) use (&$queue) {
            $this->calls[] = compact('method', 'url', 'headers', 'body');
            return array_shift($queue) ?: ['status' => 500, 'body' => ''];
        });
    }

    public function testCreateGrantPostsJsonWithInternalKey(): void
    {
        $c = $this->client([['status' => 201, 'body' => json_encode(['code' => 'abc', 'grant_id' => 'g1', 'callback' => 'https://mcp/oauth/callback?req=r&code=abc'])]]);
        $res = $c->createGrant(['request_id' => 'r', 'username' => 'u', 'sealed' => 'x', 'scopes' => ['mail:read']]);
        $this->assertSame('abc', $res['code']);
        $call = $this->calls[0];
        $this->assertSame('POST', $call['method']);
        $this->assertSame('http://127.0.0.1:8787/internal/grants', $call['url']);
        $this->assertContains('X-Internal-Key: k', $call['headers']);
        $this->assertSame(['mail:read'], json_decode($call['body'], true)['scopes']);
    }

    public function testCreateGrantFailureIsDescriptive(): void
    {
        $c = $this->client([['status' => 409, 'body' => json_encode(['error' => 'request_not_pending'])]]);
        $this->expectExceptionMessage('HTTP 409 request_not_pending');
        $c->createGrant([]);
    }

    public function testListAndRevokeUseQueryString(): void
    {
        $c = $this->client([
            ['status' => 200, 'body' => json_encode([['id' => 'g1', 'client_name' => 'ChatGPT', 'scopes' => ['mail:read']]])],
            ['status' => 200, 'body' => json_encode(['revoked' => true])],
            ['status' => 404, 'body' => json_encode(['error' => 'not_found'])],
        ]);
        $this->assertCount(1, $c->listGrants('alice@example.test'));
        $this->assertStringContainsString('/internal/grants?user=alice%40example.test', $this->calls[0]['url']);
        $this->assertTrue($c->revokeGrant('g1', 'alice@example.test'));
        $this->assertSame('DELETE', $this->calls[1]['method']);
        $this->assertFalse($c->revokeGrant('g2', 'alice@example.test'));
    }

    public function testHealthzSwallowsTransportErrors(): void
    {
        $c = new rc_connector_internal_client('http://127.0.0.1:1', 'k', 1, function () {
            throw new RuntimeException('down');
        });
        $this->assertFalse($c->healthz());
    }

    public function testLinkCodeFlowAndTypedErrors(): void
    {
        $c = $this->client([
            ['status' => 201, 'body' => json_encode(['code' => 'LINK-AAAA-BBBB', 'expires_at' => 1])],
            ['status' => 201, 'body' => json_encode(['account_id' => 'a1', 'alias' => 'yazzicars', 'client_name' => 'Claude'])],
            ['status' => 410, 'body' => json_encode(['error' => 'code_used'])],
            ['status' => 200, 'body' => json_encode([['id' => 'a1', 'alias' => 'yazzicars']])],
            ['status' => 200, 'body' => json_encode(['unlinked' => true])],
        ]);
        $this->assertSame('LINK-AAAA-BBBB', $c->createLinkCode('g1', 'owner@example.test')['code']);
        $this->assertSame(['grant_id' => 'g1', 'user' => 'owner@example.test'], json_decode($this->calls[0]['body'], true));
        $this->assertSame('yazzicars', $c->redeemLinkCode(['code' => 'x', 'alias' => 'yazzicars', 'username' => 'u', 'sealed' => 's'])['alias']);
        $this->assertSame('http://127.0.0.1:8787/internal/link-codes/redeem', $this->calls[1]['url']);
        try {
            $c->redeemLinkCode(['code' => 'x']);
            $this->fail('expected link exception');
        } catch (rc_connector_link_exception $e) {
            $this->assertSame('code_used', $e->getMessage());
            $this->assertSame(410, $e->getCode());
        }
        $this->assertCount(1, $c->listLinks('u@example.test'));
        $this->assertTrue($c->unlinkAccount('a1', 'u@example.test'));
        $this->assertStringContainsString('/internal/accounts/a1?user=u%40example.test', $this->calls[4]['url']);
    }

    public function testPreviewLinkCodeIsNullWhenUnusable(): void
    {
        $c = $this->client([
            ['status' => 200, 'body' => json_encode(['client_name' => 'Claude', 'kind' => 'oauth', 'scopes' => ['mail:read'], 'primary' => 'contact@eksneks.test'])],
            ['status' => 410, 'body' => json_encode(['error' => 'code_expired'])],
        ]);
        $this->assertSame('Claude', $c->previewLinkCode('LINK-AAAA-BBBB')['client_name']);
        $this->assertSame('http://127.0.0.1:8787/internal/link-codes/LINK-AAAA-BBBB', $this->calls[0]['url']);
        $this->assertNull($c->previewLinkCode('LINK-AAAA-BBBB'));
    }
}
