# Architecture — MISSIRIA RC Connector

> Status: ADR-001 accepted 2026-10-14. Change this file through a pull request
> that updates the "Decision" section and appends to "History".

## Problem

Hosted assistants (ChatGPT, Claude, Gemini, Copilot) can read Gmail and
Outlook through first-party connectors. A self-hosted Roundcube mailbox on a
VPS has no equivalent. We want one open-source connector that any Roundcube
admin can install so that **every AI platform that speaks MCP** can search,
read, and (with explicit consent) send and organise mail.

## Decision

Two components, one repository, one install script.

```
┌──────────────┐   OAuth 2.1 + MCP (HTTPS)   ┌───────────────────────────┐
│ AI platform  │ ─────────────────────────▶ │ mcp-server (Node 22, TS)   │
│ ChatGPT /    │ ◀───────────────────────── │ mcp.example.com (nginx)    │
│ Claude / ... │                             │  • OAuth 2.1 AS (PKCE,DCR) │
└──────────────┘                             │  • MCP Streamable HTTP     │
                                             │  • IMAP/SMTP via sealed    │
        ┌────────────────────────────────────│    credentials             │
        │  consent redirect (browser)        └────────────┬──────────────┘
        ▼                                                 │ 127.0.0.1 internal API
┌───────────────────────────┐    seals creds with         │ (shared secret)
│ Roundcube + plugin        │    server public key        │
│ webmail.example.com       │ ────────────────────────────┘
│  • consent screen         │
│  • CLI token creation     │             ┌──────────────┐
│  • grant list + revoke    │   IMAP/SMTP │ Dovecot /    │
└───────────────────────────┘ ◀──────────▶│ Postfix      │
                                          └──────────────┘
```

### Component 1 — `roundcube-plugin/missiria_rc_connector` (PHP ≥ 7.4)

A deliberately thin Roundcube plugin. It owns the only two things that need a
logged-in Roundcube session:

| Responsibility | How |
|---|---|
| Consent screen | New task `rcconnector`, action `consent`. Shows client name, requested scopes, Approve / Deny. |
| Credential sealing | On approve: `sodium_crypto_box_seal($rcmail->decrypt($_SESSION['password']), $server_pubkey)`. Posts `{user, imap_host, smtp_host, sealed, scopes, request_id}` to the MCP server internal API. Plaintext never leaves the request. |
| CLI tokens | Settings → "AI Connectors" → "Create CLI token". Same sealing path; the MCP server returns a one-time `rcc_…` personal access token. |
| Grant management | Settings page lists active grants (fetched from the internal API) with Revoke. |
| Audit view | Read-only table of recent tool calls for the current user (fetched from the internal API). |

The plugin stores **nothing** in the Roundcube database: no tables, no secrets.
Grants, tokens and the audit log live on the MCP server and are read over the
loopback API when the settings page renders.

### Component 2 — `mcp-server` (Node 22 LTS, TypeScript)

| Module | Role |
|---|---|
| `oauth/` | OAuth 2.1 Authorization Server: `/oauth/register` (RFC 7591 DCR), `/oauth/authorize` (redirects to Roundcube consent), `/oauth/token` (code + refresh, PKCE S256 mandatory), `/oauth/revoke`, `/.well-known/oauth-authorization-server` (RFC 8414), `/.well-known/oauth-protected-resource` (RFC 9728). |
| `internal/` | Loopback-only API used by the plugin: `POST /internal/grants`, `POST /internal/pats`, `GET /internal/grants?user=`, `DELETE /internal/grants/:id`, `GET /internal/audit?user=`. Authenticated with `X-Internal-Key`. |
| `mcp/` | `@modelcontextprotocol/sdk` server. Streamable HTTP at `/mcp`. Bearer = OAuth access token or `rcc_` PAT. Returns `WWW-Authenticate: Bearer resource_metadata=…` on 401 so clients discover OAuth automatically. |
| `mail/` | `imapflow` + `nodemailer` + `mailparser`. One pooled IMAP connection per grant, idle-closed after 5 min. Credentials unsealed in memory only when a connection opens. |
| `store/` | SQLite via Node's built-in `node:sqlite` (no native build): clients, auth requests, grants (sealed blob), tokens (hashed), audit. |
| `cli` | `rc-connector keygen`, `rc-connector migrate`, `rc-connector stdio --url --token` (local proxy for stdio-only clients). |

