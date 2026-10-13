# Contributing

Thanks for helping make Roundcube reachable from AI assistants.

## Ground rules

- Open an issue before a large change so the design can be discussed.
- One feature or fix per pull request.
- Tests are required: PHPUnit for `roundcube-plugin/`, Vitest for `mcp-server/`.
- No credentials, hostnames or real mailbox data in fixtures. Use `example.com`.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`), one logical change per commit.

## Development setup

```bash
git clone https://github.com/missiria/MISSIRIA-RC-Connector.git
cd MISSIRIA-RC-Connector

# MCP server
cd mcp-server
npm ci
npm test
npm run dev          # Streamable HTTP on http://127.0.0.1:8787/mcp

# Roundcube plugin (needs a local Roundcube checkout)
cd ../roundcube-plugin
composer install
vendor/bin/phpunit
```

A `docker-compose.dev.yml` with Roundcube + Dovecot + Postfix test mail is
part of the roadmap (see `docs/ROADMAP.md`).

## Code style

- TypeScript: strict mode, ESLint + Prettier (`npm run lint`).
- PHP: PSR-12, PHP 7.4 compatible syntax (Roundcube 1.5/1.6 targets).

## Releases

Maintainers cut releases with `release-please`. Do not bump versions in PRs.
