<?php

/**
 * HMAC helpers shared with the MCP server (INTERNAL_KEY on both sides).
 *  - consent link:  sig = HMAC-SHA256(key, request_id)
 *  - contacts call: sig = HMAC-SHA256(key, "user|ts|q"), ts within ±60 s
 */
class rc_connector_signature
{
    /** @var string */
    private $key;

    public function __construct(string $key)
    {
        if (strlen($key) < 32) {
            throw new InvalidArgumentException('rc_connector_internal_key must be at least 32 characters');
        }
        $this->key = $key;
    }

    public function verifyConsent(string $requestId, string $sig): bool
    {
        if (!preg_match('/^[0-9a-f]{32}$/', $requestId) || !preg_match('/^[0-9a-f]{64}$/', $sig)) {
            return false;
        }
        return hash_equals(hash_hmac('sha256', $requestId, $this->key), $sig);
    }

    public function verifyContacts(string $user, string $ts, string $q, string $sig, ?int $now = null, int $window = 60): bool
    {
        if (!preg_match('/^\d{9,11}$/', $ts) || !preg_match('/^[0-9a-f]{64}$/', $sig)) {
            return false;
        }
        $now = $now ?? time();
        if (abs($now - (int) $ts) > $window) {
            return false;
        }
        return hash_equals(hash_hmac('sha256', $user . '|' . $ts . '|' . $q, $this->key), $sig);
    }
}
