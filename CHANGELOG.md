# Changelog

All notable changes to MISSIRIA RC Connector are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [1.0.1] - 2026-11-04

### Fixed

- `rc-connector --version` printed `0.1.0` because `src/version.ts` was a
  hardcoded string; sync with `package.json` and bump.

## [1.0.0] - 2026-11-04

Published on npm as `@missiria/rc-connector` (user scope). First tagged
release. Open-source MCP connector that gives any AI platform
(ChatGPT, Claude, Codex, Cursor, Copilot, Gemini, n8n) read and write access
to a self-hosted Roundcube mailbox, with OAuth 2.1 consent and per-grant
sealed credentials.

### Server (`mcp-server/`)

- OAuth 2.1 authorization server with PKCE, Dynamic Client Registration and
  discovery documents (`.well-known/oauth-authorization-server`,
  `.well-known/oauth-protected-resource`).
- MCP Streamable HTTP transport with bearer authentication, pooled IMAP
  sessions and SSE-wrapped JSON responses.
- Read tools: `list_folders`, `search_messages`, `get_message`, `get_thread`,
  `get_attachment`, `get_quota`, ChatGPT aliases `search` and `fetch`.
- Write tools: `send_message`, `reply_message`, `save_draft`, `move_message`,
  `set_flags`, `trash_message`, `search_contacts`.
- Multi-mailbox grants (ADR-002): one connection can reach several linked
  Roundcube mailboxes; `alias:folder` and `in:alias` query syntax; results
  advertise the other reachable mailboxes via `mailbox_scope`.
- Server-wide admin reach (ADR-003) pinned to the configured mail endpoint;
  live admin allowlist.
- Reply path restricted to verified identities of the mailbox; replies leave
  from the address that received the message; identities resolved through an
  unambiguous login → system-user mapping.
- Explicit `from` required when several mailboxes are reachable on `send`.
- Three-state TLS mode (`tls`, `starttls`, `none`): `none` is plaintext,
  loopback only, no opportunistic STARTTLS.
- Host-bound contacts lookup, fail-closed SMTP mapping, master credential
  pinned to the configured mail endpoint.
- Sealed-grant store backed by SQLite with migration CLI.
- `rc-connector stdio` local proxy for stdio-only MCP clients
  (newline-delimited JSON-RPC ↔ Streamable HTTP + bearer).
- 78 unit tests across OAuth, crypto, IMAP parsing, pool, directory, store,
  MCP tools and stdio proxy.

### Roundcube plugin (`roundcube-plugin/missiria_rc_connector/`)

- Consent screen, sealed credentials, CLI token issuance, grant revoke and
  audit settings page.
- Registers on both `login` and `settings` tasks so anonymous consent and
  contacts requests reach the startup hook.
- Explicit `require_once` for `lib/` classes (Roundcube does not autoload
  plugin helpers).

### Deploy (`deploy/`)

- `install.sh`: idempotent Debian/Ubuntu installer. Flags
  `--mcp-host --webmail-host --rc-dir --email [--port] [--ref] [--no-certbot] [--no-plugin] [--dry-run]`.
  Installs private Node 22 runtime if the system node is too old; creates the
  `rcmcp` system user; root-owned checkout read-only for `rcmcp`; build in an
  rcmcp-owned `app/` directory; `npm` never runs as root. Keygen in an
  rcmcp-owned temp dir; root moves files and reads `server.pk` as text.
  Symlink-safe plugin install; config written via `install(1)` at final mode
  `0640 root:<webgroup>`. Detects PHP-FPM pool user for plugin readability.
  Waits up to 20 s for the service; `systemctl reload php*-fpm` only (fleet
  rule: never restart php-fpm or Varnish).
- `uninstall.sh` with `--keep-data`.
- nginx vhost template, systemd unit (`ReadOnlyPaths` over the install tree),
  logrotate file.
- Multi-mailbox enable helper (`enable-all-mailboxes.sh`).

### Docs (`docs/`)

- `ARCHITECTURE.md`, `INSTALL.md` (verified live on `mail.eksneks.com`
  2026-10-14), `CONNECT.md` (per-platform instructions for ChatGPT, Claude
  web/Desktop/Code, Codex CLI, Cursor, VS Code Copilot, Gemini CLI, n8n),
  `SECURITY-MODEL.md`, `ROADMAP.md`.
- Banner, social preview, install and chat mockups under `docs/assets/`.

### Security

- CodeQL workflow for the MCP server.
- Plaintext mail transport only to loopback; opportunistic STARTTLS
  otherwise.
- Linked mailbox owners see their own audit log; joining a connection
  requires an explicit confirmation from the owner.

### Known gaps (tracked)

- EKSN-0156 (platform matrix): docs cover every target platform but the live
  verification pass with screenshots is still pending.
- EKSN-0157 (CI, rate limits, audit log retention): security test suite and
  GitHub Actions matrix not yet wired.
- EKSN-0158 follow-ups deferred from this tag: npm publish, Packagist
  listing, Docker image on `ghcr.io`, 2-minute demo recording, public
  announcement posts, `SoftwareApplication` schema page on eksneks.com.

[1.0.1]: https://github.com/missiria/MISSIRIA-RC-Connector/releases/tag/v1.0.1
[1.0.0]: https://github.com/missiria/MISSIRIA-RC-Connector/releases/tag/v1.0.0
