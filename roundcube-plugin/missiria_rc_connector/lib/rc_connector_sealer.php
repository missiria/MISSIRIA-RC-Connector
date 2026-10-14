<?php

/**
 * Seals the mailbox password with the MCP server public key (libsodium sealed box).
 * The plugin never stores the plaintext or the sealed blob; it only forwards the blob once.
 */
class rc_connector_sealer
{
    /** @var string 32 raw bytes */
    private $publicKey;

    public function __construct(string $encodedPublicKey)
    {
        $raw = $encodedPublicKey;
        if (strpos($raw, 'base64:') === 0) {
            $raw = substr($raw, 7);
        }
        $decoded = base64_decode(trim($raw), true);
        if ($decoded === false || strlen($decoded) !== SODIUM_CRYPTO_BOX_PUBLICKEYBYTES) {
            throw new InvalidArgumentException('rc_connector_server_pubkey must be a base64 32-byte key');
        }
        $this->publicKey = $decoded;
    }

    /** Returns base64 of sodium_crypto_box_seal($plaintext). Wipes $plaintext. */
    public function seal(string &$plaintext): string
    {
        $sealed = sodium_crypto_box_seal($plaintext, $this->publicKey);
        sodium_memzero($plaintext);
        return base64_encode($sealed);
    }
}
