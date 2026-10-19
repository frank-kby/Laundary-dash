/**
 * Seeds starter configuration and (optionally) DEMO data.
 *   npm run seed            -> catalogue, Kigali zones, plans, pickup slots (safe to re-run; upserts by code)
 *   npm run seed -- --demo  -> also demo accounts + a demo booking (ALL marked DEMO; never use in production)
 * Prices are SAMPLE values for testing — replace them in Staff > Settings before launch.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool, one, q } from './db.js';
import { migrate } from './migrate.js';
import { hashPassword } from './routes/auth.js';
import { generateSlots } from './routes/admin.js';
import { priceOrder } from './domain/pricing.js';

export const DEMO_PASSWORD = 'LaundryDemo2026!';

const categories = [
  ['SHIRT', 'CLOTHES', 'Shirts', 'Amashati'],
  ['TSHIRT', 'CLOTHES', 'T-shirts', 'Imipira'],
  ['TROUSERS', 'CLOTHES', 'Trousers', 'Amapantaro'],
  ['DRESS', 'CLOTHES', 'Dresses', 'Amakanzu'],
  ['JACKET', 'CLOTHES', 'Jackets & suits', 'Amakoti'],
  ['OTHER_CLOTHES', 'CLOTHES', 'Other clothes', 'Indi myenda'],
  ['SNEAKERS', 'SHOES', 'Sneakers', 'Inkweto za siporo'],
  ['FORMAL_SHOES', 'SHOES', 'Formal shoes', 'Inkweto z’ibirori'],
  ['SANDALS', 'SHOES', 'Sandals', 'Sandali'],
  ['BOOTS', 'SHOES', 'Boots', 'Botine'],
  ['OTHER_SHOES', 'SHOES', 'Other shoes', 'Izindi nkweto'],
] as const;

// [code, nameEn, nameRw, descEn, descRw, kind, unit, price, min, hours, categoryOverrides]
const services: [string, string, string, string, string, string, string, number, number, number, Record<string, number>][] = [
  ['WASH_FOLD', 'Wash & fold', 'Kumesa no kuzinga', 'Everyday laundry washed, dried and folded. Priced by weight.', 'Imyenda isanzwe imeshwa, ikumishwa, ikazingwa. Igiciro gishingiye ku biro.', 'CLOTHES', 'KG', 1500, 3000, 48, {}],
  ['WASH_IRON', 'Wash & iron', 'Kumesa no gutera ipasi', 'Washed and pressed, per item.', 'Kumesa no gutera ipasi, kuri buri mwenda.', 'CLOTHES', 'ITEM', 800, 0, 48, { TROUSERS: 1000, DRESS: 1500, JACKET: 2500 }],
  ['DRY_CLEAN', 'Dry cleaning', 'Isuku yihariye (dry clean)', 'For delicate fabrics, suits and formal wear.', 'Ku myenda yoroshye, amakoti n’imyenda y’ibirori.', 'CLOTHES', 'ITEM', 3000, 0, 72, { JACKET: 5000, DRESS: 4500 }],
  ['IRON_ONLY', 'Ironing only', 'Gutera ipasi gusa', 'Pressing for clean clothes, per item.', 'Gutera ipasi imyenda isukuye, kuri buri mwenda.', 'CLOTHES', 'ITEM', 400, 0, 24, { JACKET: 1000 }],
  ['SHOE_CLEAN', 'Shoe cleaning', 'Gusukura inkweto', 'Deep clean per pair.', 'Gusukura neza, kuri buri babiri.', 'SHOES', 'ITEM', 3000, 0, 72, { FORMAL_SHOES: 2500, BOOTS: 4000, SANDALS: 2000 }],
];

// [code, name, district, landmarks, pickupFee, deliveryFee]
const areas: [string, string, string, string, number, number][] = [
  ['KIMIHURURA', 'Kimihurura', 'Gasabo', 'Kigali Convention Centre, Kimihurura roundabout', 1000, 1000],
  ['KACYIRU', 'Kacyiru', 'Gasabo', 'Kacyiru roundabout, Ministry offices', 1000, 1000],
  ['REMERA', 'Remera', 'Gasabo', 'Amahoro Stadium, Giporoso', 1000, 1000],
  ['KIMIRONKO', 'Kimironko', 'Gasabo', 'Kimironko Market, Kimironko bus stop', 1000, 1000],
  ['NYARUTARAMA', 'Nyarutarama', 'Gasabo', 'Nyarutarama lake, MTN Centre', 1500, 1500],
  ['KIBAGABAGA', 'Kibagabaga', 'Gasabo', 'Kibagabaga Hospital', 1500, 1500],
  ['GISOZI', 'Gisozi', 'Gasabo', 'Kigali Genocide Memorial, Gisozi sector office', 1500, 1500],
  ['KICUKIRO_CENTRE', 'Kicukiro Centre', 'Kicukiro', 'Sonatubes, Kicukiro Centre', 1000, 1000],
  ['NIBOYE', 'Niboye', 'Kicukiro', 'Niboye sector office', 1500, 1500],
  ['GIKONDO', 'Gikondo', 'Kicukiro', 'Gikondo Expo grounds, MAGERWA', 1500, 1500],
  ['KANOMBE', 'Kanombe', 'Kicukiro', 'Kigali International Airport, Kanombe military hospital', 2000, 2000],
  ['CBD', 'City Centre (CBD)', 'Nyarugenge', 'Kigali City Tower, downtown bus park', 1000, 1000],
  ['KIYOVU', 'Kiyovu', 'Nyarugenge', 'Hôtel des Mille Collines, Kiyovu', 1000, 1000],
  ['NYAMIRAMBO', 'Nyamirambo', 'Nyarugenge', 'Nyamirambo stadium, Biryogo', 1500, 1500],
];

const plans = [
  { code: 'BASIC_MONTHLY', en: 'Basic monthly', rw: 'Ifatabuguzi rito ry’ukwezi', den: '15 kg wash & fold, 2 free pickup+delivery trips, 10% off extra kilos.', drw: 'Ibiro 15 byo kumesa no kuzinga, ingendo 2 z’ubuntu, igabanywa rya 10% ku biro by’inyongera.', price: 20000, days: 30, unit: 'KG', qty: 15, trips: 2, disc: 10, svc: ['WASH_FOLD'] },
  { code: 'FAMILY_MONTHLY', en: 'Family monthly', rw: 'Ifatabuguzi ry’umuryango', den: '40 kg wash & fold, 4 free trips, 15% off extra kilos.', drw: 'Ibiro 40, ingendo 4 z’ubuntu, igabanywa rya 15% ku biro by’inyongera.', price: 50000, days: 30, unit: 'KG', qty: 40, trips: 4, disc: 15, svc: ['WASH_FOLD'] },
  { code: 'OFFICE_SHIRTS', en: 'Office shirts', rw: 'Amashati y’akazi', den: '20 items washed & ironed, 4 free trips, 10% off extra items.', drw: 'Imyenda 20 imeshwa igaterwa ipasi, ingendo 4 z’ubuntu, igabanywa rya 10%.', price: 14000, days: 30, unit: 'ITEM', qty: 20, trips: 4, disc: 10, svc: ['WASH_IRON'] },
];

export async function seedCatalogue() {
  for (const [i, [code, kind, en, rw]] of categories.entries()) {
    await pool.query(
      `INSERT INTO garment_categories (code, kind, name_en, name_rw, sort_order) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (code) DO UPDATE SET kind = EXCLUDED.kind, sort_order = EXCLUDED.sort_order`,
      [code, kind, en, rw, i],
    );
  }
  const catIds = Object.fromEntries((await q(pool, 'SELECT code, id FROM garment_categories')).map((r) => [r.code, r.id]));
  for (const [i, [code, en, rw, den, drw, kind, unit, price, min, hours, ov]] of services.entries()) {
    const s = await one(
      pool,
      `INSERT INTO services (code, name_en, name_rw, description_en, description_rw, kind, pricing_unit, unit_price, min_charge, turnaround_hours, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order RETURNING id`,
      [code, en, rw, den, drw, kind, unit, price, min, hours, i],
    );
    for (const [cat, p] of Object.entries(ov)) {
      await pool.query('INSERT INTO service_category_prices (service_id, category_id, unit_price) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [s.id, catIds[cat], p]);
    }
  }
  for (const [i, [code, name, district, landmarks, pf, df]] of areas.entries()) {
    await pool.query(
      `INSERT INTO service_areas (code, name, district, landmarks, pickup_fee, delivery_fee, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (code) DO NOTHING`,
      [code, name, district, landmarks, pf, df, i],
    );
  }
  const svcIds = Object.fromEntries((await q(pool, 'SELECT code, id FROM services')).map((r) => [r.code, r.id]));
  for (const p of plans) {
    const row = await one(
      pool,
      `INSERT INTO subscription_plans (code, name_en, name_rw, description_en, description_rw, price, validity_days, allowance_unit, allowance_quantity, free_trips, overage_discount_percent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`,
      [p.code, p.en, p.rw, p.den, p.drw, p.price, p.days, p.unit, p.qty, p.trips, p.disc],
    );
    for (const s of p.svc) await pool.query('INSERT INTO subscription_plan_services (plan_id, service_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [row.id, svcIds[s]]);
  }
  return generateSlots({ days: 14, startHour: 8, endHour: 18, slotMinutes: 120, capacity: 4, weekdays: [1, 2, 3, 4, 5, 6] });
}

export async function seedDemo() {
  const pw = await hashPassword(DEMO_PASSWORD);
  const users: [string, string | null, string | null, string][] = [
    ['DEMO Admin', 'demo.admin@example.com', null, 'ADMIN'],
    ['DEMO Staff', 'demo.staff@example.com', null, 'STAFF'],
    ['DEMO Rider', null, '+250780000101', 'RIDER'],
    ['DEMO Customer', 'demo.customer@example.com', '+250780000201', 'CUSTOMER'],
  ];
  const ids: Record<string, string> = {};
  for (const [name, email, phone, role] of users) {
    const u = await one(
      pool,
      `INSERT INTO users (full_name, email, phone, password_hash, role, is_demo) VALUES ($1,$2,$3,$4,$5,true)
       ON CONFLICT DO NOTHING RETURNING id`,
      [name, email, phone, pw, role],
    );
    ids[role] = u?.id ?? (await one(pool, `SELECT id FROM users WHERE full_name = $1 AND is_demo`, [name])).id;
  }
  const cust = ids.CUSTOMER;
  const has = await one(pool, 'SELECT 1 FROM orders WHERE user_id = $1', [cust]);
  if (has) return;
  const area = await one(pool, `SELECT * FROM service_areas WHERE code = 'KIMIHURURA'`);
  const addr = await one(pool, `INSERT INTO addresses (user_id, label, service_area_id, street, landmark, details, contact_phone) VALUES ($1,'Home',$2,'KG 9 Ave','Near Kigali Convention Centre','Blue gate, house 12 (DEMO)','+250780000201') RETURNING *`, [cust, area.id]);
  const cat = await one(pool, `SELECT * FROM garment_categories WHERE code = 'SHIRT'`);
  const sneakers = await one(pool, `SELECT * FROM garment_categories WHERE code = 'SNEAKERS'`);
  await pool.query(`INSERT INTO wardrobe_items (user_id, kind, category_id, name, color, quantity, care_notes) VALUES ($1,'CLOTHES',$2,'White office shirt (DEMO)','White',3,'Light starch'), ($1,'SHOES',$3,'Running sneakers (DEMO)','Grey',1,'')`, [cust, cat.id, sneakers.id]);
  const svc = await one(pool, `SELECT * FROM services WHERE code = 'WASH_IRON'`);
  const slot = await one(pool, `SELECT * FROM pickup_slots WHERE starts_at > now() + interval '1 day' ORDER BY starts_at LIMIT 1`);
  if (!slot) return;
  const pricing = priceOrder({ lines: [{ ref: 'demo', label: 'White office shirt (DEMO)', serviceId: svc.id, serviceName: svc.name_en, pricingUnit: 'ITEM', unitPrice: svc.unit_price, minCharge: 0, quantity: 3 }], pickupFee: area.pickup_fee, deliveryFee: area.delivery_fee });
  const o = await one(pool, `INSERT INTO orders (reference, user_id, status, pricing_snapshot, estimated_total, agreed_total) VALUES ('LD-DEMO-0001',$1,'PENDING_CONFIRMATION',$2,$3,$3) RETURNING id`, [cust, JSON.stringify(pricing), pricing.total]);
  const snap = { label: 'Home', serviceAreaId: area.id, serviceAreaName: area.name, street: addr.street, landmark: addr.landmark, details: addr.details, contactPhone: addr.contact_phone };
  await pool.query(`INSERT INTO bookings (order_id, user_id, pickup_slot_id, pickup_address_id, pickup_address_snapshot, delivery_preference, delivery_address_id, delivery_address_snapshot, customer_notes) VALUES ($1,$2,$3,$4,$5,'DELIVER_TO_ADDRESS',$4,$5,'DEMO booking')`, [o.id, cust, slot.id, addr.id, JSON.stringify(snap)]);
  await pool.query('UPDATE pickup_slots SET booked_count = booked_count + 1 WHERE id = $1', [slot.id]);
  await pool.query(`INSERT INTO order_items (order_id, name, kind, category_code, category_name, service_id, service_code, service_name, pricing_unit, unit_price, declared_quantity) VALUES ($1,'White office shirt (DEMO)','CLOTHES','SHIRT','Shirts',$2,'WASH_IRON',$3,'ITEM',$4,3)`, [o.id, svc.id, svc.name_en, svc.unit_price]);
  await pool.query(`INSERT INTO order_events (order_id, event_type, to_status, note, actor_user_id) VALUES ($1,'STATUS_CHANGE','PENDING_CONFIRMATION','DEMO booking',$2)`, [o.id, cust]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  (async () => {
    await migrate();
    const slots = await seedCatalogue();
    console.log(`Catalogue seeded (${slots} new pickup slots). Prices are SAMPLE values — review before launch.`);
    if (process.argv.includes('--demo')) {
      if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') throw new Error('Refusing to seed DEMO accounts in production.');
      await seedDemo();
      console.log(`DEMO accounts ready (password: ${DEMO_PASSWORD}). Remove them before going live.`);
    }
    await pool.end();
  })().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
