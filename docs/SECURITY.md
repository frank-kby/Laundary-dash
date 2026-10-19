# Security notes

## Authentication
- **Sign-up/sign-in:** email + password or phone + password. No OTP (by design). Emails are lower-cased; phones are
  normalized to E.164 with Rwanda as default region (`078…`, `+25078…`, `25078…` are one identity). Partial unique
  indexes prevent duplicates.
- **Passwords:** Argon2id (19 MiB, t=2, p=1 — OWASP baseline), 8–128 chars. Never stored or logged in plaintext.
  Login always runs a hash verification (against a dummy hash for unknown users) to reduce timing-based enumeration.
- **Sessions:** random 256-bit token in an `HttpOnly; SameSite=Lax` cookie (`Secure` and `__Host-` prefix in
  production). Only the SHA-256 of the token is stored server-side. Nothing auth-related is ever put in
  `localStorage`.
  - *Keep me logged in* off: browser-session cookie; server expiry 12 h idle / 24 h absolute.
  - *Keep me logged in* on: 30-day persistent cookie with sliding idle expiry, capped at 30 days.
  - Logout deletes the server session. Password change/reset, role change and account disable revoke all sessions.
- **Rate limits:** login 10 attempts / 15 min per IP+identifier; auth routes 50 / 15 min per IP; reset 5 / hour;
  API 300 / min. In-memory (single instance) — move to a shared store if you run several instances.
- **Account enumeration:** login and reset-request responses are identical whether or not an account exists.
  Registration necessarily reports "may already exist" (rate limited); this is a deliberate UX trade-off.

## Password reset
- Email reset: 256-bit single-use token, stored hashed, valid 30 minutes, claimed atomically (`UPDATE … WHERE used_at IS NULL`).
  The link uses a URL **fragment** (`#token=`) so it is not sent to servers, logs or `Referer` headers; the page
  removes it from the address bar after use. Issuing a new token invalidates older ones.
- When email is not configured the app says so plainly.
- **Phone-only accounts:** no SMS is configured, so there is no self-service phone reset (deliberately — an insecure
  one would be worse than none). Instead an ADMIN can issue the same single-use 30-minute link **after verifying
  identity** (in person with ID, or by calling back the registered number and confirming a recent order reference).
  The verification note is mandatory and audited. Not available for staff/admin accounts.

## Request protection
- **CSRF:** SameSite=Lax cookie + required `X-Requested-With: LaundryDash` header on all state-changing requests
  (cannot be sent cross-site without a CORS preflight, which is never granted) + `Origin` allow-list.
- **CORS:** not enabled; the API and PWA share one origin.
- **Headers (helmet):** strict CSP (`default-src 'self'`, no inline script, `frame-ancestors 'none'`), HSTS in
  production, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options`. HTTP is redirected to HTTPS.
- **Caching:** all `/api` responses are `Cache-Control: no-store, private`. The service worker caches only the app
  shell, never API calls. Public catalogue endpoints are the only short-lived cacheable responses.
- **Validation:** every input is validated server-side (zod); IDs are UUID-checked; body size limited to 100 KB.
  Output is rendered by React (escaped by default). CSV exports neutralise spreadsheet formula injection.
- **Authorization:** every customer endpoint filters by the signed-in user and returns 404 (not 403) for other
  users' resources. Roles: CUSTOMER, RIDER, STAFF, ADMIN. Riders can only read and act on their own tasks and see no
  prices, payments or emails. Staff run operations; only ADMIN changes prices/configuration, roles, refunds, or
  issues assisted reset links. Admins cannot change their own role.

## Money
- Totals are computed only by the server's pricing engine; client totals are ignored.
- A price increase after inspection creates a revision; processing is blocked until the customer approves
  (in app, or recorded by staff with channel + note).
- Order status and payment status are separate fields.
- **Webhooks:** simulator callbacks are HMAC-SHA256 signed with a 5-minute timestamp window. MTN MoMo callbacks are
  not signed, so the callback URL carries a secret token **and** the body is never trusted: the server re-fetches the
  status from the provider. Events are deduplicated by `(payment_id, provider_event_id)`; terminal payments never
  change; unknown results stay PENDING.
  *Note:* the MTN callback token appears in the URL query string — keep request-URL logging off at any proxy you add.
- **No PINs:** the customer approves on their own phone. The app never asks for or stores a Mobile Money PIN.
  Payer numbers are stored masked (`+25078****567`).
- `POST /bookings` and `POST /payments` use idempotency keys, so retries and double taps cannot duplicate.
- Manual payments, refunds, price changes, status changes and permission changes are written to `audit_logs`.
  Financial and audit tables use `ON DELETE RESTRICT`.

## Files
- Photos are optional, private, ≤3 MB, type-checked by magic bytes (SVG/HTML rejected), re-encoded on the device
  (strips EXIF/GPS) and served only after an ownership check via 5-minute signed URLs (R2) or authenticated streaming.

## Secrets & logging
- Secrets live only in environment variables; `.env` is git-ignored; `.env.example` has placeholders only.
  The frontend bundle contains no secrets (it only calls same-origin `/api`).
- The logger redacts keys matching password/token/secret/cookie/authorization/pin/signature and never logs request
  bodies. Verified: no passwords, tokens or cookies appeared in server logs during testing.

## Known gaps / recommendations before scale
- Kinyarwanda translations are a first draft — review with a native speaker (wording on consent/approval matters).
- No MFA for staff/admin accounts — consider adding TOTP for ADMIN before handling real money at volume.
- No automated dependency/vulnerability scanning configured — enable GitHub Dependabot.
- Rate limiting resets when the free instance restarts or sleeps.
