# Security model — MISSIRIA RC Connector

What the connector protects, who it protects against, and which control covers
each case. Companion to `SECURITY.md` (reporting) and `docs/ARCHITECTURE.md`.

## Assets

| Asset | Where it lives |
|---|---|
| Mailbox password | Sealed blob in the MCP server database; plaintext only in RAM while an IMAP/SMTP session opens |
| Mail content | IMAP server; transits through the MCP server to the AI client per call, never stored |
| OAuth tokens and personal access tokens | Hashed (SHA-256) in the MCP server database; access tokens are stateless HS256 JWTs |
| Server key pair (`server.sk`) | `/etc/missiria-rc-connector/keys`, mode 0600, owner `rcmcp` |
| `INTERNAL_KEY`, `JWT_SECRET` | `/etc/missiria-rc-connector/env` (0640 root:rcmcp) and the plugin `config.inc.php` |

## Adversaries and controls

### 1. Compromised Roundcube / PHP web host

- The plugin stores nothing. A dump of the Roundcube database yields no connector secrets.
- Passwords are sealed with the server **public** key; the web host cannot decrypt what it sealed.
- The plugin only talks to `127.0.0.1:8787/internal/*` with `INTERNAL_KEY`. With that key an
  attacker can create grants **for sessions they already control** (they have the plaintext
  password anyway at that point) and list/revoke grants by username. They cannot read tokens
  (hashed) or sealed blobs (not exposed by the API).

### 2. Compromised MCP server process (`rcmcp`)

- Has the private key, so it can unseal every stored password. This is the trust root of the
  design and the reason the process runs as a dedicated user, bound to loopback, under a
  hardened systemd unit (`ProtectSystem=strict`, `NoNewPrivileges`, `PrivateTmp`, read-only
  install tree).
- Cannot escalate to root through the install tree: the git checkout is root-owned and the
  systemd/nginx/logrotate/plugin files are installed from it by root (see `deploy/install.sh`).
- Mitigation for admins: back up `server.sk` offline; rotate by `keygen --force` + ask users to
  reconnect (all grants become unreadable, which is the intended outcome).

### 3. Stolen bearer token

- Access tokens expire after 1 h; refresh tokens rotate on every use and a replayed refresh
  token is rejected. Both are bound to one grant and its scopes.
- Any token can be revoked by the user from Roundcube (Settings → AI Connectors); the whole grant
  is revoked, so no sibling token survives.
- Personal access tokens (`rcc_…`) never expire by design (CLI use); they are shown once, stored
  hashed, and revocable per label.

### 4. Malicious or over-eager MCP client

- Open dynamic client registration is required by ChatGPT and Claude. Consequences and
  mitigations:
  - A client can choose any `client_name`: the consent screen shows the **redirect host** next
    to the name and warns the name is self-declared.
  - Authorization errors are rendered on the connector's own page, never redirected, so
    `/oauth/authorize` is not an open redirect.
  - PKCE S256 is mandatory; codes are single-use, 120 s, bound to client and redirect URI.
- Scopes are granted per consent; write and send are opt-in and can be disabled server-wide
  (`rc_connector_allow_write=false`, `DISABLE_SEND=true`).
- Send limits: 25 recipients per message, `SEND_RATE_PER_HOUR` per grant (reserved atomically),
  attachment size cap enforced before decoding, request body limit on `/mcp`.
- Permanent deletion is not exposed; `delete_message` moves to Trash only.

### 5. Prompt injection through mail content

- Bodies are returned as data with an explicit `note` marking them untrusted; the server
  `instructions` tell the model never to follow instructions found in emails.
- HTML is sanitised (scripts, styles, forms, remote images, event handlers removed).
- Tool descriptions never ask the model to act on message content.
- Residual risk: an assistant may still be manipulated into calling write tools. Users who
  only need reading should grant `mail:read` alone; admins can run read-only.

### 6. Internet scanner / abuse

- Only `/mcp`, `/oauth/*`, `/.well-known/*`, `/healthz` are proxied; `/internal/*` returns 404
  at nginx and is bound to loopback in the app.
- Consent links are HMAC-signed and expire after 10 minutes.
- Contacts endpoint on Roundcube requires an HMAC over `user|host|ts|q` with a 60 s window and
  resolves exactly one Roundcube user (`username` + `mail_host`).
- Recommended nginx/Cloudflare rate limits are documented in `docs/INSTALL.md` step 1.

## Logging and privacy

- Audit rows: grant, user, tool, folder, outcome, duration, IP. Never subjects, bodies or
  recipients. Retention 90 days (`rc-connector purge`).
- pino redacts `authorization`, `sealed`, `password`, `code`, `refresh_token`, `access_token`.
- Users see their own audit rows in Roundcube.

## Known limitations

- The MCP server is the trust root; there is no HSM/KMS integration.
- A Roundcube admin with filesystem access can read `config.inc.php` (`INTERNAL_KEY`) and the
  session store. This is no worse than their existing access to live sessions.
- Transport security between the MCP server and the mail server follows what Roundcube itself
  uses for that host (`implicit`, `starttls` or `none` on loopback); nothing is downgraded, but
  nothing is upgraded either.
