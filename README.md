# Laundry Dash

Mobile-first Progressive Web App for a Kigali laundry business: customers book pickups from a web link on iOS or
Android (no app store), staff run operations from a dashboard, and riders see only their assigned tasks.
English and Kinyarwanda from day one.

| Part | What it is |
|---|---|
| `server/` | Node 22 + Express 5 + TypeScript REST API (`/api/v1`), PostgreSQL, SQL migrations, OpenAPI |
| `web/` | React 19 + TypeScript + Vite PWA (customer app, staff dashboard, rider view) |
| `e2e/` | Playwright end-to-end tests (mobile browser) |
| `docs/` | Security notes, operations/backup guide, implementation report, recorded test output |

In production one web service serves both the API and the built PWA from the same origin, which keeps cookies
first-party and avoids CORS entirely.

### Highlights
- **Guests can look around first** — prices, how it works, and building a booking need no account; a sign-up sheet
  appears only when they confirm a booking, choose a plan or save to the wardrobe (their draft is kept).
- **Personal or Business accounts.** Business accounts (apartments, hotels, clothes rentals, restaurants, salons…)
  get an *Inventory* for linens, towels, uniforms and curtains, tracked per property/unit.
- **Gender preference** narrows clothing types (e.g. ties for men, skirts for women); everyone can choose "Everyone".
- **Depreciation** — each item's value today is estimated straight-line over its garment type's typical life
  (editable by admins in *Settings → Garment types*); items with ≤ 20 % left are flagged "Replace soon".
- **Contact numbers** — admins set the WhatsApp and call numbers customers see in *Settings → Contact numbers*
  (falls back to `SUPPORT_WHATSAPP` / `SUPPORT_PHONE`).
- **Install on iPhone**: open the site in Safari → Share → *Add to Home Screen*. It opens full screen like an app.
  Android/Chrome shows an *Install* button.

---

## 1. Local development

**Prerequisites:** Node 20+ (22 recommended), PostgreSQL 14+ (16 tested).

```bash
# 1. Install
npm run install:all

# 2. Create databases
createdb laundry_dash
createdb laundry_dash_test          # for automated tests

# 3. Configure
cp .env.example server/.env
#   edit server/.env: set DATABASE_URL; for local testing also set
#   EMAIL_PROVIDER=console  PHOTO_STORAGE=local  PAYMENT_PROVIDER=simulator
#   PAYMENT_WEBHOOK_SECRET=<any 16+ chars>  EXTRA_ALLOWED_ORIGINS=http://localhost:5173

# 4. Migrate and seed
npm run migrate
npm run seed:demo        # starter catalogue + DEMO accounts (use `npm run seed` for catalogue only)

# 5. Run (two terminals)
npm run dev:server       # API on http://localhost:3000
npm run dev:web          # PWA on http://localhost:5173 (proxies /api to :3000)
```

Open http://localhost:5173. API docs: http://localhost:3000/api/docs (raw spec: `/api/v1/openapi.json`).

### Demo accounts (local only — created by `seed:demo`, all labelled DEMO)

Password for all: `LaundryDemo2026!`

| Role | Sign in with |
|---|---|
| Customer | `demo.customer@example.com` or `0780000201` |
| Staff | `demo.staff@example.com` |
| Admin | `demo.admin@example.com` |
| Rider | `0780000101` |

The demo seed refuses to run when `NODE_ENV=production`.

### Local-only conveniences (all refused in production)
- `EMAIL_PROVIDER=console` prints password-reset links to the server terminal.
- `PHOTO_STORAGE=local` stores photos in `server/data/uploads`.
- `PAYMENT_PROVIDER=simulator` enables **TEST MODE** Mobile Money: payments are labelled TEST everywhere and the
  order page shows "Approve (test)/Decline (test)" buttons. Numbers ending in `0000` are declined.

---

## 2. Migrations and seed data

- Migrations are plain SQL in `server/migrations/NNN_name.sql`, applied in order, each in a transaction,
  tracked in `schema_migrations`, guarded by an advisory lock so two instances cannot migrate at once.
- `npm run migrate` (dev) / `npm run migrate:prod --prefix server` (compiled). On Render,
  `RUN_MIGRATIONS_ON_START=true` applies pending migrations at boot.
