#!/usr/bin/env bash
# MISSIRIA RC Connector — one-shot installer / upgrader (steps 2–6 of docs/INSTALL.md).
#
# Idempotent: re-run to upgrade. Keys, env file, database and grants are preserved.
#
# Usage:
#   bash install.sh --mcp-host mcp.example.com --webmail-host webmail.example.com \
#                   --rc-dir /var/www/roundcube --email admin@example.com \
#                   [--ref main] [--no-certbot] [--no-plugin] [--dry-run]
set -euo pipefail

REPO_URL="https://github.com/missiria/MISSIRIA-RC-Connector.git"
APP_USER="rcmcp"
APP_HOME="/opt/missiria-rc-connector"
SRC_DIR="$APP_HOME/src"      # root-owned checkout: deploy files root installs come from here
APP_DIR="$APP_HOME/app"      # rcmcp-owned copy of mcp-server where npm runs and node executes
ETC_DIR="/etc/missiria-rc-connector"
KEYS_DIR="$ETC_DIR/keys"
ENV_FILE="$ETC_DIR/env"
DATA_DIR="/var/lib/missiria-rc-connector"
LOG_DIR="/var/log/missiria-rc-connector"
UNIT="missiria-rc-connector"
PORT=8787

MCP_HOST=""; WEBMAIL_HOST=""; RC_DIR=""; ADMIN_EMAIL=""; GIT_REF="main"
CERTBOT=1; PLUGIN=1; DRY=0

usage() { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; }
log()   { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()   { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
run()   { if [[ $DRY -eq 1 ]]; then printf '   [dry-run] %s\n' "$*"; else "$@"; fi; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mcp-host)     MCP_HOST="$2"; shift 2 ;;
    --webmail-host) WEBMAIL_HOST="$2"; shift 2 ;;
    --rc-dir)       RC_DIR="$2"; shift 2 ;;
    --email)        ADMIN_EMAIL="$2"; shift 2 ;;
    --ref)          GIT_REF="$2"; shift 2 ;;
    --no-certbot)   CERTBOT=0; shift ;;
    --no-plugin)    PLUGIN=0; shift ;;
    --dry-run)      DRY=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

[[ -n "$MCP_HOST" && -n "$WEBMAIL_HOST" ]] || die "--mcp-host and --webmail-host are required"
[[ $PLUGIN -eq 0 || -n "$RC_DIR" ]] || die "--rc-dir is required (or pass --no-plugin)"
[[ $CERTBOT -eq 0 || -n "$ADMIN_EMAIL" ]] || die "--email is required for certbot (or pass --no-certbot)"
[[ $EUID -eq 0 ]] || die "run as root"
[[ $PLUGIN -eq 0 || -f "$RC_DIR/config/config.inc.php" ]] || die "$RC_DIR does not look like a Roundcube install (config/config.inc.php missing)"

command -v apt-get >/dev/null || die "this installer targets Debian/Ubuntu (apt-get not found)"

# --- 1. Node.js >= 22.13 ----------------------------------------------------
node_ok() {
  command -v node >/dev/null || return 1
  local v; v="$(node -v | sed 's/^v//')"
  [[ "$(printf '%s\n22.13.0\n' "$v" | sort -V | head -1)" == "22.13.0" ]]
}
if node_ok; then
  log "Node $(node -v) already present"
else
  log "Installing Node.js 22 LTS (NodeSource)"
  run bash -c 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -'
  run apt-get install -y nodejs
fi
for bin in git curl rsync; do
  command -v "$bin" >/dev/null || run apt-get install -y "$bin"
done

# --- 2. User and directories ------------------------------------------------
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  log "Creating system user $APP_USER"
  run useradd --system --home "$APP_HOME" --shell /usr/sbin/nologin "$APP_USER"
fi
run install -d -o root -g "$APP_USER" -m 750 "$APP_HOME"
run install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$DATA_DIR" "$LOG_DIR" "$APP_DIR"
run install -d -o root -g "$APP_USER" -m 750 "$ETC_DIR" "$KEYS_DIR"

