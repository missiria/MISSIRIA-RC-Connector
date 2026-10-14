<?php

/**
 * Minimal JSON client for the MCP server loopback API (X-Internal-Key).
 * The transport is injectable so the class can be unit-tested without curl.
 */
class rc_connector_internal_client
{
    /** @var string */
    private $baseUrl;
    /** @var string */
    private $key;
    /** @var int */
    private $timeout;
    /** @var callable|null fn(string $method, string $url, array $headers, ?string $body): array{status:int, body:string} */
    private $transport;

    public function __construct(string $baseUrl, string $key, int $timeout = 3, ?callable $transport = null)
    {
        $this->baseUrl   = rtrim($baseUrl, '/');
        $this->key       = $key;
        $this->timeout   = max(1, $timeout);
        $this->transport = $transport;
    }

    /** @return array{status:int, data:mixed} */
    public function request(string $method, string $path, ?array $json = null, array $query = []): array
    {
        $url = $this->baseUrl . '/internal' . $path;
        if ($query) {
            $url .= '?' . http_build_query($query);
        }
        $headers = ['X-Internal-Key: ' . $this->key, 'Accept: application/json'];
        $body    = null;
        if ($json !== null) {
            $body      = json_encode($json, JSON_UNESCAPED_SLASHES);
            $headers[] = 'Content-Type: application/json';
        }
        $res  = $this->transport ? call_user_func($this->transport, $method, $url, $headers, $body) : $this->curl($method, $url, $headers, $body);
        $data = json_decode((string) $res['body'], true);
        return ['status' => (int) $res['status'], 'data' => $data];
    }

    public function healthz(): bool
    {
        try {
            $r = $this->request('GET', '/healthz');
            return $r['status'] === 200 && !empty($r['data']['ok']);
        } catch (Throwable $e) {
            return false;
        }
    }

    public function getAuthRequest(string $id): ?array
    {
        $r = $this->request('GET', '/auth-requests/' . rawurlencode($id));
        return $r['status'] === 200 && is_array($r['data']) ? $r['data'] : null;
    }

    /** @return array{code:string, callback:string} */
    public function createGrant(array $payload): array
    {
        $r = $this->request('POST', '/grants', $payload);
        if ($r['status'] !== 201 || empty($r['data']['code'])) {
            throw new RuntimeException('grant creation failed: ' . $this->describe($r));
        }
        return $r['data'];
    }

    /** @return array{token:string, grant_id:string} */
    public function createPat(array $payload): array
    {
        $r = $this->request('POST', '/pats', $payload);
        if ($r['status'] !== 201 || empty($r['data']['token'])) {
            throw new RuntimeException('token creation failed: ' . $this->describe($r));
        }
        return $r['data'];
    }

    public function listGrants(string $user): array
    {
        $r = $this->request('GET', '/grants', null, ['user' => $user]);
        return $r['status'] === 200 && is_array($r['data']) ? $r['data'] : [];
    }

    public function revokeGrant(string $id, string $user): bool
    {
        $r = $this->request('DELETE', '/grants/' . rawurlencode($id), null, ['user' => $user]);
        return $r['status'] === 200 && !empty($r['data']['revoked']);
    }

    // ---- ADR-002: several mailboxes per connection

    /** @return array{code:string, expires_at:int} */
    public function createLinkCode(string $grantId, string $user): array
    {
        $r = $this->request('POST', '/link-codes', ['grant_id' => $grantId, 'user' => $user]);
        if ($r['status'] !== 201 || empty($r['data']['code'])) {
            throw new RuntimeException('link code creation failed: ' . $this->describe($r));
        }
        return $r['data'];
    }

    /** Preview of the connection a code belongs to; null when unknown, used or expired. */
    public function previewLinkCode(string $code): ?array
    {
        $r = $this->request('GET', '/link-codes/' . rawurlencode($code));
        return $r['status'] === 200 && is_array($r['data']) ? $r['data'] : null;
    }

