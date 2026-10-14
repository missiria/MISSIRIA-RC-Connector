# missiria_rc_connector (Roundcube plugin)

Companion plugin of the MISSIRIA RC Connector. It adds:

- a **consent screen** (`?_task=rcconnector&_action=consent`) that the MCP server
  redirects AI platforms to during OAuth;
- **Settings → AI Connectors**: create tokens for CLI tools, see and revoke
  connected apps, read the activity log;
- an HMAC-authenticated **address-book endpoint** used by the `search_contacts` tool.

The plugin stores nothing: the mailbox password is sealed with the MCP server's
public key (`sodium_crypto_box_seal`) at consent time and forwarded once over
loopback. Requirements: Roundcube ≥ 1.5, PHP ≥ 7.4 with `sodium` and `curl`.

Install and configuration: see the repository `docs/INSTALL.md` (step 6).
Config keys: `config.inc.php.dist`.

```bash
composer install && composer test   # unit tests for lib/ (no Roundcube needed)
```
