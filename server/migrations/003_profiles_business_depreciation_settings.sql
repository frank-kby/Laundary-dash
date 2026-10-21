-- Business contact settings, personal/business profiles, gender-aware & business categories,
-- wardrobe purchase date + location (for depreciation and multi-property tracking).

CREATE TABLE app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users
  ADD COLUMN account_type  text NOT NULL DEFAULT 'PERSONAL' CHECK (account_type IN ('PERSONAL','BUSINESS')),
  ADD COLUMN gender        text CHECK (gender IN ('FEMALE','MALE')),
  ADD COLUMN business_name text,
  ADD COLUMN business_type text CHECK (business_type IN ('APARTMENTS','HOTEL','CLOTHES_RENTAL','RESTAURANT','SALON_SPA','OTHER'));

ALTER TABLE garment_categories
  ADD COLUMN gender          text NOT NULL DEFAULT 'ANY' CHECK (gender IN ('ANY','FEMALE','MALE')),
  ADD COLUMN segment         text NOT NULL DEFAULT 'PERSONAL' CHECK (segment IN ('PERSONAL','BUSINESS')),
  ADD COLUMN lifespan_months integer NOT NULL DEFAULT 36 CHECK (lifespan_months BETWEEN 1 AND 240);

-- Typical useful life per category (straight-line depreciation). Admins can change these in Settings.
UPDATE garment_categories SET lifespan_months = v.m, gender = v.g
  FROM (VALUES ('SHIRT',36,'ANY'),('TSHIRT',24,'ANY'),('TROUSERS',36,'ANY'),('DRESS',48,'FEMALE'),('JACKET',60,'ANY'),
               ('OTHER_CLOTHES',36,'ANY'),('SNEAKERS',24,'ANY'),('FORMAL_SHOES',48,'ANY'),('SANDALS',24,'ANY'),
               ('BOOTS',48,'ANY'),('OTHER_SHOES',36,'ANY')) AS v(code, m, g)
 WHERE garment_categories.code = v.code;

-- New personal categories (gender-specific) and business linen/stock categories. Names in Kinyarwanda are drafts.
INSERT INTO garment_categories (code, kind, name_en, name_rw, gender, segment, lifespan_months, sort_order) VALUES
  ('BLOUSE',      'CLOTHES', 'Blouses',                      'Amakoti y''abagore', 'FEMALE', 'PERSONAL', 36, 12),
  ('SKIRT',       'CLOTHES', 'Skirts',                       'Amajipo',            'FEMALE', 'PERSONAL', 36, 13),
  ('MUSHANANA',   'CLOTHES', 'Mushanana & traditional wear', 'Imishanana n''imyambaro gakondo', 'FEMALE', 'PERSONAL', 72, 14),
  ('TIE',         'CLOTHES', 'Ties',                         'Amakaravati',        'MALE',   'PERSONAL', 60, 15),
  ('HEELS',       'SHOES',   'Heels',                        'Inkweto ndende',     'FEMALE', 'PERSONAL', 36, 16),
  ('BED_SHEET',   'CLOTHES', 'Bed sheets',                   'Amashuka',           'ANY', 'BUSINESS', 24, 30),
  ('DUVET_COVER', 'CLOTHES', 'Duvet covers',                 'Imyenda y''ibiringiti', 'ANY', 'BUSINESS', 36, 31),
  ('PILLOWCASE',  'CLOTHES', 'Pillowcases',                  'Imyenda y''imisego', 'ANY', 'BUSINESS', 24, 32),
  ('TOWEL',       'CLOTHES', 'Towels',                       'Amasume',            'ANY', 'BUSINESS', 24, 33),
  ('BATHROBE',    'CLOTHES', 'Bathrobes',                    'Amakanzu yo kwiyuhagiriramo', 'ANY', 'BUSINESS', 36, 34),
  ('TABLE_LINEN', 'CLOTHES', 'Tablecloths & napkins',        'Imyenda y''ameza',   'ANY', 'BUSINESS', 36, 35),
  ('CURTAIN',     'CLOTHES', 'Curtains',                     'Amarido',            'ANY', 'BUSINESS', 60, 36),
  ('UNIFORM',     'CLOTHES', 'Uniforms',                     'Impuzankano',        'ANY', 'BUSINESS', 24, 37)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE wardrobe_items
  ADD COLUMN acquired_on date CHECK (acquired_on >= DATE '1950-01-01'),
  ADD COLUMN location    text NOT NULL DEFAULT '' CHECK (length(location) <= 60);
CREATE INDEX wardrobe_user_location_idx ON wardrobe_items (user_id, location) WHERE deleted_at IS NULL;