    /**
     * Links the current mailbox (payload = mailbox facts + sealed password + code + alias).
     * Throws rc_connector_link_exception with the server error code on a 4xx so the UI can
     * translate it (code_invalid, code_used, code_expired, already_linked, alias_taken, invalid_alias).
     */
    public function redeemLinkCode(array $payload): array
    {
        $r = $this->request('POST', '/link-codes/redeem', $payload);
        if ($r['status'] === 201 && !empty($r['data']['alias'])) {
            return $r['data'];
        }
        $err = is_array($r['data']) ? (string) ($r['data']['error'] ?? '') : '';
        if ($r['status'] >= 400 && $r['status'] < 500 && $err !== '') {
            throw new rc_connector_link_exception($err, $r['status']);
        }
        throw new RuntimeException('link failed: ' . $this->describe($r));
    }

    /** Connections other mailboxes have linked this user into. */
    public function listLinks(string $user): array
    {
        $r = $this->request('GET', '/links', null, ['user' => $user]);
        return $r['status'] === 200 && is_array($r['data']) ? $r['data'] : [];
    }

    public function unlinkAccount(string $accountId, string $user): bool
    {
        $r = $this->request('DELETE', '/accounts/' . rawurlencode($accountId), null, ['user' => $user]);
        return $r['status'] === 200 && !empty($r['data']['unlinked']);
    }

    // ---- ADR-003: server-wide reach

    /** @return array{available:bool, configured:bool, count:int} (all false/0 when the server cannot be reached) */
    public function allMailboxesInfo(string $user): array
    {
        $r = $this->request('GET', '/all-mailboxes', null, ['user' => $user]);
        if ($r['status'] === 200 && is_array($r['data'])) {
            return ['available' => !empty($r['data']['available']), 'configured' => !empty($r['data']['configured']), 'count' => (int) ($r['data']['count'] ?? 0)];
        }
        return ['available' => false, 'configured' => false, 'count' => 0];
    }

    /**
     * Switches "all mailboxes" on/off for a connection the user owns.
     * Throws rc_connector_link_exception('not_admin' | 'not_configured' | 'not_found') on a 4xx.
     */
    public function setAllMailboxes(string $grantId, string $user, bool $enabled): array
    {
        $r = $this->request('POST', '/grants/' . rawurlencode($grantId) . '/all-mailboxes', ['user' => $user, 'enabled' => $enabled]);
        if ($r['status'] === 200 && is_array($r['data'])) {
            return $r['data'];
        }
        $err = is_array($r['data']) ? (string) ($r['data']['error'] ?? '') : '';
        if ($r['status'] >= 400 && $r['status'] < 500 && $err !== '') {
            throw new rc_connector_link_exception($err, $r['status']);
        }
        throw new RuntimeException('all-mailboxes switch failed: ' . $this->describe($r));
    }

    public function listAudit(string $user, int $limit): array
    {
        $r = $this->request('GET', '/audit', null, ['user' => $user, 'limit' => $limit]);
        return $r['status'] === 200 && is_array($r['data']) ? $r['data'] : [];
    }

    private function describe(array $r): string
    {
        $err = is_array($r['data']) ? ($r['data']['error'] ?? '') : '';
        $det = is_array($r['data']) ? ($r['data']['detail'] ?? '') : '';
        return 'HTTP ' . $r['status'] . ($err ? ' ' . $err : '') . ($det ? ' (' . $det . ')' : '');
    }

    /** @return array{status:int, body:string} */
    private function curl(string $method, string $url, array $headers, ?string $body): array
    {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST  => $method,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => $this->timeout,
            CURLOPT_TIMEOUT        => $this->timeout,
            CURLOPT_FOLLOWLOCATION => false,
        ]);
        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }
        $out    = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $error  = curl_error($ch);
        curl_close($ch);
        if ($out === false) {
            throw new RuntimeException('MCP server unreachable: ' . $error);
        }
        return ['status' => $status, 'body' => (string) $out];
    }
}

/** A 4xx from the link endpoints; getMessage() is the server error code. */
class rc_connector_link_exception extends RuntimeException
{
}
