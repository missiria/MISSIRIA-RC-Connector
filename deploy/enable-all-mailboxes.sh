#!/usr/bin/env bash
# MISSIRIA RC Connector — ADR-003 "all mailboxes" mode (Dovecot master user).
#
# Lets admin connections reach every mailbox of this server by name, without linking each one.
# Run as root on the mail host, after install.sh.
#
# Usage:
#   bash enable-all-mailboxes.sh --admin contact@example.com[,other@example.com]
#                                [--master-user rccmaster] [--imap-port 143] [--rotate] [--disable]
#
# What it does (idempotent; re-run to add admins or rotate the secret):
#   1. creates a Dovecot master user (random secret, SHA512-CRYPT in /etc/dovecot/master-users)
#      and a conf.d drop-in enabling master logins "<mailbox>*<master user>"; reloads Dovecot
#   2. stores the secret in /etc/missiria-rc-connector/master.secret (root:rcmcp 0640)
#   3. generates /etc/missiria-rc-connector/mailboxes from `doveadm user '*'` and installs an
#      hourly cron job that keeps it fresh
#   4. writes ALL_MAILBOXES_* / MAILBOX_DIRECTORY into the env file and restarts the connector
#   5. self-test: opens one mailbox through the master login with the connector's own IMAP library
# --disable reverts all of it (Dovecot drop-in, secret, cron, env keys) and restarts the connector.
#
# Security note: the master secret reaches every mailbox. Only the connector service user can read
# it; a compromise of that process exposes all mailboxes (see docs/SECURITY-MODEL.md).
# The connector sends that secret only to IMAP_HOST/IMAP_PORT/IMAP_TLS and SMTP_HOST/SMTP_PORT/
# SMTP_STARTTLS from the env file (never to hosts stored on a grant). Set them to the endpoint
# Roundcube itself uses (e.g. IMAP 127.0.0.1:143 with IMAP_TLS=false; SMTP mail.example.com:587
# with SMTP_STARTTLS=true) before running this script; the self-test uses --imap-port.
set -euo pipefail

APP_USER="rcmcp"
APP_HOME="/opt/missiria-rc-connector"
APP_DIR="$APP_HOME/app"
ETC_DIR="/etc/missiria-rc-connector"
ENV_FILE="$ETC_DIR/env"
SECRET_FILE="$ETC_DIR/master.secret"
DIR_FILE="$ETC_DIR/mailboxes"
IDENT_FILE="$ETC_DIR/identities"
CRON_FILE="/etc/cron.hourly/missiria-rc-connector-mailboxes"
UNIT="missiria-rc-connector"
DOVECOT_MASTER_FILE="/etc/dovecot/master-users"
DOVECOT_DROPIN="/etc/dovecot/conf.d/auth-rcc-master.conf"

ADMINS=""; MASTER_USER="rccmaster"; IMAP_PORT="143"; ROTATE=0; DISABLE=0

usage() { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; }
log()   { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()   { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --admin)       ADMINS="$2"; shift 2 ;;
    --master-user) MASTER_USER="$2"; shift 2 ;;
    --imap-port)   IMAP_PORT="$2"; shift 2 ;;
    --rotate)      ROTATE=1; shift ;;
    --disable)     DISABLE=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "run as root"
[[ -f "$ENV_FILE" ]] || die "$ENV_FILE not found — run install.sh first"
command -v doveadm >/dev/null || die "doveadm not found: this script supports Dovecot only"
command -v doveconf >/dev/null || die "doveconf not found"
id "$APP_USER" >/dev/null 2>&1 || die "service user $APP_USER missing — run install.sh first"
[[ "$MASTER_USER" =~ ^[a-z][a-z0-9_-]{1,31}$ ]] || die "--master-user must match ^[a-z][a-z0-9_-]{1,31}$"

