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
