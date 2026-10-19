import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, q } from '../db.js';
import { email } from '../providers/email.js';
import { paymentProvider } from '../providers/payments.js';
import { storage } from '../providers/storage.js';

export const SLOT_CUTOFF_MINUTES = 60;

export const serviceDto = (s: any, overrides: any[] = []) => ({
  id: s.id,
  code: s.code,
  nameEn: s.name_en,
  nameRw: s.name_rw,
  descriptionEn: s.description_en,
  descriptionRw: s.description_rw,
  kind: s.kind,
  pricingUnit: s.pricing_unit,
  unitPrice: s.unit_price,
  minCharge: s.min_charge,
  turnaroundHours: s.turnaround_hours,
  active: s.active,
  categoryPrices: overrides.filter((o) => o.service_id === s.id).map((o) => ({ categoryId: o.category_id, unitPrice: o.unit_price })),
});
export const categoryDto = (c: any) => ({ id: c.id, code: c.code, kind: c.kind, nameEn: c.name_en, nameRw: c.name_rw, active: c.active });
export const areaDto = (a: any) => ({
  id: a.id,
  code: a.code,
  name: a.name,
  district: a.district,
  landmarks: a.landmarks ? a.landmarks.split(',').map((s: string) => s.trim()).filter(Boolean) : [],
  pickupFee: a.pickup_fee,
  deliveryFee: a.delivery_fee,
  active: a.active,
});

export const catalogRouter = Router();

/** Public feature flags so the UI can label unconfigured integrations honestly. */
catalogRouter.get('/config', (_req, res) => {
  res.json({
    features: {
      emailPasswordReset: email.configured,
      photos: storage.configured,
      mobileMoney: paymentProvider ? { provider: paymentProvider.name, testMode: paymentProvider.mode === 'test' } : null,
    },
    support: { phone: config.SUPPORT_PHONE, whatsapp: config.SUPPORT_WHATSAPP },
    timezone: config.BUSINESS_TIMEZONE,
    currency: 'RWF',
  });
});

catalogRouter.get('/services', async (_req, res) => {
  const [services, overrides, categories] = await Promise.all([
    q(pool, 'SELECT * FROM services WHERE active ORDER BY sort_order, name_en'),
    q(pool, 'SELECT * FROM service_category_prices'),
    q(pool, 'SELECT * FROM garment_categories WHERE active ORDER BY sort_order'),
  ]);
  res.set('Cache-Control', 'public, max-age=60'); // non-personal catalogue data
  res.json({ items: services.map((s) => serviceDto(s, overrides)), categories: categories.map(categoryDto) });
});

catalogRouter.get('/service-areas', async (_req, res) => {
  const rows = await q(pool, 'SELECT * FROM service_areas WHERE active ORDER BY sort_order, name');
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ items: rows.map(areaDto) });
});

catalogRouter.get('/pickup-slots', async (req, res) => {
  const { days } = z.object({ days: z.coerce.number().int().min(1).max(14).default(7) }).parse(req.query);
  const rows = await q(
    pool,
    `SELECT id, starts_at, ends_at, capacity, booked_count FROM pickup_slots
      WHERE active AND starts_at > now() + ($1 || ' minutes')::interval AND starts_at < now() + ($2 || ' days')::interval
      ORDER BY starts_at`,
    [String(SLOT_CUTOFF_MINUTES), String(days)],
  );
  res.set('Cache-Control', 'no-store'); // availability changes constantly
  res.json({
    items: rows.map((s) => ({ id: s.id, startsAt: s.starts_at, endsAt: s.ends_at, remaining: s.capacity - s.booked_count, available: s.capacity - s.booked_count > 0 })),
  });
});
