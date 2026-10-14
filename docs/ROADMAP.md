# Roadmap — MISSIRIA RC Connector

Phases are tracked as tickets in the EKSNEKS project (leader.eksneks.com).
Execute in order; P1 and P2 can run in parallel once P0 is pushed.

| Phase | Ticket | Scope | Status |
|---|---|---|---|
| EPIC | EKSN-0149 | Open-source MCP connector for Roundcube, all AI platforms | in progress |
| P0 | EKSN-0150 | Repo bootstrap: licence, ADR-001, docs, CI, VPS discovery | done (discovery pending) |
| P1 | EKSN-0151 | Roundcube plugin: consent, sealed credentials, CLI tokens, revoke, audit page | code done, in review |
| P2 | EKSN-0152 | MCP server: OAuth 2.1 AS (PKCE, DCR, RFC 8414/9728), grant store, internal API | code done, in review |
| P3 | EKSN-0153 | MCP server: Streamable HTTP, auth middleware, IMAP pool, read tools | code done, in review |
| P4 | EKSN-0154 | SMTP send/reply, draft/move/flag/trash, contacts, ChatGPT `search`/`fetch` | code done, in review |
| P5 | EKSN-0155 | install.sh, nginx, systemd, Cloudflare; INSTALL.md verified on the VPS | scripts done, live run pending |
| P6 | EKSN-0156 | Platform onboarding verified: ChatGPT, Claude, Claude Code, Codex, Cursor, VS Code, Gemini, n8n | stdio proxy done, verification pending |
| P7 | EKSN-0157 | Security hardening, audit, rate limits, tests, CI, CodeQL | in progress |
| P8 | EKSN-0158 | v1.0.0: npm, Packagist, Docker, changelog, announcement | todo |
| P9 | EKSN-0159 | Several mailboxes per connection (ADR-002): accounts, aliases, link codes, `list_accounts`, `account` on every tool | live 2026-10-14 |
| P10 | EKSN-0159 | Server-wide reach for admin connections (ADR-003): Dovecot master user, mailbox directory, `all_mailboxes` switch, `enable-all-mailboxes.sh` | code done, live rollout 2026-10-14 |

## v1.1 candidates

- Roundcube identities as `From` on `send_message`
- CalDAV read (calendar plugin users)
- Sieve filter tools (managesieve)
- PostgreSQL store option
- Admin dashboard of grants across users
