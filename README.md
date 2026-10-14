# MISSIRIA RC Connector

**Open-source MCP connector for Roundcube.** Lets ChatGPT, Claude, Gemini,
Copilot, Cursor, Codex and any other [Model Context Protocol](https://modelcontextprotocol.io)
client search, read and (with explicit consent) send and organise mail in a
self-hosted Roundcube mailbox, the way first-party connectors already do for
Gmail and Outlook.

> Status: **in development** (phase plan in `docs/ROADMAP.md`). Not yet
> released. Follow the repository to be notified of v1.0.0.

## What you get

- One **Roundcube plugin** (`roundcube-plugin/missiria_rc_connector`) that adds
  a consent screen, CLI token creation and a grant / audit page under
  Settings → AI Connectors.
- One **MCP server** (`mcp-server/`, Node 22 + TypeScript) with OAuth 2.1
  (PKCE + Dynamic Client Registration), Streamable HTTP transport, and IMAP /
  SMTP tools.
- One **install script** and documented commands for a stock nginx + PHP-FPM
  + Dovecot + Postfix VPS (`docs/INSTALL.md`).
- Platform guides for ChatGPT, Claude, Claude Code, Codex CLI, Cursor, VS Code,
  Gemini CLI, n8n (`docs/CONNECT.md`).

## Tools

| Read (`mail:read`) | Write (`mail:write`) | Send (`mail:send`) | Contacts |
|---|---|---|---|
| `list_folders`, `search_messages`, `get_message`, `get_thread`, `get_attachment`, `get_quota`, `search`, `fetch` | `create_draft`, `move_message`, `set_flags`, `delete_message` (to Trash) | `send_message`, `reply_message` | `search_contacts` |

Write and send scopes are opt-in on every consent screen. Permanent delete is
never exposed.

## Security in one paragraph

At consent time the plugin seals the user's IMAP password with the MCP
server's public key (libsodium `crypto_box_seal`). Roundcube stores nothing;
the MCP server stores only the sealed blob and unseals it in memory when it
opens an IMAP session. The server runs as a non-root user bound to
`127.0.0.1`, behind nginx TLS. Every grant is scoped, revocable from webmail,
and every tool call is audit-logged without message bodies. Details:
`docs/ARCHITECTURE.md`, policy: `SECURITY.md`.

## Quick start (admin)

```bash
curl -fsSL https://raw.githubusercontent.com/missiria/MISSIRIA-RC-Connector/main/deploy/install.sh -o install.sh
less install.sh
bash install.sh --mcp-host mcp.example.com --webmail-host webmail.example.com \
  --rc-dir /var/www/roundcube --email admin@example.com
```

Then open Roundcube → Settings → AI Connectors, and connect a platform
following `docs/CONNECT.md`. Full manual steps, checks and troubleshooting:
`docs/INSTALL.md`.

## Repository layout

```
roundcube-plugin/missiria_rc_connector/   PHP plugin (consent, tokens, revoke, audit view)
mcp-server/                               Node/TS MCP + OAuth server
deploy/                                   install.sh, nginx vhost, systemd unit
docs/                                     ARCHITECTURE, INSTALL, CONNECT, ROADMAP
```

## Compatibility

| Component | Supported |
|---|---|
| Roundcube | 1.5, 1.6 (PHP 7.4 – 8.3, `sodium` extension) |
| Node.js | 22.13+ or 24 LTS (built-in `node:sqlite`, no native modules) |
| IMAP / SMTP | Any server Roundcube can log into (Dovecot + Postfix tested) |
| MCP | Streamable HTTP (2025-03-26+), stdio via local proxy |

## Contributing

See `CONTRIBUTING.md`. Security reports: `SECURITY.md`.

## License

MIT © 2026 MISSIRIA / EKSNEKS.
