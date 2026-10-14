# Server installation — MISSIRIA RC Connector

Target: a VPS that already runs **Roundcube** behind **nginx + PHP-FPM** with
**Dovecot** (IMAP) and **Postfix** (SMTP). Tested shapes: Ubuntu 20.04 /
22.04 / 24.04, Debian 12.

Replace these placeholders everywhere:

| Placeholder | Meaning | Example |
|---|---|---|
| `WEBMAIL_HOST` | existing Roundcube hostname | `webmail.example.com` |
| `MCP_HOST` | new hostname for the connector | `mcp.example.com` |
| `RC_DIR` | Roundcube install dir | `/var/www/roundcube` |
| `ADMIN_EMAIL` | Let's Encrypt contact | `admin@example.com` |

Everything below runs as `root` (or with `sudo`). Commands are grouped per
step; each step ends with a **Check** you should run before moving on.

---

## 0. Discovery — know your server first

```bash
# OS, web stack, PHP and Roundcube versions
lsb_release -ds
nginx -v
php -v | head -1
php -m | grep -iE '^(sodium|pdo_mysql|pdo_sqlite|intl|mbstring)$'
grep -rl "roundcube" /etc/nginx/sites-enabled/ | head
RC_DIR=$(dirname "$(grep -rls 'RCMAIL_VERSION' /var/www --include=iniset.php 2>/dev/null | head -1)")/..; echo "RC_DIR=$RC_DIR"
grep -oE "RCMAIL_VERSION', '[^']+" "$RC_DIR/program/include/iniset.php"

# Mail services
systemctl is-active dovecot postfix
ss -ltnp | grep -E ':(143|993|25|465|587)\b'

# Existing Node (the connector needs 22.13 or newer)
node -v 2>/dev/null || echo "no node"
```

**Check**: PHP ≥ 7.4 with `sodium` listed; Roundcube ≥ 1.5; Dovecot and
Postfix `active`. If `sodium` is missing: `apt install php$(php -r 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;')-sodium`.

---

## 1. DNS and Cloudflare

1. Create an `A` (and `AAAA` if used) record `MCP_HOST` → your VPS IP.
2. If the zone is on Cloudflare:
   - Keep `MCP_HOST` **proxied** (orange cloud) or DNS-only; both work.
   - Security → Bots: **Block AI Bots = OFF** for this hostname. ChatGPT's
     connector fetches with `User-Agent: ChatGPT-User`, which this toggle
     blocks before any custom rule runs.
   - Add a Custom Rule, highest priority:
     expression `(http.host eq "MCP_HOST")`, action **Skip** → all remaining
     custom rules, Rate Limiting, Managed Rules, UA Blocking, Super Bot Fight
     Mode.
   - Add a Configuration Rule for `MCP_HOST`: Browser Integrity Check OFF,
     Rocket Loader OFF, Security Level Essentially Off.
   - Optional scoped rate limit: path `/oauth/register`, 20 req / 10 min / IP
     → Managed Challenge.

**Check**:

```bash
dig +short MCP_HOST
curl -sI -H 'User-Agent: ChatGPT-User/1.0' https://MCP_HOST/ | head -1   # must not be 403 (502/404 is fine before step 5)
```

---

## 2. Node.js 22 LTS (or 24)

```bash
# NodeSource (system-wide, works with systemd). No compiler needed: the connector
# uses Node's built-in SQLite (node:sqlite), so there are no native modules to build.
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node -v && npm -v
```

**Check**: `node -v` prints `v22.13` or newer (`v24.x` also fine).

---

## 3. Dedicated system user and directories

```bash
useradd --system --home /opt/missiria-rc-connector --shell /usr/sbin/nologin rcmcp
install -d -o rcmcp -g rcmcp -m 750 /opt/missiria-rc-connector
install -d -o rcmcp -g rcmcp -m 750 /var/lib/missiria-rc-connector      # SQLite DB
install -d -o root  -g rcmcp -m 750 /etc/missiria-rc-connector         # env + keys
install -d -o root  -g rcmcp -m 750 /etc/missiria-rc-connector/keys
install -d -o rcmcp -g rcmcp -m 750 /var/log/missiria-rc-connector
```

