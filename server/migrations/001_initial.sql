-- Laundry Dash initial schema. All timestamps are timestamptz (stored UTC).
-- Financial and audit records use ON DELETE RESTRICT: they must never vanish via cascade.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- Identity ----------
CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            text,                       -- normalized lowercase, nullable
  phone            text,                       -- E.164, nullable
  password_hash    text NOT NULL,
  full_name        text NOT NULL,
  role             text NOT NULL DEFAULT 'CUSTOMER'
                     CHECK (role IN ('CUSTOMER','RIDER','STAFF','ADMIN')),
  preferred_language text NOT NULL DEFAULT 'en' CHECK (preferred_language IN ('en','rw')),
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  is_demo          boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE UNIQUE INDEX users_email_uq ON users (email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX users_phone_uq ON users (phone) WHERE phone IS NOT NULL;

CREATE TABLE sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash       text NOT NULL UNIQUE,       -- sha256 of the cookie token; raw token never stored
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  persistent       boolean NOT NULL,           -- "keep me logged in"
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  idle_expires_at  timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  user_agent       text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE password_reset_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_by  uuid REFERENCES users(id),       -- set when issued by an admin (assisted reset)
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- Catalogue & geography ----------
CREATE TABLE service_areas (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  district      text NOT NULL,                 -- Gasabo / Kicukiro / Nyarugenge
  landmarks     text NOT NULL DEFAULT '',      -- comma-separated hints shown to customers
  pickup_fee    integer NOT NULL CHECK (pickup_fee >= 0),   -- RWF
  delivery_fee  integer NOT NULL CHECK (delivery_fee >= 0),
  active        boolean NOT NULL DEFAULT true,
  sort_order    integer NOT NULL DEFAULT 0
);

CREATE TABLE garment_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE,
  kind       text NOT NULL CHECK (kind IN ('CLOTHES','SHOES')),
  name_en    text NOT NULL,
  name_rw    text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE services (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE,
  name_en        text NOT NULL,
  name_rw        text NOT NULL,
  description_en text NOT NULL DEFAULT '',
  description_rw text NOT NULL DEFAULT '',
  kind           text NOT NULL CHECK (kind IN ('CLOTHES','SHOES')),
  pricing_unit   text NOT NULL CHECK (pricing_unit IN ('ITEM','KG')),
  unit_price     integer NOT NULL CHECK (unit_price >= 0),    -- RWF per item / per kg
  min_charge     integer NOT NULL DEFAULT 0 CHECK (min_charge >= 0),
  turnaround_hours integer NOT NULL DEFAULT 48,
  active         boolean NOT NULL DEFAULT true,
  sort_order     integer NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Optional per-category price override for ITEM services (e.g. dry-clean a jacket costs more than a shirt)
CREATE TABLE service_category_prices (
  service_id  uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES garment_categories(id) ON DELETE CASCADE,
  unit_price  integer NOT NULL CHECK (unit_price >= 0),
  PRIMARY KEY (service_id, category_id)
);

CREATE TABLE pickup_slots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  capacity    integer NOT NULL CHECK (capacity >= 0),
  booked_count integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  CHECK (ends_at > starts_at),
  CHECK (booked_count >= 0 AND booked_count <= capacity),   -- DB-level overbooking guard
  UNIQUE (starts_at, ends_at)
);

-- ---------- Customer data ----------
CREATE TABLE addresses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label           text NOT NULL,                 -- Home / Work
  service_area_id uuid NOT NULL REFERENCES service_areas(id),
  street          text NOT NULL DEFAULT '',      -- e.g. KG 7 Ave
  landmark        text NOT NULL DEFAULT '',      -- e.g. "Opposite Simba Supermarket"
  details         text NOT NULL DEFAULT '',      -- gate colour, house no.
  contact_phone   text,
  latitude        numeric(9,6),
  longitude       numeric(9,6),
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX addresses_user_idx ON addresses (user_id) WHERE deleted_at IS NULL;

CREATE TABLE wardrobe_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('CLOTHES','SHOES')),
  category_id uuid NOT NULL REFERENCES garment_categories(id),
  name        text NOT NULL,
  color       text NOT NULL DEFAULT '',
  quantity    integer NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 100),
  care_notes  text NOT NULL DEFAULT '',
  photo_key   text,
  deleted_at  timestamptz,                       -- soft delete; order snapshots keep their copy
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wardrobe_user_idx ON wardrobe_items (user_id) WHERE deleted_at IS NULL;