- To change the schema: add `002_whatever.sql`. Never edit a migration that has run in production.
- `npm run seed` upserts services, categories, Kigali service areas, subscription plans and 14 days of pickup slots.
  **Prices, fees and landmarks are SAMPLE values** — review them in *Staff → Settings* before launch.

---

## 3. Tests

```bash
npm test                     # server unit + integration (needs laundry_dash_test database)
npm run typecheck            # server + web
npm run test:e2e             # Playwright; starts its own server on :3100 against laundry_dash_e2e
```

- `TEST_DATABASE_URL` overrides the test DB (must end in `_test`; the suite drops and recreates its schema).
- E2E needs `createdb laundry_dash_e2e` and a built PWA (`npm run build --prefix web`).
- If Playwright cannot download browsers (blocked network), point it at any Chromium:
  `CHROMIUM_PATH=/path/to/chromium npm run test:e2e`.
- Latest recorded results: `docs/test-results/`.

---

## 4. Deployment (RWF 0 — free tiers only)

Provider terms were checked on **19 October 2026** against the providers' own pages. Free tiers change: re-check
before relying on them. Nothing here requires a paid plan. Do not add a payment method unless you have decided to;
without one, overages suspend the service rather than bill you.

| Need | Provider (free) | Verified limits | Consequence |
|---|---|---|---|
| App + API, HTTPS | **Render** free web service | 750 instance-hours/month per workspace; sleeps after **15 min** without traffic, ~**1 min** cold start; no persistent disk; outbound **SMTP ports blocked**; may restart anytime | First visit after idle is slow. Fine for launch; upgrade when customers notice. |
| Database | **Neon** free | 1 GB storage/project; 100 CU-hours/month; scales to zero after 5 min (cannot disable); 5 GB egress/month; 6-hour restore window | Over-quota → compute suspended until next month (data kept). Short restore window → **take your own backups** (docs/OPERATIONS.md). |
| Photos (optional) | **Cloudflare R2** | 10 GB-month storage, 1M Class A + 10M Class B ops/month, free egress | Off by default. App works fully without photos. |
| Email (optional) | **Resend** | 3,000 emails/month, 100/day, 1 domain | Needs a domain you control to send from; without it, leave email off (reset handled by staff). |

Render's own free Postgres is **not** used: it is deleted 30 days after creation.

