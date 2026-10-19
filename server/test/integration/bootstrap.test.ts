import { beforeAll, describe, expect, it } from 'vitest';
import { one, pool } from '../../src/db.js';
import { bootstrapAdmin, seedCatalogueIfEmpty, topUpSlots } from '../../src/bootstrap.js';
import { client } from '../helpers.js';

beforeAll(async () => {
  const tables = (await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'schema_migrations'`)).rows.map((r) => `"${r.tablename}"`);
  await pool.query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
});

describe('shell-less bootstrap (Render free has no shell)', () => {
  it('seeds the catalogue once and never overwrites admin edits', async () => {
    expect(await seedCatalogueIfEmpty()).toBe(true);
    await pool.query(`UPDATE services SET unit_price = 999 WHERE code = 'WASH_IRON'`);
    await pool.query(`DELETE FROM service_category_prices`);
    expect(await seedCatalogueIfEmpty()).toBe(false);
    expect((await one(pool, `SELECT unit_price FROM services WHERE code = 'WASH_IRON'`)).unit_price).toBe(999);
    expect((await one(pool, 'SELECT count(*)::int AS n FROM service_category_prices')).n).toBe(0);
  });

  it('creates the first admin only, can sign in, and never resets an existing admin', async () => {
    const env = { BOOTSTRAP_ADMIN_EMAIL: 'Owner@Example.com', BOOTSTRAP_ADMIN_PASSWORD: 'owner-strong-pass-1', BOOTSTRAP_ADMIN_NAME: 'Owner' };
    expect(await bootstrapAdmin({ BOOTSTRAP_ADMIN_EMAIL: 'x@example.com', BOOTSTRAP_ADMIN_PASSWORD: 'short' })).toBe('invalid');
    expect(await bootstrapAdmin(env)).toBe('created');
    const r = await client().post('/api/v1/auth/login', { identifier: 'owner@example.com', password: 'owner-strong-pass-1' });
    expect(r.body.user.role).toBe('ADMIN');
    expect(await bootstrapAdmin({ ...env, BOOTSTRAP_ADMIN_PASSWORD: 'attacker-changed-pass' })).toBe('exists');
    expect((await client().post('/api/v1/auth/login', { identifier: 'owner@example.com', password: 'owner-strong-pass-1' })).status).toBe(200);
    expect(await bootstrapAdmin({})).toBe('skipped');
  });

  it('tops up slots without touching closed or resized ones', async () => {
    const s = await one(pool, `SELECT id FROM pickup_slots WHERE starts_at > now() ORDER BY starts_at LIMIT 1`);
    await pool.query('UPDATE pickup_slots SET active = false, capacity = 9 WHERE id = $1', [s.id]);
    expect(await topUpSlots({ AUTO_SLOT_DAYS: '0' }, true)).toBe(0);
    await topUpSlots({ AUTO_SLOT_DAYS: '21' }, true);
    const after = await one(pool, 'SELECT active, capacity FROM pickup_slots WHERE id = $1', [s.id]);
    expect(after).toEqual({ active: false, capacity: 9 });
    const far = await one(pool, `SELECT count(*)::int AS n FROM pickup_slots WHERE starts_at > now() + interval '15 days'`);
    expect(far.n).toBeGreaterThan(0);
  });
});
