<?php

/**
 * Normalises Roundcube host settings (imap_host / smtp_host may be "ssl://host:993" style URLs)
 * into {host, port, secure} triples for the MCP server.
 */
class rc_connector_mailhost
{
    public const TLS_IMPLICIT = 'implicit';
    public const TLS_STARTTLS = 'starttls';
    public const TLS_NONE     = 'none';

    /**
     * Mirrors what Roundcube negotiated for this session: storage_ssl is 'ssl' (implicit),
     * 'tls' (STARTTLS) or empty. Never downgrades: a TLS requirement in the config stays a requirement.
     *
     * @return array{host:string, port:int, tls:string}
     */
    public static function imap(string $sessionHost, $sessionPort, $sessionSsl): array
    {
        $parsed = self::parse($sessionHost, 143);
        $port   = (int) ($sessionPort ?: $parsed['port']);
        if ($sessionSsl === 'ssl' || $sessionSsl === true || $parsed['scheme'] === 'ssl' || $parsed['scheme'] === 'imaps' || $port === 993) {
            $tls = self::TLS_IMPLICIT;
        } elseif ($sessionSsl === 'tls' || $parsed['scheme'] === 'tls') {
            $tls = self::TLS_STARTTLS;
        } else {
            $tls = self::plainOrStartTls($parsed['host']);
        }
        return ['host' => $parsed['host'], 'port' => $port, 'tls' => $tls];
    }

    /**
     * Same rules as rcube_smtp: per-IMAP-host arrays must contain the current host, otherwise fail closed.
     * ssl:// or 465 = implicit TLS, tls:// = STARTTLS, anything else = what Roundcube itself uses (plain).
     *
     * @return array{host:string, port:int, tls:string}
     * @throws InvalidArgumentException when no SMTP host is configured for this IMAP host
     */
    public static function smtp($configHost, $configPort, string $imapHost, ?string $rawSessionHost = null): array
    {
        if (is_array($configHost)) {
            if ($rawSessionHost !== null && array_key_exists($rawSessionHost, $configHost)) {
                $configHost = $configHost[$rawSessionHost];
            } elseif (array_key_exists($imapHost, $configHost)) {
                $configHost = $configHost[$imapHost];
            } else {
                throw new InvalidArgumentException('No SMTP server configured for IMAP host ' . $imapHost);
            }
        }
        $host = str_replace('%h', $imapHost, (string) $configHost);
        if (trim($host) === '') {
            $host = 'localhost';
        }
        $parsed = self::parse($host, 587);
        $port   = (int) ($configPort ?: $parsed['port']);
        if ($parsed['scheme'] === 'ssl' || $parsed['scheme'] === 'smtps' || $port === 465) {
            $tls = self::TLS_IMPLICIT;
        } elseif ($parsed['scheme'] === 'tls') {
            $tls = self::TLS_STARTTLS;
        } else {
            $tls = self::plainOrStartTls($parsed['host']);
        }
        return ['host' => $parsed['host'], 'port' => $port, 'tls' => $tls];
    }

    public static function isLoopback(string $host): bool
    {
        $h = strtolower(trim($host, "[] \t"));
        return $h === 'localhost' || $h === '::1' || strpos($h, '127.') === 0;
    }

    /** Plaintext is only ever reported for loopback; a remote host without TLS scheme gets STARTTLS required. */
    private static function plainOrStartTls(string $host): string
    {
        return self::isLoopback($host) ? self::TLS_NONE : self::TLS_STARTTLS;
    }

    /** @return array{scheme:string, host:string, port:int} */
    private static function parse(string $value, int $defaultPort): array
    {
        $value = trim($value);
        if ($value === '') {
            return ['scheme' => '', 'host' => 'localhost', 'port' => $defaultPort];
        }
        if (strpos($value, '://') === false) {
            $value = 'tcp://' . $value;
        }
        $u = parse_url($value);
        if (!$u || empty($u['host'])) {
            return ['scheme' => '', 'host' => 'localhost', 'port' => $defaultPort];
        }
        $scheme = strtolower($u['scheme'] ?? '');
        if ($scheme === 'tcp') {
            $scheme = '';
        }
        $port = isset($u['port']) ? (int) $u['port'] : ($scheme === 'ssl' || $scheme === 'imaps' || $scheme === 'smtps' ? ($defaultPort === 143 ? 993 : 465) : $defaultPort);
        return ['scheme' => $scheme, 'host' => $u['host'], 'port' => $port];
    }
}
