#!/usr/bin/env bash
# Starts a throwaway Laundry Dash server for end-to-end tests against a dedicated e2e database.
set -euo pipefail
cd "$(dirname "$0")/../server"
export NODE_ENV=development
export PORT=${E2E_PORT:-3100}
export DATABASE_URL=${E2E_DATABASE_URL:-postgres://postgres@localhost:5432/laundry_dash_e2e}
export APP_ORIGIN=http://localhost:$PORT
export EMAIL_PROVIDER=console PHOTO_STORAGE=local LOCAL_UPLOAD_DIR=./data/e2e-uploads
export PAYMENT_PROVIDER=simulator PAYMENT_WEBHOOK_SECRET=e2e-webhook-secret-0123456789
case "$DATABASE_URL" in *_e2e*) ;; *) echo "refusing: not an e2e database"; exit 1;; esac
psql "$DATABASE_URL" -qc 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx tsx src/seed.ts --demo
exec npx tsx src/index.ts