Sources: [Render free tier](https://render.com/docs/free) · [Neon free plan limits](https://neon.com/faqs/free-plan-limits-and-quotas) · [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/) · [Resend free tier](https://resend.com/blog/new-free-tier)

Not verified (no page stated it): whether Render/Neon require a card at sign-up, and the exact Render free
bandwidth/build-minute allowances. Check during sign-up.

### Step-by-step

1. **Push the repository to GitHub** (private is fine).
2. **Neon:** create a free project (region: closest available to Rwanda, e.g. Europe). Copy the **pooled** connection
   string and make sure it ends with `?sslmode=require`.
3. **Render:** *New → Blueprint*, select the repo; Render reads `render.yaml` and creates the free web service.
   In the service's *Environment*, set:
   - `DATABASE_URL` = the Neon pooled string
   - `APP_ORIGIN` = `https://<service-name>.onrender.com` (shown after the first deploy; redeploy after setting)
   - `SUPPORT_PHONE` = `+2507…`, `SUPPORT_WHATSAPP` = `2507…` (digits only, for wa.me links)
4. Deploy. Migrations run on start. Check `https://<service>.onrender.com/healthz` → `{"ok":true}`.
5. **First-start setup happens automatically** (Render's free tier has no shell): on an empty database the app
   seeds the sample catalogue (`SEED_CATALOGUE_IF_EMPTY=true`), creates the first admin from `BOOTSTRAP_ADMIN_NAME`,
   `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` (12+ chars; only if no admin exists — it never changes an
   existing account), and keeps pickup slots open `AUTO_SLOT_DAYS` ahead. No demo users are created.
6. After your first successful admin sign-in, **delete `BOOTSTRAP_ADMIN_PASSWORD`** from Render's environment.
   (Alternative with a shell/terminal that can reach the database: `npm run seed` and `npm run create-admin`.)
7. Sign in at `/login`, go to *Staff → Settings*, and replace sample prices, fees, areas and plans.
   Create staff and rider accounts under *Staff → People*.
8. On phones: open the link in Chrome/Safari → *Add to Home Screen*.

Repeatable deploys: every push to the default branch auto-deploys (`autoDeploy: true`). Roll back from the Render
dashboard (*Deploys → Rollback*). Migrations are forward-only; write additive migrations so a rollback of code
still works with the newer schema.

### Optional integrations (each is independent; leave off until credentials and testing exist)

**Photos — default `PHOTO_STORAGE=db`:** photos are shrunk on the phone (≈800 px JPEG, ~60–120 KB, EXIF/GPS removed) and stored privately in PostgreSQL, so they work on the free tier with no extra account. Limit: 300 photos per customer. Roughly 1,000 photos ≈ 100 MB of Neon's 1 GB. When photo volume grows, switch to R2:

**Photos (Cloudflare R2):** create a bucket, keep public access **disabled**, create an API token with
object read/write on that bucket only. Set `PHOTO_STORAGE=s3`, `S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com`,
`S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. Photos are served via 5-minute signed URLs after an
ownership check. *Not yet tested against a real R2 bucket.*

**Email (Resend):** verify a sending domain, then `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM`.
*Not yet tested with a real key.*

**Mobile Money (MTN MoMo Collections):** the adapter in `server/src/providers/payments.ts` implements the
documented request-to-pay + status flow but has **not** been run against MTN (no credentials). MTN requires business
verification for production. To try the sandbox: register at the MoMo developer portal, then set
`PAYMENT_PROVIDER=mtn_momo`, `MTN_MOMO_*`, and `PAYMENT_WEBHOOK_SECRET`. Payments are marked TEST while
`MTN_MOMO_TARGET_ENV=sandbox`. Verify end-to-end in sandbox before switching to production values.
Until then, staff record cash / MoMo-to-business-number payments manually (audited).

**Never** set `PAYMENT_PROVIDER=simulator` on a live site (it lets testers mark payments paid); it is refused in
production unless `ALLOW_SIMULATOR_IN_PRODUCTION=true`.

---

## 5. Upgrading later (paid hosting, custom domain)

- **Stop cold starts:** change the Render plan from Free to a paid instance (no code change).
- **Custom domain:** add it in Render (TLS is automatic), then set `APP_ORIGIN=https://yourdomain.rw` and redeploy.
  Old `onrender.com` links keep working; sessions on the old host end (cookies are host-bound) — users sign in once.
- **Database:** Neon paid plan (longer restore window, more compute), or move with `pg_dump`/`pg_restore`
  (docs/OPERATIONS.md) to any managed PostgreSQL ≥14; update `DATABASE_URL`.
- **Other hosts:** the `Dockerfile` builds a self-contained image (`node server/dist/index.js`) for any container host.
- **Several instances:** move rate limiting to a shared store (Redis) — it is in-memory today, correct for one instance.
- **Scheduled jobs:** subscription expiry and session cleanup run opportunistically on requests; with paid hosting,
  add a cron job if exact timing matters.

---

## 6. Project layout

```
server/
  migrations/001_initial.sql      schema (constraints, unique keys, no cascades on financial/audit data)
  openapi.yaml                    API spec (test enforces it matches the code)
  src/domain/                     pure logic: pricing, order state machine
  src/services/                   transactional workflows: orders, payments, notifications
  src/providers/                  adapters: payments (simulator, MTN MoMo), photo storage, email
  src/routes/                     HTTP layer (auth, me, catalog, bookings, orders, subscriptions, payments, admin, rider)
  src/seed.ts, src/createAdmin.ts
  test/unit, test/integration
web/src/
  i18n/en.ts, i18n/rw.ts          all customer and rider strings
  pages/customer, pages/staff, pages/rider
e2e/tests/                        journey + mobile layout
```

See also: [docs/SECURITY.md](docs/SECURITY.md) · [docs/OPERATIONS.md](docs/OPERATIONS.md) ·
[docs/IMPLEMENTATION_REPORT.md](docs/IMPLEMENTATION_REPORT.md)
