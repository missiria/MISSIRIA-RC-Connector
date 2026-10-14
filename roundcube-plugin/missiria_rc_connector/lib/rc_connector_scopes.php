<?php

class rc_connector_scopes
{
    public const ALL   = ['mail:read', 'mail:write', 'mail:send', 'contacts:read'];
    public const WRITE = ['mail:write', 'mail:send'];

    /** Scopes the user may actually be offered: requested ∩ known, minus write scopes when disallowed. */
    public static function offerable(array $requested, bool $allowWrite): array
    {
        $out = [];
        foreach ($requested as $s) {
            if (!in_array($s, self::ALL, true)) {
                continue;
            }
            if (!$allowWrite && in_array($s, self::WRITE, true)) {
                continue;
            }
            $out[] = $s;
        }
        return array_values(array_unique($out));
    }

    /** Final granted set: what the user ticked ∩ what was offerable. Never escalates. */
    public static function granted(array $ticked, array $offerable): array
    {
        return array_values(array_intersect($offerable, array_map('strval', $ticked)));
    }

    public static function isWrite(string $scope): bool
    {
        return in_array($scope, self::WRITE, true);
    }
}