Never run the connector as `root`. It only needs to read its keys and write
its database and log.

---

## 4. Install the MCP server

```bash
cd /opt/missiria-rc-connector
sudo -u rcmcp git clone https://github.com/missiria/MISSIRIA-RC-Connector.git src
cd src/mcp-server
sudo -u rcmcp npm ci --omit=dev
sudo -u rcmcp npm run build
```

### 4.1 Generate the sealing key pair

```bash
sudo -u rcmcp node dist/cli.js keygen --out /etc/missiria-rc-connector/keys
# → writes server.sk (private, 0600, rcmcp) and prints the PUBLIC key:
#   RC_CONNECTOR_SERVER_PUBKEY=base64:....
```

Copy the public key: the Roundcube plugin needs it (step 6). The private key
never leaves this directory.

### 4.2 Environment file

```bash
INTERNAL_KEY=$(openssl rand -hex 32)
JWT_SECRET=$(openssl rand -hex 48)
cat > /etc/missiria-rc-connector/env <<EOT
NODE_ENV=production
PORT=8787
BIND=127.0.0.1
PUBLIC_URL=https://MCP_HOST
WEBMAIL_URL=https://WEBMAIL_HOST
DB_PATH=/var/lib/missiria-rc-connector/connector.sqlite
KEYS_DIR=/etc/missiria-rc-connector/keys
INTERNAL_KEY=${INTERNAL_KEY}
JWT_SECRET=${JWT_SECRET}
IMAP_HOST=127.0.0.1
IMAP_PORT=993
IMAP_TLS=true
SMTP_HOST=127.0.0.1
SMTP_PORT=587
SMTP_STARTTLS=true
ATTACHMENT_MAX_BYTES=5242880
LOG_LEVEL=info
LOG_FILE=/var/log/missiria-rc-connector/server.log
EOT
chown root:rcmcp /etc/missiria-rc-connector/env && chmod 640 /etc/missiria-rc-connector/env
echo "INTERNAL_KEY=${INTERNAL_KEY}"   # keep for step 6
```

`IMAP_HOST` / `SMTP_HOST` default to the same values Roundcube uses. If your
Roundcube talks to a remote mail server, copy `imap_host` / `smtp_host` from
`RC_DIR/config/config.inc.php`.

### 4.3 Database migration

```bash
set -a; . /etc/missiria-rc-connector/env; set +a
sudo -E -u rcmcp node dist/cli.js migrate
```

### 4.4 systemd unit

```bash
cp /opt/missiria-rc-connector/src/deploy/systemd/missiria-rc-connector.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now missiria-rc-connector
systemctl status missiria-rc-connector --no-pager | head -12
```

**Check**:

```bash
curl -s http://127.0.0.1:8787/healthz            # {"ok":true,"version":"..."}
curl -s http://127.0.0.1:8787/.well-known/oauth-authorization-server | head -c 300
journalctl -u missiria-rc-connector -n 20 --no-pager
```

---

## 5. nginx vhost + TLS

```bash
cp /opt/missiria-rc-connector/src/deploy/nginx/mcp.example.com.conf /etc/nginx/sites-available/MCP_HOST.conf
sed -i 's/mcp\.example\.com/MCP_HOST/g' /etc/nginx/sites-available/MCP_HOST.conf
ln -s /etc/nginx/sites-available/MCP_HOST.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d MCP_HOST --non-interactive --agree-tos -m ADMIN_EMAIL --redirect
nginx -t && systemctl reload nginx
```

