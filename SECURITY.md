# Security Policy

## Supported versions

Only the latest minor release on the `main` branch receives security fixes.

## Reporting a vulnerability

Do **not** open a public issue for security problems.

Email `security@missiria.com` with:

- affected component (`roundcube-plugin`, `mcp-server`, `deploy`)
- version or commit hash
- reproduction steps and impact

You will get an acknowledgement within 72 hours and a fix or mitigation plan
within 14 days for confirmed issues. Credit is given in the changelog unless
you ask otherwise.

## Security model (summary)

- Mailbox credentials are sealed (libsodium `crypto_box_seal`) with the MCP
  server's public key at consent time. Roundcube never stores them, and the
  MCP server stores only the sealed blob at rest.
- The MCP server runs as a dedicated non-root system user and binds to
  `127.0.0.1` only. nginx terminates TLS.
- All AI platform access goes through OAuth 2.1 with PKCE and per-grant
  scopes. Grants are revocable from the Roundcube settings page.
- Write scopes (`mail:send`, `mail:write`) are opt-in per grant.
- Every tool call is written to an audit log with grant id, tool name and
  outcome. Message bodies are never logged.

See `docs/ARCHITECTURE.md` for details.