# --- 3. Source checkout -----------------------------------------------------
# The checkout stays root-owned and read-only for rcmcp: systemd/nginx/logrotate/plugin files are
# installed by root from here, so a compromised app user cannot plant a unit file or vhost.
if [[ -d "$SRC_DIR/.git" ]]; then
  log "Updating source ($GIT_REF)"
  run git -C "$SRC_DIR" fetch --quiet origin
  run git -C "$SRC_DIR" checkout --quiet "$GIT_REF"
  run git -C "$SRC_DIR" pull --quiet --ff-only origin "$GIT_REF" || true
else
  log "Cloning $REPO_URL ($GIT_REF)"
  run git clone --quiet --branch "$GIT_REF" "$REPO_URL" "$SRC_DIR"
fi
run chown -R root:"$APP_USER" "$SRC_DIR"
run chmod -R g-w,o-rwx "$SRC_DIR"

# npm (and any package scripts) run only as rcmcp, inside its own copy.
log "Building mcp-server in $APP_DIR"
run rsync -a --delete --exclude node_modules --exclude dist "$SRC_DIR/mcp-server/" "$APP_DIR/"
run chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
run sudo -u "$APP_USER" bash -c "cd '$APP_DIR' && npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev --no-audit --no-fund"

# --- 4. Keys and environment ------------------------------------------------
if [[ ! -f "$KEYS_DIR/server.sk" ]]; then
  log "Generating sealing key pair"
  run sudo -u "$APP_USER" node "$APP_DIR/dist/cli.js" keygen --out "$KEYS_DIR"
else
  log "Key pair already present, keeping it"
fi
PUBKEY="(dry-run)"
[[ $DRY -eq 1 ]] || PUBKEY="$(sudo -u "$APP_USER" node "$APP_DIR/dist/cli.js" pubkey --keys "$KEYS_DIR")"

if [[ ! -f "$ENV_FILE" ]]; then
  log "Writing $ENV_FILE"
  INTERNAL_KEY="$(openssl rand -hex 32)"
  JWT_SECRET="$(openssl rand -hex 48)"
  if [[ $DRY -eq 0 ]]; then
    cat > "$ENV_FILE" <<EOT
NODE_ENV=production
PORT=$PORT
BIND=127.0.0.1
PUBLIC_URL=https://$MCP_HOST
WEBMAIL_URL=https://$WEBMAIL_HOST
DB_PATH=$DATA_DIR/connector.sqlite
KEYS_DIR=$KEYS_DIR
INTERNAL_KEY=$INTERNAL_KEY
JWT_SECRET=$JWT_SECRET
IMAP_HOST=127.0.0.1
IMAP_PORT=993
IMAP_TLS=true
SMTP_HOST=127.0.0.1
SMTP_PORT=587
SMTP_STARTTLS=true
ATTACHMENT_MAX_BYTES=5242880
SEND_RATE_PER_HOUR=30
LOG_LEVEL=info
LOG_FILE=$LOG_DIR/server.log
EOT
    chown root:"$APP_USER" "$ENV_FILE"; chmod 640 "$ENV_FILE"
  fi
else
  log "Environment file already present, keeping it"
  INTERNAL_KEY="$(sed -n 's/^INTERNAL_KEY=//p' "$ENV_FILE")"
fi

log "Running database migrations"
run sudo -u "$APP_USER" bash -c "set -a; . '$ENV_FILE'; set +a; node '$APP_DIR/dist/cli.js' migrate"

# --- 5. systemd ---------------------------------------------------------------
log "Installing systemd unit"
run install -m 644 "$SRC_DIR/deploy/systemd/$UNIT.service" "/etc/systemd/system/$UNIT.service"
run install -m 644 "$SRC_DIR/deploy/logrotate/$UNIT" "/etc/logrotate.d/$UNIT"
run systemctl daemon-reload
run systemctl enable --quiet "$UNIT"
run systemctl restart "$UNIT"
if [[ $DRY -eq 0 ]]; then
  sleep 1
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null || { journalctl -u "$UNIT" -n 30 --no-pager; die "service did not come up"; }
  log "Service healthy on 127.0.0.1:$PORT"
fi

