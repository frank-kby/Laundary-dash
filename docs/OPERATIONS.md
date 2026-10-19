# Operations: backup, export and restore

Neon's free plan only keeps a **6-hour** restore window, so you must keep your own copies. Use a computer with
PostgreSQL client tools whose major version is **≥ the Neon server version** (check with `SELECT version();`).

## Backup (weekly at minimum, and before every migration)

```bash
export DATABASE_URL='postgres://USER:PASSWORD@HOST/neondb?sslmode=require'
./scripts/backup.sh                    # writes backups/laundry-dash-YYYYMMDD-HHMM.dump
```

The script runs `pg_dump --format=custom --no-owner --no-privileges` (compressed, restorable selectively).
Store copies in at least two places you control (e.g. an encrypted laptop folder and an encrypted cloud drive).
Backups contain personal data (names, phones, addresses) — treat them as confidential.

## Restore

```bash
createdb laundry_dash_restore                          # or a fresh Neon branch/project
export TARGET_DATABASE_URL='postgres://…/laundry_dash_restore'
./scripts/restore.sh backups/laundry-dash-20261019-2100.dump
```

Then point `DATABASE_URL` at the restored database and redeploy. **Test a restore at least once a month** — an
untested backup is not a backup.

Quick restore after a mistake within 6 hours: use Neon's dashboard *Restore* (branch from a point in time).

## Business exports (spreadsheets)

*Staff → Reports* downloads `orders.csv` and `payments.csv` for any date range (also at
`/api/v1/admin/reports/*.csv`). These are for accounting, not for restoring the system.

## Health and housekeeping
- `GET /healthz` checks the database. Render uses it as the health check.
- Expired sessions/reset tokens are purged opportunistically on login; subscriptions are expired on traffic.
- Watch Neon usage (CU-hours, storage) monthly; at ~80% plan an upgrade or cleanup.

## Incident checklist
- Customer says they paid but the app shows *pending*: open the payment in *Staff → Payments* → *Check with provider*.
  If still unclear, record a `PAYMENT_UNCERTAIN` issue on the order; never mark it paid without evidence.
- Lost/damaged garment: record `GARMENT_DISPUTE`/`DAMAGE` with details; put the order *On hold* if needed.
- Suspected account compromise: *Staff → People* → Disable (revokes all sessions immediately).
