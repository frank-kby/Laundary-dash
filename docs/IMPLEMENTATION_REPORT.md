# Laundry Dash — implementation report

Status as of 21 October 2026. Legend: **Tested** = covered by automated tests that were run and passed ·
**Built** = implemented and exercised manually/in UI, no dedicated automated test · **Mocked** = works against a
test-mode stand-in only · **Not configured** = code exists, needs credentials, never run against the real service.

## Test evidence (actually run)
| Suite | Result | Output |
|---|---|---|
| Server unit + integration (real PostgreSQL 16) | **98 / 98 passed** | `docs/test-results/server-tests.txt` |
| End-to-end, Playwright, Pixel 7 + 360 px viewport (Chromium 153) | **17 / 17 passed** | `docs/test-results/e2e-tests.txt` |
| TypeScript typecheck (server + web) | clean | — |
| Production-mode boot of compiled build | HTTPS redirect, HSTS, `__Host-` Secure cookie, origin rejection, insecure-config refusal all confirmed | — |
| Backup → restore round trip | passed; restore refuses non-empty target | — |
| Upgrade rehearsal: migration 003 over a database at the production version (002) with data | applied; admin account and admin-edited category names untouched; production build boots on it | — |
| iOS Home Screen static audit (meta tags, manifest, icons, service worker, headers, CSP) | 16 / 16 checks pass | — |

Screen loads in E2E: 640–715 ms per customer screen (localhost, no throttling). Customer JS ≈ 108 KB gzipped;
staff/rider code is split out. A throttled "agreed test connection" (e.g. Fast 3G) has **not** been defined or measured.

## Feature status

### Sign-in
| Feature | Status |
|---|---|
| Register with email+password or phone+password, no OTP | **Tested** |
| Login with email or phone; generic errors; timing-equalised | **Tested** |
| "Keep me logged in" (30-day persistent vs session cookie), HttpOnly/SameSite, server sessions | **Tested** |
| Logout invalidates session server-side | **Tested** |
| Rate limiting (login per IP+identifier) | **Tested** |
| Phone/email normalization, duplicate prevention | **Tested** |
| Email reset: single-use, 30-min, no enumeration, signs out everywhere | **Tested** (console email in test) · real email **Not configured** |
| Staff-assisted reset link for phone-only accounts (verified identity, audited) | **Built** |
| Redesigned welcome / sign-in / sign-up (animated hero, Create account ↔ Sign in tabs, password reveal) | **Tested** (E2E) |
| Guest mode: browse, see prices and build a booking without an account; sign-up sheet appears at confirm / subscribe / add-to-wardrobe and the draft is kept | **Tested** (API + E2E) |
| Account type Personal or Business (business name + type), gender preference for clothing types; editable in Account | **Tested** (API + E2E) |

### Customer PWA (English + Kinyarwanda)
| Feature | Status |
|---|---|
| Home: Book a Pickup, active order with clothesline status, wardrobe + plans shortcuts, WhatsApp/call | **Tested** (E2E) |
| Booking without wardrobe; wardrobe items; add-to-wardrobe while booking | **Tested** |
| Kigali zones + landmarks (no GPS dependency), slot picker, delivery or collect-at-shop | **Tested** |
| Estimate with fees before confirm; server-computed totals | **Tested** |
| Duplicate-submission and slot-overbooking prevention (incl. concurrent requests) | **Tested** |
| Cancel / reschedule before pickup | **Tested** |
| Price-increase approval / rejection by customer | **Tested** (API + E2E) |
| Virtual wardrobe: photo grid, colour swatches, value per item, totals, search/filter/sort, cleaning history, book-from-item; edits never rewrite orders | **Tested** (API + E2E) |
| Business inventory: linens, towels, uniforms, curtains… tracked per property / unit with location filter | **Tested** (API + E2E) |
| Depreciation: straight-line by garment type life (admin-configurable), value today, “replace soon” flag at ≤ 20 % left, purchase date | **Tested** (unit + API + E2E) |
| Clothing types filtered by account type and gender | **Tested** (E2E) |
| Optional private photos | **Tested** (stored in PostgreSQL, `PHOTO_STORAGE=db`, shrunk on device) · R2 **Not configured** |
| Language switch EN/RW; dictionaries | **Tested** (E2E) |
| Offline banner; offline submissions fail visibly, never shown as confirmed | **Tested** (E2E) |
| Mobile layout: no horizontal scroll, ≥44 px targets at 360 px | **Tested** (E2E) |
| Installable PWA (manifest, icons, app-shell service worker, API never cached); install hint on iPhone (Share → Add to Home Screen) and Android (Install button) | **Built** · iOS on a real device **pending user check** |
| In-app notifications | **Built** |

