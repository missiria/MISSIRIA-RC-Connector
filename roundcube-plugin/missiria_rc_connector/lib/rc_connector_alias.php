<?php

/**
 * Mailbox alias rules shared with the MCP server (ADR-002): the short name users type in
 * chat ("list folders in yazzicars").
 */
class rc_connector_alias
{
    public const PATTERN = '/^[a-z0-9][a-z0-9_-]{0,31}$/';

    public static function isValid(string $alias): bool
    {
        return preg_match(self::PATTERN, $alias) === 1;
    }

    /** Lowercases and strips what the pattern forbids; '' when nothing usable remains. */
    public static function normalize(string $input): string
    {
        $a = strtolower(trim($input));
        $a = preg_replace('/[^a-z0-9_-]+/', '-', $a);
        $a = preg_replace('/^[-_]+|-+$/', '', $a);
        $a = substr($a, 0, 32);
        return self::isValid($a) ? $a : '';
    }

    /** Suggested alias for a mailbox: brand label of its domain (contact@yazzicars.com → yazzicars). */
    public static function suggest(string $username, ?string $email = null): string
    {
        $addr = strtolower($email ?: $username);
        $at   = strrpos($addr, '@');
        if ($at !== false && $at > 0) {
            $labels = array_values(array_filter(explode('.', substr($addr, $at + 1))));
            $n      = count($labels);
            if ($n >= 2) {
                $sld  = $labels[$n - 2];
                $base = (strlen($sld) <= 3 && $n >= 3) ? $labels[$n - 3] : $sld;
            } else {
                $base = substr($addr, 0, $at);
            }
        } else {
            $base = $addr;
        }
        return self::normalize($base) ?: 'mailbox';
    }
}