env_unset() { sed -i.bak -E "/^(ALL_MAILBOXES_USER|ALL_MAILBOXES_SECRET_FILE|ALL_MAILBOXES_SEPARATOR|ALL_MAILBOXES_ADMINS|MAILBOX_DIRECTORY|MAILBOX_IDENTITIES)=/d" "$ENV_FILE"; rm -f "$ENV_FILE.bak"; }
reload_dovecot() { doveconf -n >/dev/null || die "Dovecot configuration is invalid; not reloading"; systemctl reload dovecot; }   # reload only, never restart

# ---------------------------------------------------------------- disable
if [[ $DISABLE -eq 1 ]]; then
  log "Disabling all-mailboxes mode"
  rm -f "$DOVECOT_DROPIN"
  if [[ -f "$DOVECOT_MASTER_FILE" ]]; then
    sed -i.bak -E "/^${MASTER_USER}:/d" "$DOVECOT_MASTER_FILE"; rm -f "$DOVECOT_MASTER_FILE.bak"
    [[ -s "$DOVECOT_MASTER_FILE" ]] || rm -f "$DOVECOT_MASTER_FILE"
  fi
  reload_dovecot
  env_unset
  rm -f "$SECRET_FILE" "$DIR_FILE" "$DIR_FILE.tmp" "$IDENT_FILE" "$IDENT_FILE.tmp" "$CRON_FILE"
  systemctl restart "$UNIT"
  log "Done. Admin connections are back to linked mailboxes only."
  exit 0
fi