### Operations
| Feature | Status |
|---|---|
| 13-status state machine, server-validated transitions and guards | **Tested** |
| Confirm, assign rider, pickup, receive, inspect (qty/weight/condition), add found items | **Tested** |
| Price revisions; work blocked until approval; staff-recorded phone/WhatsApp approvals | **Tested** |
| Failed pickups/deliveries, disputes, delays, payment uncertainty as explicit issues; hold/resume | **Tested** |
| Rider view: own tasks only, no prices/payments | **Tested** |
| Staff search/filter, CSV reports (formula-safe), summary | **Tested** (API) · UI **Built** |
| Service/price/area/category/plan/slot configuration (ADMIN), audited; old orders keep snapshot prices | **Tested** (API) · UI **Built** |
| Role management, disable accounts (revokes sessions), audit log viewer | **Tested** (API) · UI **Built** |

### Subscriptions & payments
| Feature | Status |
|---|---|
| Configurable plans (price, validity, services, allowance, free trips, overage discount) | **Tested** |
| Usage per order, recorded once even if processing restarts | **Tested** |
| Activation on payment; renewal queued after current period | **Tested** (activation) · renewal **Built** |
| Manual cash / MoMo-to-business / bank payments by staff, overpayment refused, audited | **Tested** |
| Refunds (ADMIN only), partial/full | **Tested** |
| Mobile Money flow with webhook signature check, re-verification, idempotent dedup, unknown → pending | **Mocked** (TEST MODE simulator) — **Tested** |
| MTN MoMo Collections adapter | **Not configured** — written against the documented flow, never run against MTN |
| Order status separate from payment status | **Tested** |

## Deployment
Live at https://laundry-dash.onrender.com (Render free web service + Neon free PostgreSQL), deployed from GitHub
`main` via `render.yaml`. Free-tier limits were verified from provider pages on 19 Oct 2026.

## Known limitations
1. **Staff configuration screens use inline English labels** for form fields (services, areas, plans, slots, people,
   reports tables). Customer, rider and core staff-order strings use the dictionaries; staff strings fall back to
   English in Kinyarwanda. Moving the remaining admin labels into `en.ts`/`rw.ts` is a mechanical follow-up.
2. **Kinyarwanda is a first draft** — needs native-speaker review, especially approval/payment wording.
   Dates in Kinyarwanda mode show English month names where the browser lacks `rw` locale data.
3. **iOS Safari not tested on a device** (no WebKit available here). The Home Screen setup passes a static audit
   (apple-touch-icon, standalone manifest, status-bar meta, safe-area padding, no-cache service worker), but a real
   iPhone check is still needed (Add to Home Screen, staying signed in, `<dialog>` sheets, camera upload).
4. Pickup slots are topped up automatically (`AUTO_SLOT_DAYS`, default hours Mon–Sat 08–18) on start and twice
   daily on traffic; staff can close or resize individual slots, or create different hours, in *Settings*.
5. Staff UI doesn't yet display order-item photos (the authenticated endpoint exists).
6. No SMS/WhatsApp messaging API — support uses `wa.me`/`tel:` links (numbers editable by admins in *Settings → Contact numbers*); notifications are in-app (+email if configured).
7. Free-tier behaviour: ~1 min cold start after 15 min idle; in-memory rate limits reset on restart; Neon
   6-hour restore window (own backups required — `scripts/backup.sh`).
8. No MFA for admin accounts.

## Recommended next steps
1. Set the real WhatsApp and call numbers in *Settings → Contact numbers*.
2. Replace sample prices/fees/areas; have the Kinyarwanda text reviewed.
3. Test on one iPhone and two low-end Android phones on mobile data; agree a target connection and measure.
4. Apply for MTN MoMo sandbox access and validate the adapter before enabling Mobile Money for customers.
