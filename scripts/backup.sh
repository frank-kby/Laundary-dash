#!/usr/bin/env bash
# Usage: DATABASE_URL=... ./scripts/backup.sh [output-dir]
set -euo pipefail
: "${DATABASE_URL:?Set DATABASE_URL}"
out="${1:-backups}"; mkdir -p "$out"
file="$out/laundry-dash-$(date +%Y%m%d-%H%M).dump"
pg_dump --format=custom --no-owner --no-privileges --file="$file" "$DATABASE_URL"
pg_restore --list "$file" > /dev/null   # sanity check the archive is readable
echo "Backup written: $file ($(du -h "$file" | cut -f1))"