### Tools exposed over MCP

| Tool | Scope | Notes |
|---|---|---|
| `list_folders` | `mail:read` | Includes unread/total counts. |
| `search_messages` | `mail:read` | IMAP SEARCH; filters: folder, from, to, subject, text, since, before, unseen, has_attachment; paginated. |
| `get_message` | `mail:read` | Headers + text + sanitised HTML + attachment list. Body size capped. |
| `get_thread` | `mail:read` | Follows References / In-Reply-To. |
| `get_attachment` | `mail:read` | Returns base64 up to a configurable limit (default 5 MB). |
| `search` / `fetch` | `mail:read` | Aliases required by ChatGPT connectors (deep research contract). |
| `search_contacts` | `contacts:read` | Reads Roundcube address book through the plugin internal endpoint. |
| `create_draft` | `mail:write` | Appends to Drafts folder. |
| `send_message` | `mail:send` | SMTP submit; copies to Sent. Always requires explicit scope. |
| `reply_message` | `mail:send` | Sets In-Reply-To / References, quotes original. |
| `move_message` | `mail:write` | |
| `set_flags` | `mail:write` | seen / flagged / answered. |
| `delete_message` | `mail:write` | Moves to Trash. Permanent expunge is **not** exposed. |
| `get_quota` | `mail:read` | |

Scopes: `mail:read`, `mail:write`, `mail:send`, `contacts:read`. Default
consent pre-selects `mail:read` only.

### Authorization flow (hosted AI platform)

1. Platform calls `POST /oauth/register` once (DCR) → `client_id`.
2. Platform sends the user to `/oauth/authorize?...&code_challenge=…`.
3. Server stores the auth request, redirects to
   `https://webmail.example.com/?_task=rcconnector&_action=consent&req=<id>&sig=<hmac>`.
4. Roundcube requires login (standard behaviour). Plugin renders consent.
5. On approve, plugin seals the session password and POSTs the grant to
   `http://127.0.0.1:8787/internal/grants`. Server returns an authorization code.
6. Plugin redirects the browser to `/oauth/callback?req=<id>&code=…`; server
   redirects to the platform `redirect_uri` with `code` + `state`.
7. Platform exchanges code at `/oauth/token` (PKCE verified) → access + refresh.
8. Every MCP call carries the bearer; the server maps it to a grant, unseals
   credentials, opens or reuses an IMAP session, runs the tool, writes audit.

### Authorization flow (local CLI: Claude Code, Codex CLI, Cursor)

1. User opens Roundcube → Settings → AI Connectors → Create CLI token.
2. Plugin seals credentials, POSTs to `/internal/pats`, shows `rcc_…` once.
3. User configures the client with the remote URL and
   `Authorization: Bearer rcc_…`, or runs `rc-connector stdio` as a local
   proxy when the client only supports stdio.

## Alternatives considered

| Option | Why not |
|---|---|
| MCP server speaks IMAP with user-supplied passwords in its own config | No per-user consent, no revocation from webmail, secrets in a config file. |
| Full OAuth server inside the PHP plugin | Roundcube's router is session-centric; unauthenticated token/DCR endpoints need `startup`-hook hacks. Node already has mature OAuth + MCP SDKs, and the team has shipped this exact pattern (leader-app). |
| Store encrypted passwords in the Roundcube DB with `des_key` | Roundcube's key is symmetric and present on the web host; a web-host compromise exposes every stored mailbox. Sealed boxes make the web host unable to decrypt. |
| Dovecot app-passwords | Not available on stock Dovecot; ties the connector to one IMAP server. |

## Non-goals (v1)

- Calendar / CalDAV, tasks, sieve filters.
- Permanent delete / expunge.
- Multi-tenant SaaS hosting of the connector. One install = one Roundcube.

## Deployment shape

- Same VPS as Roundcube. `mcp-server` as systemd service, user `rcmcp`,
  listening on `127.0.0.1:8787`.
- nginx vhost `mcp.example.com` → proxy, SSE-safe (`proxy_buffering off`).
- Separate hostname on purpose: Cloudflare bot rules can be relaxed for
  `mcp.example.com` only (hostname-scoped Skip rule), as learned on
  leader.eksneks.com (EKSN-0028).

## History

- 2026-10-14 — ADR-001 accepted (initial architecture).