The shipped vhost proxies `/mcp`, `/oauth/*` and `/.well-known/*` to
`127.0.0.1:8787` with `proxy_buffering off`, `proxy_read_timeout 3600s` and
`Connection ''` so Server-Sent Events streams stay open.

> If your fleet runs Varnish in front of nginx: do **not** restart varnish or
> php-fpm here. Add the vhost, `nginx -t`, then `systemctl reload nginx` only.

**Check**:

```bash
curl -s https://MCP_HOST/healthz
curl -si https://MCP_HOST/mcp | head -5            # expect 401 with WWW-Authenticate: Bearer resource_metadata=...
curl -s https://MCP_HOST/.well-known/oauth-protected-resource | head -c 300
```

---

## 6. Install the Roundcube plugin

```bash
RC_DIR=/var/www/roundcube                        # from step 0
cp -r /opt/missiria-rc-connector/src/roundcube-plugin/missiria_rc_connector "$RC_DIR/plugins/"
chown -R www-data:www-data "$RC_DIR/plugins/missiria_rc_connector"

cp "$RC_DIR/plugins/missiria_rc_connector/config.inc.php.dist" "$RC_DIR/plugins/missiria_rc_connector/config.inc.php"
```

Edit `RC_DIR/plugins/missiria_rc_connector/config.inc.php`:

```php
<?php
// URL of the MCP server as seen by the browser
$config['rc_connector_public_url']   = 'https://MCP_HOST';
// Loopback URL used server-to-server (plugin → MCP internal API)
$config['rc_connector_internal_url'] = 'http://127.0.0.1:8787';
// INTERNAL_KEY from /etc/missiria-rc-connector/env
$config['rc_connector_internal_key'] = 'PASTE_INTERNAL_KEY';
// PUBLIC key printed by `rc-connector keygen` (base64:...)
$config['rc_connector_server_pubkey'] = 'base64:PASTE_PUBLIC_KEY';
// Scopes pre-selected on the consent screen
$config['rc_connector_default_scopes'] = ['mail:read'];
// Allow users to grant send/write scopes (false = read-only connector)
$config['rc_connector_allow_write']  = true;
```

Enable the plugin:

```bash
# Add to the plugins array in RC_DIR/config/config.inc.php
php -r '
$f="'"$RC_DIR"'/config/config.inc.php"; $s=file_get_contents($f);
if (strpos($s,"missiria_rc_connector")===false) {
  $s=preg_replace("/\\\$config\\[.plugins.\\]\\s*=\\s*(\\[|array\\()/", "$0\n    \"missiria_rc_connector\",", $s, 1);
  file_put_contents($f,$s); echo "plugin enabled\n";
} else echo "already enabled\n";'

# PHP opcache: reload FPM, never restart on a shared fleet host
systemctl reload php*-fpm
```

Expose the connector consent URL without the `?_task` query string (optional,
nicer links). In the Roundcube nginx vhost:

```nginx
location = /ai-connectors { return 302 /?_task=settings&_action=plugin.rc_connector; }
```

**Check**: log into Roundcube → Settings → **AI Connectors** appears and shows
"Server: connected" (the plugin calls `GET /internal/healthz` with the key).

---

## 7. First end-to-end test

```bash
# 1. Dynamic client registration (what ChatGPT / Claude do automatically)
curl -s -X POST https://MCP_HOST/oauth/register -H 'Content-Type: application/json' \
  -d '{"client_name":"smoke-test","redirect_uris":["http://127.0.0.1:9/cb"],"token_endpoint_auth_method":"none"}'
# → {"client_id":"...","redirect_uris":[...]}
```

2. In Roundcube, Settings → AI Connectors → **Create CLI token** → copy `rcc_…`.
3. Call the MCP endpoint with it:

```bash
TOKEN=rcc_xxx
curl -s https://MCP_HOST/mcp -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
curl -s https://MCP_HOST/mcp -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | head -c 600
```

4. Revoke the token from the same settings page and re-run step 3 → `401`.

