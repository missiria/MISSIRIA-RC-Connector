#!/usr/bin/env bash
# MISSIRIA RC Connector — one-shot installer (steps 2–6 of docs/INSTALL.md).
# Idempotent: re-run to upgrade. Keys, env and grants are preserved.
#
# Usage:
#   bash install.sh --mcp-host mcp.example.com --webmail-host webmail.example.com \
#                   --rc-dir /var/www/roundcube --email admin@example.com [--no-certbot]
set -euo pipefail

MCP_HOST=""; WEBMAIL_HOST=""; RC_DIR=""; ADMIN_EMAIL=""; CERTBOT=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mcp-host) MCP_HOST="$2"; shift 2;;
    --webmail-host) WEBMAIL_HOST="$2"; shift 2;;
    --rc-dir) RC_DIR="$2"; shift 2;;
    --email) ADMIN_EMAIL="$2"; shift 2;;
    --no-certbot) CERTBOT=0; shift;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[[ -n "$MCP_HOST" && -n "$WEBMAIL_HOST" && -n "$RC_DIR" ]] || { echo "missing --mcp-host/--webmail-host/--rc-dir" >&2; exit 2; }
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }

echo "==> NOT IMPLEMENTED YET — tracked in docs/ROADMAP.md phase P5."
echo "    Follow docs/INSTALL.md manually until install.sh ships."
exit 3
