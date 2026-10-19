import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool, one } from '../src/db.js';
import { hashPassword } from '../src/routes/auth.js';
import { seedCatalogue } from '../src/seed.js';

export const app = createApp();

/** Wipes all data, re-seeds the catalogue and slots. */
export async function resetDb() {
  const tables = (await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`)).rows.map((r) => `"${r.tablename}"`);
  await pool.query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
  await seedCatalogue();
}

export type Client = ReturnType<typeof client>;

/** A cookie-keeping browser-like client that sends the CSRF header. */
export function client() {
  const agent = request.agent(app);
  const h = (r: request.Test, key?: string) => {
    r.set('X-Requested-With', 'LaundryDash');
    if (key) r.set('Idempotency-Key', key);
    return r;
  };
  return {
    agent,
    get: (url: string) => agent.get(url),
    post: (url: string, body?: object, key?: string) => h(agent.post(url), key).send(body ?? {}),
    patch: (url: string, body?: object) => h(agent.patch(url)).send(body ?? {}),
    put: (url: string, body?: object) => h(agent.put(url)).send(body ?? {}),
    del: (url: string) => h(agent.delete(url)),
  };
}

let n = 0;
export async function makeUser(role: 'CUSTOMER' | 'RIDER' | 'STAFF' | 'ADMIN', password = 'password123') {
  n++;
  const email = `${role.toLowerCase()}${n}-${Date.now()}@test.example`;
  const u = await one(pool, `INSERT INTO users (full_name, email, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING *`, [`${role} ${n}`, email, await hashPassword(password), role]);
  const c = client();
  const r = await c.post('/api/v1/auth/login', { identifier: email, password });
  if (r.status !== 200) throw new Error('login failed ' + r.status);
  return { user: u, c, email, password };
}

export async function catalogue() {
  const services = (await pool.query('SELECT * FROM services')).rows;
  const cats = (await pool.query('SELECT * FROM garment_categories')).rows;
  const areas = (await pool.query('SELECT * FROM service_areas')).rows;
  const by = <T extends { code: string }>(rows: T[]) => Object.fromEntries(rows.map((r) => [r.code, r])) as Record<string, any>;
  return { svc: by(services), cat: by(cats), area: by(areas) };
}

export async function futureSlot(capacity?: number) {
  const s = await one(pool, `SELECT * FROM pickup_slots WHERE starts_at > now() + interval '2 hours' AND booked_count < capacity ORDER BY starts_at LIMIT 1`);
  if (capacity !== undefined) await pool.query('UPDATE pickup_slots SET capacity = $2 WHERE id = $1', [s.id, capacity]);
  return s;
}

/** Customer with a saved address; returns a helper that books a manual (no-wardrobe) order. */
export async function customerWithAddress() {
  const { svc, cat, area } = await catalogue();
  const cu = await makeUser('CUSTOMER');
  const a = await cu.c.post('/api/v1/me/addresses', { label: 'Home', serviceAreaId: area.KIMIHURURA.id, landmark: 'Near KCC', street: 'KG 9 Ave' });
  const addressId = a.body.address.id;
  const book = async (opts: { items?: any[]; slotId?: string; key?: string; delivery?: 'DELIVER_TO_ADDRESS' | 'COLLECT_AT_SHOP' } = {}) => {
    const slot = opts.slotId ?? (await futureSlot()).id;
    return cu.c.post(
      '/api/v1/bookings',
      {
        items: opts.items ?? [{ name: 'Blue shirt', categoryId: cat.SHIRT.id, quantity: 2, serviceId: svc.WASH_IRON.id }],
        pickupAddressId: addressId,
        pickupSlotId: slot,
        deliveryPreference: opts.delivery ?? 'DELIVER_TO_ADDRESS',
      },
      opts.key ?? 'key-' + Math.random().toString(36).slice(2),
    );
  };
  return { ...cu, addressId, book, svc, cat, area };
}