# --- 6. nginx + TLS ---------------------------------------------------------
VHOST="/etc/nginx/sites-available/$MCP_HOST.conf"
if [[ ! -f "$VHOST" ]]; then
  log "Installing nginx vhost $VHOST"
  run bash -c "sed 's/mcp\\.example\\.com/$MCP_HOST/g' '$SRC_DIR/deploy/nginx/mcp.example.com.conf' > '$VHOST'"
  run ln -sf "$VHOST" "/etc/nginx/sites-enabled/$MCP_HOST.conf"
else
  log "nginx vhost already present, keeping it"
fi
run nginx -t
run systemctl reload nginx     # reload only — never restart shared web stacks
if [[ $CERTBOT -eq 1 ]]; then
  if [[ -d "/etc/letsencrypt/live/$MCP_HOST" ]]; then
    log "TLS certificate already present"
  else
    log "Requesting TLS certificate for $MCP_HOST"
    command -v certbot >/dev/null || run apt-get install -y certbot python3-certbot-nginx
    run certbot --nginx -d "$MCP_HOST" --non-interactive --agree-tos -m "$ADMIN_EMAIL" --redirect
    run nginx -t
    run systemctl reload nginx
  fi
fi

# --- 7. Roundcube plugin ----------------------------------------------------
if [[ $PLUGIN -eq 1 ]]; then
  PLUGIN_SRC="$SRC_DIR/roundcube-plugin/missiria_rc_connector"
  PLUGIN_DST="$RC_DIR/plugins/missiria_rc_connector"
  WEB_USER="$(stat -c %U "$RC_DIR/config/config.inc.php")"
  log "Installing Roundcube plugin into $PLUGIN_DST (owner $WEB_USER)"
  run install -d "$PLUGIN_DST"
  run rsync -a --delete --exclude config.inc.php --exclude tests --exclude vendor --exclude phpunit.xml.dist "$PLUGIN_SRC/" "$PLUGIN_DST/"
  if [[ ! -f "$PLUGIN_DST/config.inc.php" ]]; then
    log "Writing plugin config.inc.php"
    if [[ $DRY -eq 0 ]]; then
      sed -e "s|https://mcp.example.com|https://$MCP_HOST|" \
          -e "s|http://127.0.0.1:8787|http://127.0.0.1:$PORT|" \
          -e "s|\['rc_connector_internal_key'\] = ''|['rc_connector_internal_key'] = '$INTERNAL_KEY'|" \
          -e "s|\['rc_connector_server_pubkey'\] = ''|['rc_connector_server_pubkey'] = '$PUBKEY'|" \
          "$PLUGIN_SRC/config.inc.php.dist" > "$PLUGIN_DST/config.inc.php"
      chmod 640 "$PLUGIN_DST/config.inc.php"
    fi
  else
    log "Plugin config already present, keeping it"
  fi
  run chown -R "$WEB_USER":"$WEB_USER" "$PLUGIN_DST"

  if grep -q "missiria_rc_connector" "$RC_DIR/config/config.inc.php"; then
    log "Plugin already enabled in Roundcube config"
  else
    log "Enabling plugin in $RC_DIR/config/config.inc.php"
    run php -r '
      $f = $argv[1]; $s = file_get_contents($f);
      $n = preg_replace("/(\\\$config\\[.plugins.\\]\\s*=\\s*(?:\\[|array\\())/", "$1\n    \"missiria_rc_connector\",", $s, 1, $count);
      if (!$count) { $n = $s . "\n\$config[\"plugins\"][] = \"missiria_rc_connector\";\n"; }
      file_put_contents($f, $n);' "$RC_DIR/config/config.inc.php"
  fi
  log "Reloading PHP-FPM (reload only)"
  run bash -c 'systemctl reload "php*-fpm" 2>/dev/null || systemctl reload php-fpm 2>/dev/null || true'
fi

# --- 8. Summary -------------------------------------------------------------
cat <<EOT

MISSIRIA RC Connector is installed.

  MCP endpoint      https://$MCP_HOST/mcp
  OAuth discovery   https://$MCP_HOST/.well-known/oauth-authorization-server
  Service           systemctl status $UNIT
  Logs              journalctl -u $UNIT -f
  Public key        $PUBKEY

Next: log into https://$WEBMAIL_HOST → Settings → AI Connectors.
Connect a platform following docs/CONNECT.md.
EOT
