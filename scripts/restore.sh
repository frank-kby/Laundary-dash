#!/usr/bin/env bash
# Usage: TARGET_DATABASE_URL=... ./scripts/restore.sh backups/file.dump
# Restores into an EMPTY database. Refuses if the target already has Laundry Dash tables.
set -euo pipefail
: "${TARGET_DATABASE_URL:?Set TARGET_DATABASE_URL}"
file="${1:?Pass the .dump file}"
if psql "$TARGET_DATABASE_URL" -tAc "SELECT to_regclass('public.orders')" | grep -q orders; then
  echo "Target database is not empty (orders table exists). Restore into a fresh database." >&2; exit 1
fi
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$TARGET_DATABASE_URL" "$file"
psql "$TARGET_DATABASE_URL" -tAc "SELECT 'users: '||count(*) FROM users UNION ALL SELECT 'orders: '||count(*) FROM orders UNION ALL SELECT 'payments: '||count(*) FROM payments"
echo "Restore complete."
