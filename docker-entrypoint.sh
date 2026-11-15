#!/bin/sh
set -eu
mkdir -p /var/lib/shlita/backups 2>/dev/null || true
if [ -d /var/backups/shlita-external ]; then
  chown -R shlita:shlita /var/backups/shlita-external 2>/dev/null || true
fi
if [ "$(id -u)" = "0" ]; then
  chown -R shlita:shlita /var/lib/shlita 2>/dev/null || true
  exec runuser -u shlita -- "$@"
fi
exec "$@"
