-- Virtual wardrobe: colour swatch, item value, and database-backed photo storage
-- (keeps photos working on free hosting without a separate object store).

ALTER TABLE wardrobe_items
  ADD COLUMN color_hex text CHECK (color_hex ~ '^#[0-9a-fA-F]{6}$'),
  ADD COLUMN purchase_value integer CHECK (purchase_value >= 0 AND purchase_value <= 100000000);

-- Order snapshots keep the swatch too, so staff see the colour at inspection.
ALTER TABLE order_items
  ADD COLUMN color_hex text;

CREATE TABLE stored_photos (
  key          text PRIMARY KEY,
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  bytes        bytea NOT NULL,
  size         integer NOT NULL CHECK (size > 0 AND size <= 3145728),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stored_photos_user_idx ON stored_photos (user_id);

CREATE INDEX wardrobe_user_category_idx ON wardrobe_items (user_id, category_id) WHERE deleted_at IS NULL;