Then connect a real platform: see `docs/CONNECT.md`.

---

## 8. Operations

```bash
# Logs
journalctl -u missiria-rc-connector -f
tail -f /var/log/missiria-rc-connector/server.log

# Upgrade
cd /opt/missiria-rc-connector/src && sudo -u rcmcp git pull --ff-only
cd mcp-server && sudo -u rcmcp npm ci --omit=dev && sudo -u rcmcp npm run build
set -a; . /etc/missiria-rc-connector/env; set +a; sudo -E -u rcmcp node dist/cli.js migrate
systemctl restart missiria-rc-connector
rsync -a --delete ../roundcube-plugin/missiria_rc_connector/ "$RC_DIR/plugins/missiria_rc_connector/" \
  --exclude config.inc.php && systemctl reload php*-fpm

# Backup (sealed grants + tokens; useless without keys/server.sk, which you back up separately and offline)
sqlite3 /var/lib/missiria-rc-connector/connector.sqlite ".backup '/root/rc-connector-$(date +%F).sqlite'"

# Rotate the internal key (plugin + env must change together)
NEW=$(openssl rand -hex 32); sed -i "s/^INTERNAL_KEY=.*/INTERNAL_KEY=$NEW/" /etc/missiria-rc-connector/env
sed -i "s/rc_connector_internal_key'\] = '.*'/rc_connector_internal_key'] = '$NEW'/" "$RC_DIR/plugins/missiria_rc_connector/config.inc.php"
systemctl restart missiria-rc-connector && systemctl reload php*-fpm

# Uninstall
systemctl disable --now missiria-rc-connector
rm -f /etc/systemd/system/missiria-rc-connector.service /etc/nginx/sites-enabled/MCP_HOST.conf
rm -rf /opt/missiria-rc-connector /var/lib/missiria-rc-connector /etc/missiria-rc-connector /var/log/missiria-rc-connector
rm -rf "$RC_DIR/plugins/missiria_rc_connector"   # and remove it from config.inc.php plugins[]
systemctl reload nginx php*-fpm; userdel rcmcp
```

---

## 9. One-shot installer

`deploy/install.sh` runs steps 2–6 non-interactively (Debian/Ubuntu):

```bash
curl -fsSL https://raw.githubusercontent.com/missiria/MISSIRIA-RC-Connector/main/deploy/install.sh -o install.sh
less install.sh      # read it first
bash install.sh --mcp-host MCP_HOST --webmail-host WEBMAIL_HOST --rc-dir RC_DIR --email ADMIN_EMAIL
```

Flags: `--ref <tag|branch>` (default `main`), `--no-certbot`, `--no-plugin`, `--dry-run`.
It is idempotent: re-running updates code, keeps keys, env and grants.
`deploy/uninstall.sh --mcp-host MCP_HOST --rc-dir RC_DIR [--keep-data]` reverses it.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `403` from `https://MCP_HOST/oauth/register` with `server: cloudflare` | Cloudflare "Block AI Bots" or UA blocking | Step 1 hostname-scoped Skip rule; toggles off. |
| Consent page says "Server unreachable" | `INTERNAL_KEY` mismatch or service down | Compare key in env vs plugin config; `systemctl status`. |
| `tools/call` → `IMAP auth failed` after password change | Sealed credentials hold the old password | User revokes grant and re-consents. Expected by design. |
| SSE stream closes after 60 s | nginx `proxy_read_timeout` default | Use shipped vhost (`3600s`, `proxy_buffering off`). |
| `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` on start | Node older than 22.13 | Step 2: install Node 22 LTS or 24. |
| Roundcube shows blank settings page | PHP `sodium` extension missing | `apt install php8.x-sodium && systemctl reload php*-fpm`. |
| Consent page loops back to login | Plugin not listed in `$config['plugins']` or `rcconnector` task blocked | Check step 6 enable block; `tail -f $RC_DIR/logs/errors.log`. |
