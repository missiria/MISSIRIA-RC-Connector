# Connecting AI platforms — MISSIRIA RC Connector

All hosted platforms use the same two values:

| Value | Example |
|---|---|
| MCP server URL | `https://mcp.example.com/mcp` |
| Auth | OAuth (automatic: Dynamic Client Registration + PKCE) **or** a CLI token `rcc_…` as `Authorization: Bearer` |

The consent screen always opens in your Roundcube webmail. Approve only the
scopes you need. `mail:read` is enough for "read and summarise my mail".

---

## Several mailboxes, one connector

You do not need one connector per mailbox. A connection can reach every
mailbox you own on the same Roundcube, each under a short **alias** you say in
chat: "list folders in yazzicars", "search eksneks for invoices", "reply from
rifcars". Without an alias the assistant uses the mailbox you connected first
(the *main* mailbox). `list_accounts` tells the assistant which aliases exist.

Linking another mailbox (once per mailbox, about 30 seconds):

1. Logged in as the main mailbox: Settings → **AI Connectors** → on the
   connection row click **Add mailbox**. A one-time code `LINK-XXXX-XXXX`
   appears (valid 10 minutes).
2. Log out, log in to the mailbox to add, Settings → **AI Connectors** →
   **Join a connection**: paste the code, pick the alias, **Join**.
3. Back in the chat, ask for that alias. No reconnect needed in ChatGPT or
   Claude.

The second mailbox's password is sealed from its own Roundcube session, exactly
like the first one; nothing is typed or copied between mailboxes. Either side
can **Unlink** later; revoking the connection removes every linked mailbox.

### Every mailbox of the server, no linking (admins)

If you run the server yourself and all mailboxes are yours, your admin can
enable server-wide reach (docs/INSTALL.md §8b). Then, on your connection row,
click **All mailboxes (N)** once. From there:

- "list my accounts" → every mailbox of the server with its alias
  (`yazzicars`, `eksneks-billing`, …).
- "unread in iptv-premium-europe", "search yazzicars for invoices", "reply from
  rifcars" → the assistant passes the alias, the address or just the domain.
- No alias → your main mailbox, as before. "search everywhere" fans out across
  all of them.
- Sending never guesses: with several mailboxes reachable, `send_message` and
  `reply_message` are refused until the assistant names the sender (`from:
  contact@iptv-premium-europe.com`, `account`, or a folder prefix on replies).
  Say "send from contact@iptv-premium-europe.com to …" and the mail leaves
  under that brand with a copy in that mailbox's Sent folder.
- If an assistant keeps answering from the main mailbox, give it the selector
  inline: "search in:iptv-premium-europe for renewals", or folder
  `iptv-premium-europe:INBOX`. The server understands `in:`, `account:` and
  `mailbox:` prefixes and folder prefixes on every tool.

**Linked mailboxes only** switches it off again at any time. The button is
only shown to the logins your admin listed; everyone else keeps link codes.

---

## ChatGPT (Connectors / Apps)

Requirements: ChatGPT Plus, Pro, Team, Enterprise or Edu; **Developer mode**
enabled (Settings → Connectors → Advanced → Developer mode).

1. Settings → **Connectors** → **Create**.
2. Name: `Roundcube (mcp.example.com)`. MCP Server URL: `https://mcp.example.com/mcp`.
3. Authentication: **OAuth**. Leave client id / secret empty (DCR fills them).
4. Click **Create** → a Roundcube tab opens → log in → **Approve**.
5. In a chat, open the `+` menu → enable the connector → ask
   "Search my mailbox for invoices from last week".

Deep research needs the `search` and `fetch` tools; the connector exposes both.

If creation fails with HTTP 403 before the consent screen appears, Cloudflare
is blocking `ChatGPT-User`. See `docs/INSTALL.md` step 1.

---

## Claude (claude.ai web / Claude Desktop)

1. Settings → **Connectors** → **Add custom connector**.
2. Name: `Roundcube`. Remote MCP server URL: `https://mcp.example.com/mcp`.
3. Leave OAuth client id / secret empty → **Add** → **Connect** → Roundcube
   consent → Approve.
4. In a chat, the tools appear under the connector name. Enable the write
   tools only when needed.

Team / Enterprise admins can publish the connector organisation-wide.

## Claude Code (CLI)

OAuth (recommended):

```bash
claude mcp add --transport http roundcube https://mcp.example.com/mcp
# then inside Claude Code: /mcp → roundcube → Authenticate
```

CLI token (headless servers, CI):

```bash
claude mcp add --transport http roundcube https://mcp.example.com/mcp \
  --header "Authorization: Bearer rcc_xxxxxxxx"
```

---

## OpenAI Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.roundcube]
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "RC_CONNECTOR_TOKEN"
```

```bash
export RC_CONNECTOR_TOKEN=rcc_xxxxxxxx
codex
```

---

## Cursor

`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "roundcube": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer rcc_xxxxxxxx" }
    }
  }
}
```

Cursor also supports OAuth: omit `headers` and click **Connect** in
Settings → MCP.

---

## VS Code (GitHub Copilot agent mode)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "roundcube": {
      "type": "http",
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

VS Code starts the OAuth flow on first use.

---

## Google Gemini CLI

`~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "roundcube": {
      "httpUrl": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer rcc_xxxxxxxx" }
    }
  }
}
```

Gemini web app custom connectors: follow the same URL + OAuth pattern once
custom MCP connectors are available on your plan.

---

## Any stdio-only client (local proxy)

```bash
npx -y missiria-rc-connector stdio --url https://mcp.example.com/mcp --token rcc_xxxxxxxx
```

Claude Desktop `claude_desktop_config.json` example:

```json
{
  "mcpServers": {
    "roundcube": {
      "command": "npx",
      "args": ["-y", "missiria-rc-connector", "stdio", "--url", "https://mcp.example.com/mcp"],
      "env": { "RC_CONNECTOR_TOKEN": "rcc_xxxxxxxx" }
    }
  }
}
```

---

## n8n / automation

Use the **MCP Client** node with Streamable HTTP, URL
`https://mcp.example.com/mcp`, auth header `Authorization: Bearer rcc_…`.
Create a dedicated CLI token per workflow so it can be revoked alone.

---

## Revoking access

Roundcube → Settings → **AI Connectors** → Revoke next to the grant. The
platform's next call receives `401` and will prompt to reconnect.