[[ -n "$ADMINS" ]] || die "--admin is required (comma-separated Roundcube logins allowed to enable the mode)"
for a in ${ADMINS//,/ }; do
  doveadm user "$a" >/dev/null 2>&1 || warn "admin '$a' is not a Dovecot user on this host (the setting is still written)"
done

# ---------------------------------------------------------------- 1. master user
umask 077
if [[ -f "$SECRET_FILE" && $ROTATE -eq 0 ]]; then
  log "Master secret already present, keeping it (use --rotate to replace)"
  SECRET="$(tr -d '\r\n' < "$SECRET_FILE")"
else
  log "Generating master secret"
  SECRET="$(openssl rand -base64 48 | tr -d '/+=\n' | head -c 40)"
  [[ ${#SECRET} -ge 32 ]] || die "secret generation failed"
fi
# SHA512-CRYPT via openssl so the secret never appears on a command line
HASH="$(printf '%s\n' "$SECRET" | openssl passwd -6 -stdin)"
[[ "$HASH" == \$6\$* ]] || die "openssl passwd -6 failed (OpenSSL ≥ 1.1.1 required)"

touch "$DOVECOT_MASTER_FILE"
sed -i.bak -E "/^${MASTER_USER}:/d" "$DOVECOT_MASTER_FILE"; rm -f "$DOVECOT_MASTER_FILE.bak"
printf '%s:{SHA512-CRYPT}%s\n' "$MASTER_USER" "$HASH" >> "$DOVECOT_MASTER_FILE"
chown root:dovecot "$DOVECOT_MASTER_FILE"; chmod 640 "$DOVECOT_MASTER_FILE"

DROPIN_CONTENT="$(cat <<EOT
# Installed by MISSIRIA RC Connector (deploy/enable-all-mailboxes.sh). Remove with --disable.
# Master users log in as "<mailbox>*<master user>" with the master password; the destination
# mailbox must exist in the regular passdb (pass = yes), its own password is not needed.
auth_master_user_separator = *
passdb {
  driver = passwd-file
  master = yes
  pass = yes
  args = $DOVECOT_MASTER_FILE
}
EOT
)"
if [[ ! -f "$DOVECOT_DROPIN" ]] || [[ "$(cat "$DOVECOT_DROPIN")" != "$DROPIN_CONTENT" ]]; then
  log "Writing $DOVECOT_DROPIN"
  printf '%s\n' "$DROPIN_CONTENT" > "$DOVECOT_DROPIN"
  chmod 644 "$DOVECOT_DROPIN"
fi
doveconf -n 2>/dev/null | grep -q "auth_master_user_separator = \*" || die "Dovecot does not pick up $DOVECOT_DROPIN (is conf.d included from dovecot.conf?)"
log "Reloading Dovecot"
reload_dovecot

# ---------------------------------------------------------------- 2. secret for the connector
printf '%s\n' "$SECRET" > "$SECRET_FILE"
chown root:"$APP_USER" "$SECRET_FILE"; chmod 640 "$SECRET_FILE"

# ---------------------------------------------------------------- 3. mailbox directory + cron
cat > "$CRON_FILE" <<EOT
#!/bin/sh
# Refreshes the mailbox list the MISSIRIA RC Connector uses for server-wide access (ADR-003)
# and the reply identities (addresses the MTA delivers into each mailbox, from the Postfix
# virtual alias map). Replies may only carry one of those as From.
umask 027
doveadm user '*' 2>/dev/null | grep -v '^\$' | sort > "$DIR_FILE.tmp" || exit 0
chown root:$APP_USER "$DIR_FILE.tmp" && mv -f "$DIR_FILE.tmp" "$DIR_FILE"
: > "$IDENT_FILE.tmp"
if [ -r /etc/postfix/virtual ]; then
  # login -> system user (basename of the Dovecot home). A system user shared by several logins is
  # ambiguous and gets no aliases at all: an alias must map to exactly one mailbox.
  map=\$(while read -r login; do h=\$(doveadm user -f home "\$login" 2>/dev/null); printf '%s %s\\n' "\$login" "\${h##*/}"; done < "$DIR_FILE")
  dups=\$(printf '%s\\n' "\$map" | awk 'NF == 2 { n[\$2]++ } END { for (u in n) if (n[u] > 1) print u }')
  printf '%s\\n' "\$map" | while read -r login sysuser; do
    [ -n "\$login" ] || continue
    if [ -n "\$sysuser" ] && ! printf '%s\\n' "\$dups" | grep -qx "\$sysuser"; then
      aliases=\$(awk -v u="\$sysuser" -v l="\$login" '\$0 !~ /^[[:space:]]*#/ && NF >= 2 && index(\$1, "@") > 0 && (\$2 == u || \$2 == l) { print tolower(\$1) }' /etc/postfix/virtual | sort -u | tr '\\n' ' ')
    else
      aliases=""
    fi
    printf '%s %s\\n' "\$login" "\$aliases" >> "$IDENT_FILE.tmp"
  done
fi
chown root:$APP_USER "$IDENT_FILE.tmp" && mv -f "$IDENT_FILE.tmp" "$IDENT_FILE"
EOT
chmod 755 "$CRON_FILE"
"$CRON_FILE"
[[ -s "$DIR_FILE" ]] || die "mailbox directory is empty: 'doveadm user *' returned nothing (userdb iteration unsupported?)"
log "Mailbox directory: $(wc -l < "$DIR_FILE") mailboxes in $DIR_FILE; reply identities in $IDENT_FILE (refreshed hourly)"

# ---------------------------------------------------------------- 4. env + restart
env_unset
cat >> "$ENV_FILE" <<EOT
ALL_MAILBOXES_USER=$MASTER_USER
ALL_MAILBOXES_SECRET_FILE=$SECRET_FILE
ALL_MAILBOXES_SEPARATOR=*
ALL_MAILBOXES_ADMINS=$ADMINS
MAILBOX_DIRECTORY=$DIR_FILE
MAILBOX_IDENTITIES=$IDENT_FILE
EOT
chown root:"$APP_USER" "$ENV_FILE"; chmod 640 "$ENV_FILE"
log "Restarting $UNIT"
systemctl restart "$UNIT"
PORT="$(sed -n 's/^PORT=//p' "$ENV_FILE")"; PORT="${PORT:-8787}"
INTERNAL_KEY="$(sed -n 's/^INTERNAL_KEY=//p' "$ENV_FILE")"
for _ in $(seq 1 20); do curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 1; done
# the internal key goes to curl through its config on stdin, never on the command line
curl -fsS -K - "http://127.0.0.1:$PORT/internal/healthz" <<<"header = \"X-Internal-Key: $INTERNAL_KEY\"" | sed -n 's/.*\("allMailboxes":{[^}]*}\).*/   \1/p' || die "connector did not come up; see journalctl -u $UNIT"

# ---------------------------------------------------------------- 5. self-test through the connector's IMAP library
FIRST="$(head -n 1 "$DIR_FILE")"
NODE_BIN="$(sed -n 's|^ExecStart=\(\S*\) .*|\1|p' "/etc/systemd/system/$UNIT.service")"; NODE_BIN="${NODE_BIN:-node}"
log "Self-test: opening INBOX of $FIRST as ${FIRST}*${MASTER_USER} on 127.0.0.1:$IMAP_PORT"
if ! sudo -u "$APP_USER" env SECRET_FILE="$SECRET_FILE" MASTER_USER="$MASTER_USER" IMAP_PORT="$IMAP_PORT" NODE_PATH="$APP_DIR/node_modules" \
  "$NODE_BIN" --no-warnings -e '
    const { ImapFlow } = require("imapflow"); const fs = require("fs");
    const secret = fs.readFileSync(process.env.SECRET_FILE, "utf8").replace(/\r?\n$/, "");
    const [mailbox, expectOk] = [process.argv[1], process.argv[2] === "ok"];
    const c = new ImapFlow({ host: "127.0.0.1", port: Number(process.env.IMAP_PORT), secure: false, doSTARTTLS: false, logger: false, emitLogs: false,
      auth: { user: `${mailbox}*${process.env.MASTER_USER}`, pass: secret } });
    c.connect().then(async () => { const m = await c.mailboxOpen("INBOX"); console.log(`   ${expectOk ? "OK" : "UNEXPECTED OK"}: ${mailbox} INBOX has ${m.exists} messages`); await c.logout(); process.exit(expectOk ? 0 : 1); })
     .catch((e) => { console.log(`   ${expectOk ? "FAIL" : "OK (refused as expected)"}: ${mailbox}: ${e.message}`); process.exit(expectOk ? 1 : 0); });
  ' "$FIRST" ok; then
  die "master login failed. Check: journalctl -u dovecot | tail, and that $DOVECOT_DROPIN is loaded (doveconf -n | grep master)"
fi
sudo -u "$APP_USER" env SECRET_FILE="$SECRET_FILE" MASTER_USER="$MASTER_USER" IMAP_PORT="$IMAP_PORT" NODE_PATH="$APP_DIR/node_modules" \
  "$NODE_BIN" --no-warnings -e '
    const { ImapFlow } = require("imapflow"); const fs = require("fs");
    const secret = fs.readFileSync(process.env.SECRET_FILE, "utf8").replace(/\r?\n$/, "");
    const c = new ImapFlow({ host: "127.0.0.1", port: Number(process.env.IMAP_PORT), secure: false, doSTARTTLS: false, logger: false, emitLogs: false,
      auth: { user: `nobody-${Date.now()}@invalid.test*${process.env.MASTER_USER}`, pass: secret } });
    c.connect().then(async () => { console.log("   UNEXPECTED: a non-existent mailbox opened"); await c.logout(); process.exit(1); })
     .catch(() => { console.log("   OK: non-existent mailbox refused (pass = yes existence check works)"); process.exit(0); });
  ' || warn "non-existent mailbox was accepted; check 'pass = yes' in $DOVECOT_DROPIN"

log "Done. In Roundcube (as one of: $ADMINS) → Settings → AI Connectors → a connection → 'All mailboxes (N)'."
log "Switch off any time with that button, or revert the server with: $0 --disable"
