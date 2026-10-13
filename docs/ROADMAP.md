# Roadmap — MISSIRIA RC Connector

Phases are tracked as tickets in the EKSNEKS project (leader.eksneks.com).
Execute in order; P1 and P2 can run in parallel once P0 is pushed.

| Phase | Ticket | Scope | Status |
|---|---|---|---|
| EPIC | EKSN-0149 | Open-source MCP connector for Roundcube, all AI platforms | todo |
| P0 | EKSN-0150 | Repo bootstrap: licence, ADR-001, docs, CI stub, VPS discovery | docs drafted, push pending |
| P1 | EKSN-0151 | Roundcube plugin: consent, sealed credentials, CLI tokens, revoke, audit page | todo |
| P2 | EKSN-0152 | MCP server: OAuth 2.1 AS (PKCE, DCR, RFC 8414/9728), grant store, internal API | todo |
| P3 | EKSN-0153 | MCP server: Streamable HTTP, auth middleware, IMAP pool, read tools | todo |
| P4 | EKSN-0154 | SMTP send/reply, draft/move/flag/trash, contacts, ChatGPT `search`/`fetch` | todo |
| P5 | EKSN-0155 | install.sh, nginx, systemd, Cloudflare; INSTALL.md verified on the VPS | todo |
| P6 | EKSN-0156 | Platform onboarding verified: ChatGPT, Claude, Claude Code, Codex, Cursor, VS Code, Gemini, n8n | todo |
| P7 | EKSN-0157 | Security hardening, audit, rate limits, tests, CI, CodeQL | todo |
| P8 | EKSN-0158 | v1.0.0: npm, Packagist, Docker, changelog, announcement | todo |

## v1.1 candidates

- Roundcube identities as `From` on `send_message`
- CalDAV read (calendar plugin users)
- Sieve filter tools (managesieve)
- Multi-account grants
- PostgreSQL store option
- Admin dashboard of grants across users
