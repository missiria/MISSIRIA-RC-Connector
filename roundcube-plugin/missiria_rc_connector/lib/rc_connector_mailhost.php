<?php

/**
 * Normalises Roundcube host settings (imap_host / smtp_host may be "ssl://host:993" style URLs)
 * into {host, port, secure} triples for the MCP server.
 */
class rc_connector_mailhost
{
    /** @return array{host:string, port:int, secure:bool} */
    public static function imap(string $sessionHost, $sessionPort, $sessionSsl): array
    {
        $parsed = self::parse($sessionHost, 143);
        $port   = (int) ($sessionPort ?: $parsed['port']);
        $secure = $sessionSsl === 'ssl' || $sessionSsl === true || $parsed['scheme'] === 'ssl' || $parsed['scheme'] === 'imaps' || $port === 993;
        return ['host' => $parsed['host'], 'port' => $port, 'secure' => $secure];
    }

    /** @return array{host:string, port:int, secure:bool} secure = implicit TLS (465) */
    public static function smtp($configHost, $configPort, string $imapHost): array
    {
        if (is_array($configHost)) {
            $configHost = $configHost[$imapHost] ?? reset($configHost);
        }
        $host = str_replace('%h', $imapHost, (string) $configHost);
        if ($host === '' || $host === 'localhost' && $configHost === '') {
            $host = 'localhost';
        }
        $parsed = self::parse($host, 587);
        $port   = (int) ($configPort ?: $parsed['port']);
        return ['host' => $parsed['host'], 'port' => $port, 'secure' => $parsed['scheme'] === 'ssl' || $parsed['scheme'] === 'smtps' || $port === 465];
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
        if ($scheme === 'tcp' || $scheme === 'tls') {
            $scheme = '';
        }
        $port = isset($u['port']) ? (int) $u['port'] : ($scheme === 'ssl' || $scheme === 'imaps' || $scheme === 'smtps' ? ($defaultPort === 143 ? 993 : 465) : $defaultPort);
        return ['scheme' => $scheme, 'host' => $u['host'], 'port' => $port];
    }
}
