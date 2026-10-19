import { Router } from 'express';
import { z } from 'zod';
import { one, pool, q, tx } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { idParam } from '../http.js';
import { requireAuth } from '../auth/session.js';
import { getSubscriptionTerms } from '../services/orders.js';
import { paymentDto } from '../services/payments.js';

export const planDto = (p: any, serviceIds: string[] = []) => ({
  id: p.id,
  code: p.code,
  nameEn: p.name_en,
  nameRw: p.name_rw,
  descriptionEn: p.description_en,
  descriptionRw: p.description_rw,
  price: p.price,
  validityDays: p.validity_days,
  allowanceUnit: p.allowance_unit,
  allowanceQuantity: p.allowance_quantity,
  freeTrips: p.free_trips,
  overageDiscountPercent: p.overage_discount_percent,
  includedServiceIds: serviceIds,
  active: p.active,
});

export async function planSnapshot(db: typeof pool, planId: string) {
  const p = await one(db, 'SELECT * FROM subscription_plans WHERE id = $1 AND active', [planId]);
  if (!p) return null;
  const svc = await q(db, 'SELECT service_id FROM subscription_plan_services WHERE plan_id = $1', [planId]);
  return {
    plan: p,
    snapshot: {
      code: p.code, nameEn: p.name_en, nameRw: p.name_rw, price: p.price, validityDays: p.validity_days, allowanceUnit: p.allowance_unit,
      allowanceQuantity: Number(p.allowance_quantity), freeTrips: p.free_trips, overageDiscountPercent: p.overage_discount_percent,
      includedServiceIds: svc.map((s) => s.service_id),
    },
  };
}

export const subscriptionDto = (s: any) => ({
  id: s.id,
  planId: s.plan_id,
  plan: s.plan_snapshot,
  status: s.status,
  startsAt: s.starts_at,
  endsAt: s.ends_at,
  renewedFromId: s.renewed_from_id,
  createdAt: s.created_at,
});

export const plansRouter = Router();
plansRouter.get('/', async (_req, res) => {
  const plans = await q(pool, 'SELECT * FROM subscription_plans WHERE active ORDER BY price');
  const links = await q(pool, 'SELECT * FROM subscription_plan_services');
  res.json({ items: plans.map((p) => planDto(p, links.filter((l) => l.plan_id === p.id).map((l) => l.service_id))) });
});

export const subscriptionsRouter = Router();
subscriptionsRouter.use(requireAuth);

subscriptionsRouter.get('/current', async (req, res) => {
  const subs = await q(
    pool,
    `SELECT * FROM subscriptions WHERE user_id = $1 AND (status IN ('ACTIVE','PENDING_PAYMENT')) AND (ends_at IS NULL OR ends_at > now())
      ORDER BY created_at DESC`,
    [req.user!.id],
  );
  const active = subs.find((s) => s.status === 'ACTIVE' && new Date(s.starts_at) <= new Date());
  const terms = active ? await getSubscriptionTerms(pool, { subscriptionId: active.id }) : null;
  const usage = active
    ? await q(pool, `SELECT u.*, o.reference FROM subscription_usage u JOIN orders o ON o.id = u.order_id WHERE u.subscription_id = $1 ORDER BY u.created_at DESC`, [active.id])
    : [];
  const payments = subs.length
    ? await q(pool, 'SELECT * FROM payments WHERE subscription_id = ANY($1) ORDER BY created_at DESC', [subs.map((s) => s.id)])
    : [];
  res.json({
    active: active ? { ...subscriptionDto(active), unitsRemaining: terms?.unitsRemaining ?? 0, tripsRemaining: terms?.tripsRemaining ?? 0 } : null,
    upcoming: subs.filter((s) => s !== active).map(subscriptionDto),
    usage: usage.map((u) => ({ orderId: u.order_id, reference: u.reference, unitsUsed: u.units_used, tripsUsed: u.trips_used, reversed: !!u.reversed_at, createdAt: u.created_at })),
    payments: payments.map(paymentDto),
  });
});

/**
 * Starts a subscription purchase. It stays PENDING_PAYMENT until a payment succeeds — either Mobile Money
 * (POST /payments with subscriptionId) or cash recorded by staff. A renewal starts when the current one ends.
 */
subscriptionsRouter.post('/', async (req, res) => {
  const { planId } = z.object({ planId: z.uuid() }).parse(req.body);
  const s = await createPending(req.user!.id, planId, null);
  res.status(201).json({ subscription: subscriptionDto(s) });
});

subscriptionsRouter.post('/:id/renew', async (req, res) => {
  const id = idParam(req);
  const cur = await one(pool, 'SELECT * FROM subscriptions WHERE id = $1 AND user_id = $2', [id, req.user!.id]);
  if (!cur) throw notFound('Subscription not found.');
  if (!['ACTIVE', 'EXPIRED'].includes(cur.status)) throw conflict('CANNOT_RENEW', 'Only an active or expired subscription can be renewed.');
  const s = await createPending(req.user!.id, cur.plan_id, cur.id);
  res.status(201).json({ subscription: subscriptionDto(s) });
});

async function createPending(userId: string, planId: string, renewedFrom: string | null) {
  const p = await planSnapshot(pool, planId);
  if (!p) throw notFound('Plan not available.');
  return tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [userId]); // serialize per user
    const open = await one(c, `SELECT id FROM subscriptions WHERE user_id = $1 AND status = 'PENDING_PAYMENT'`, [userId]);
    if (open) throw conflict('SUBSCRIPTION_PENDING', 'You already have a subscription waiting for payment.', { subscriptionId: open.id });
    return one(c, `INSERT INTO subscriptions (user_id, plan_id, plan_snapshot, status, renewed_from_id) VALUES ($1,$2,$3,'PENDING_PAYMENT',$4) RETURNING *`, [
      userId, planId, JSON.stringify(p.snapshot), renewedFrom,
    ]);
  });
}

subscriptionsRouter.post('/:id/cancel-pending', async (req, res) => {
  const r = await pool.query(
    `UPDATE subscriptions SET status = 'CANCELLED' WHERE id = $1 AND user_id = $2 AND status = 'PENDING_PAYMENT'
       AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.subscription_id = subscriptions.id AND p.status IN ('PENDING','SUCCESSFUL'))`,
    [idParam(req), req.user!.id],
  );
  if (!r.rowCount) throw conflict('CANNOT_CANCEL', 'This subscription cannot be cancelled here (it may have a payment in progress).');
  res.status(204).end();
});

/** Expires subscriptions past their end date. Called opportunistically (no cron on free hosting). */
export async function expireSubscriptions() {
  await pool.query(`UPDATE subscriptions SET status = 'EXPIRED' WHERE status = 'ACTIVE' AND ends_at <= now()`);
}
