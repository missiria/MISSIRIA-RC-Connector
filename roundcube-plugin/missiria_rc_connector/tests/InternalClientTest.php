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
}
