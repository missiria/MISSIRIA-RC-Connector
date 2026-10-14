#!/usr/bin/env bash
# MISSIRIA RC Connector — remove the service, nginx vhost and plugin. Keeps nothing.
# Usage: bash uninstall.sh --mcp-host mcp.example.com --rc-dir /var/www/roundcube [--keep-data]
set -euo pipefail
MCP_HOST=""; RC_DIR=""; KEEP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mcp-host) MCP_HOST="$2"; shift 2 ;;
    --rc-dir)   RC_DIR="$2"; shift 2 ;;
    --keep-data) KEEP=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }

systemctl disable --now missiria-rc-connector 2>/dev/null || true
rm -f /etc/systemd/system/missiria-rc-connector.service /etc/logrotate.d/missiria-rc-connector
systemctl daemon-reload
if [[ -n "$MCP_HOST" ]]; then
  rm -f "/etc/nginx/sites-enabled/$MCP_HOST.conf" "/etc/nginx/sites-available/$MCP_HOST.conf"
  nginx -t && systemctl reload nginx
fi
if [[ -n "$RC_DIR" ]]; then
  rm -rf "$RC_DIR/plugins/missiria_rc_connector"
  sed -i "/missiria_rc_connector/d" "$RC_DIR/config/config.inc.php"
  systemctl reload "php*-fpm" 2>/dev/null || true
fi
rm -rf /opt/missiria-rc-connector   # src (root) + app (rcmcp)
if [[ $KEEP -eq 0 ]]; then
  rm -rf /var/lib/missiria-rc-connector /etc/missiria-rc-connector /var/log/missiria-rc-connector
  userdel rcmcp 2>/dev/null || true
  echo "Removed service, data, keys, logs, vhost and plugin."
else
  echo "Removed service, vhost and plugin. Kept /var/lib, /etc and /var/log directories."
fi