-- ---------- Subscriptions ----------
CREATE TABLE subscription_plans (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                    text NOT NULL UNIQUE,
  name_en                 text NOT NULL,
  name_rw                 text NOT NULL,
  description_en          text NOT NULL DEFAULT '',
  description_rw          text NOT NULL DEFAULT '',
  price                   integer NOT NULL CHECK (price >= 0),
  validity_days           integer NOT NULL CHECK (validity_days > 0),
  allowance_unit          text NOT NULL CHECK (allowance_unit IN ('ITEM','KG')),
  allowance_quantity      numeric(8,2) NOT NULL CHECK (allowance_quantity >= 0),
  free_trips              integer NOT NULL DEFAULT 0 CHECK (free_trips >= 0),  -- pickup+delivery round trips waived
  overage_discount_percent integer NOT NULL DEFAULT 0 CHECK (overage_discount_percent BETWEEN 0 AND 100),
  active                  boolean NOT NULL DEFAULT true,
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE subscription_plan_services (
  plan_id    uuid NOT NULL REFERENCES subscription_plans(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  PRIMARY KEY (plan_id, service_id)
);

CREATE TABLE subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  plan_id       uuid NOT NULL REFERENCES subscription_plans(id) ON DELETE RESTRICT,
  plan_snapshot jsonb NOT NULL,                  -- terms as purchased; plan edits don't change it
  status        text NOT NULL CHECK (status IN ('PENDING_PAYMENT','ACTIVE','EXPIRED','CANCELLED')),
  starts_at     timestamptz,
  ends_at       timestamptz,
  renewed_from_id uuid REFERENCES subscriptions(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_user_idx ON subscriptions (user_id, status);

-- ---------- Bookings & orders ----------
CREATE TABLE orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference          text NOT NULL UNIQUE,         -- customer-facing, e.g. LD-261019-7KQ4
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status             text NOT NULL CHECK (status IN (
                        'PENDING_CONFIRMATION','CONFIRMED','PICKUP_SCHEDULED','PICKED_UP','RECEIVED',
                        'INSPECTION_REQUIRED','AWAITING_APPROVAL','PROCESSING','READY_FOR_DELIVERY',
                        'OUT_FOR_DELIVERY','DELIVERED','CANCELLED','ON_HOLD')),
  hold_from_status   text,                          -- status to resume to after ON_HOLD
  payment_status     text NOT NULL DEFAULT 'UNPAID'
                       CHECK (payment_status IN ('UNPAID','PARTIALLY_PAID','PAID','REFUNDED','PARTIALLY_REFUNDED')),
  subscription_id    uuid REFERENCES subscriptions(id) ON DELETE RESTRICT,
  pricing_snapshot   jsonb NOT NULL,                -- full breakdown at last agreed price
  estimated_total    integer NOT NULL,              -- at booking time
  agreed_total       integer NOT NULL,              -- last total the customer agreed to
  final_total        integer,                       -- locked when processing starts
  inspection_recorded boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_user_idx ON orders (user_id, created_at DESC);
CREATE INDEX orders_status_idx ON orders (status, created_at DESC);

CREATE TABLE bookings (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id               uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  user_id                uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  pickup_slot_id         uuid NOT NULL REFERENCES pickup_slots(id) ON DELETE RESTRICT,
  pickup_address_id      uuid REFERENCES addresses(id) ON DELETE SET NULL,
  pickup_address_snapshot jsonb NOT NULL,
  delivery_preference    text NOT NULL CHECK (delivery_preference IN ('DELIVER_TO_ADDRESS','COLLECT_AT_SHOP')),
  delivery_address_id    uuid REFERENCES addresses(id) ON DELETE SET NULL,
  delivery_address_snapshot jsonb,
  customer_notes         text NOT NULL DEFAULT '',
  reschedule_count       integer NOT NULL DEFAULT 0,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  wardrobe_item_id   uuid REFERENCES wardrobe_items(id) ON DELETE SET NULL,  -- provenance only
  -- snapshot (never rewritten when the wardrobe item changes)
  name               text NOT NULL,
  kind               text NOT NULL,
  category_code      text NOT NULL,
  category_name      text NOT NULL,
  color              text NOT NULL DEFAULT '',
  care_notes         text NOT NULL DEFAULT '',
  photo_key          text,
  service_id         uuid NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  service_code       text NOT NULL,
  service_name       text NOT NULL,
  pricing_unit       text NOT NULL,
  unit_price         integer NOT NULL,
  min_charge         integer NOT NULL DEFAULT 0,
  declared_quantity  numeric(8,2) NOT NULL CHECK (declared_quantity > 0),   -- items, or estimated kg
  -- staff-recorded reality
  received_quantity  integer,
  measured_weight_kg numeric(8,2),
  condition_notes    text NOT NULL DEFAULT '',
  added_by_staff     boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

CREATE TABLE order_adjustments (            -- extra chargeable work or discounts proposed by staff
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  revision_id  uuid,                         -- set once linked to a price revision
  description  text NOT NULL,
  amount       integer NOT NULL,             -- RWF, may be negative (discount)
  voided_at    timestamptz,                  -- set when the customer rejects the revision it belonged to
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  event_type    text NOT NULL,               -- STATUS_CHANGE, NOTE, INSPECTION, PRICE_REVISION, PAYMENT, ISSUE, TASK
  from_status   text,
  to_status     text,
  note          text NOT NULL DEFAULT '',
  visible_to_customer boolean NOT NULL DEFAULT true,
  actor_user_id uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order_idx ON order_events (order_id, created_at);

CREATE TABLE price_revisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  previous_total    integer NOT NULL,
  proposed_total    integer NOT NULL,
  pricing_snapshot  jsonb NOT NULL,
  reason            text NOT NULL,
  requires_approval boolean NOT NULL,
  status            text NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED','SUPERSEDED','AUTO_APPLIED')),
  proposed_by       uuid NOT NULL REFERENCES users(id),
  decided_by        uuid REFERENCES users(id),
  decision_channel  text CHECK (decision_channel IN ('APP','PHONE','IN_PERSON','WHATSAPP')),
  decision_note     text NOT NULL DEFAULT '',
  decided_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- at most one open revision per order
CREATE UNIQUE INDEX price_revisions_one_pending ON price_revisions (order_id) WHERE status = 'PENDING';

CREATE TABLE order_issues (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  issue_type   text NOT NULL CHECK (issue_type IN ('FAILED_PICKUP','FAILED_DELIVERY','GARMENT_DISPUTE','DELAY','PAYMENT_UNCERTAIN','DAMAGE','OTHER')),
  status       text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  description  text NOT NULL,
  resolution   text NOT NULL DEFAULT '',
  created_by   uuid NOT NULL REFERENCES users(id),
  resolved_by  uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);

CREATE TABLE rider_tasks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  rider_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  task_type      text NOT NULL CHECK (task_type IN ('PICKUP','DELIVERY')),
  status         text NOT NULL DEFAULT 'ASSIGNED' CHECK (status IN ('ASSIGNED','EN_ROUTE','COMPLETED','FAILED','CANCELLED')),
  window_start   timestamptz,
  window_end     timestamptz,
  instructions   text NOT NULL DEFAULT '',
  failure_reason text,
  assigned_by    uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rider_tasks_rider_idx ON rider_tasks (rider_user_id, status);
-- one live task of each type per order
CREATE UNIQUE INDEX rider_tasks_one_active ON rider_tasks (order_id, task_type)
  WHERE status IN ('ASSIGNED','EN_ROUTE');

-- Usage is recorded once per (subscription, order). The unique key is the duplicate-deduction guard.
CREATE TABLE subscription_usage (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  order_id        uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  units_used      numeric(8,2) NOT NULL CHECK (units_used >= 0),
  trips_used      integer NOT NULL DEFAULT 0 CHECK (trips_used >= 0),
  reversed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, order_id)
);

-- ---------- Payments ----------
CREATE TABLE payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  order_id           uuid REFERENCES orders(id) ON DELETE RESTRICT,
  subscription_id    uuid REFERENCES subscriptions(id) ON DELETE RESTRICT,
  amount             integer NOT NULL CHECK (amount > 0),
  currency           text NOT NULL DEFAULT 'RWF',
  method             text NOT NULL CHECK (method IN ('MOBILE_MONEY','CASH','MANUAL_MOBILE_MONEY','BANK_TRANSFER')),
  provider           text,                         -- mtn_momo / simulator / null for manual
  provider_mode      text CHECK (provider_mode IN ('test','live')),
  provider_reference text,
  payer_msisdn_masked text,                        -- e.g. +25078****567; never a PIN
  status             text NOT NULL CHECK (status IN ('PENDING','SUCCESSFUL','FAILED','CANCELLED','REFUNDED','PARTIALLY_REFUNDED')),
  refunded_amount    integer NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  manual_reference   text,                         -- receipt no. / MoMo transaction ID typed by staff
  recorded_by        uuid REFERENCES users(id),
  last_checked_at    timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (order_id IS NOT NULL OR subscription_id IS NOT NULL),
  CHECK (refunded_amount <= amount)
);
CREATE UNIQUE INDEX payments_provider_ref_uq ON payments (provider, provider_reference) WHERE provider_reference IS NOT NULL;
CREATE INDEX payments_order_idx ON payments (order_id);
CREATE INDEX payments_user_idx ON payments (user_id, created_at DESC);

CREATE TABLE payment_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id        uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  source            text NOT NULL CHECK (source IN ('INITIATE','WEBHOOK','POLL','MANUAL','SYSTEM')),
  provider_event_id text,
  from_status       text,
  to_status         text,
  detail            jsonb NOT NULL DEFAULT '{}',   -- redacted: no secrets, no full phone numbers
  actor_user_id     uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- webhook dedup: each provider event is processed once
CREATE UNIQUE INDEX payment_events_provider_event_uq ON payment_events (payment_id, provider_event_id) WHERE provider_event_id IS NOT NULL;

CREATE TABLE refunds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id  uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  amount      integer NOT NULL CHECK (amount > 0),
  method      text NOT NULL CHECK (method IN ('CASH','MANUAL_MOBILE_MONEY','BANK_TRANSFER')),
  reason      text NOT NULL,
  reference   text,
  status      text NOT NULL DEFAULT 'SUCCESSFUL' CHECK (status IN ('PENDING','SUCCESSFUL','FAILED')),
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- Cross-cutting ----------
CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel    text NOT NULL CHECK (channel IN ('IN_APP','EMAIL')),
  type       text NOT NULL,
  title      text NOT NULL,
  body       text NOT NULL,
  order_id   uuid REFERENCES orders(id) ON DELETE SET NULL,
  status     text NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED','SENT','FAILED','SKIPPED')),
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE audit_logs (
  id            bigserial PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     text,
  before_data   jsonb,
  after_data    jsonb,
  ip            text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);

CREATE TABLE idempotency_records (
  key           text NOT NULL,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint      text NOT NULL,
  request_hash  text NOT NULL,
  status_code   integer,
  response_body jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, endpoint, key)
);
