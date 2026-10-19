import type pg from 'pg';
import { audit } from '../audit.js';
import { one, pool, q, tx, type Db } from '../db.js';
import { conflict } from '../errors.js';
import { log } from '../log.js';
import { paymentProvider, type ProviderStatus } from '../providers/payments.js';
import { notify } from './notify.js';
import { addOrderEvent } from './orders.js';

export function paymentDto(p: any) {
  return {
    id: p.id,
    orderId: p.order_id,
    subscriptionId: p.subscription_id,
    amount: p.amount,
    currency: p.currency,
    method: p.method,
    provider: p.provider,
    testMode: p.provider_mode === 'test',
    status: p.status,
    refundedAmount: p.refunded_amount,
    payerMsisdnMasked: p.payer_msisdn_masked,
    manualReference: p.manual_reference,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

/** Recomputes the order's payment status from its payments. Order *status* is never touched here. */
export async function refreshOrderPaymentStatus(db: Db, orderId: string) {
  const o = await one(db, 'SELECT final_total, agreed_total FROM orders WHERE id = $1', [orderId]);
  const s = await one(
    db,
    `SELECT COALESCE(SUM(amount) FILTER (WHERE status IN ('SUCCESSFUL','REFUNDED','PARTIALLY_REFUNDED')),0) AS paid,
            COALESCE(SUM(refunded_amount),0) AS refunded
       FROM payments WHERE order_id = $1`,
    [orderId],
  );
  const due = o.final_total ?? o.agreed_total;
  const net = s.paid - s.refunded;
  let status: string;
  if (s.refunded > 0) status = net <= 0 ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  else if (net <= 0) status = 'UNPAID';
  else if (net < due) status = 'PARTIALLY_PAID';
  else status = 'PAID';
  await db.query('UPDATE orders SET payment_status = $2, updated_at = now() WHERE id = $1', [orderId, status]);
  return { status, paid: s.paid, refunded: s.refunded, net, due, balance: Math.max(0, due - net) };
}

export async function orderBalance(db: Db, orderId: string) {
  const o = await one(db, 'SELECT final_total, agreed_total FROM orders WHERE id = $1', [orderId]);
  const s = await one(
    db,
    `SELECT COALESCE(SUM(amount - refunded_amount) FILTER (WHERE status IN ('SUCCESSFUL','PARTIALLY_REFUNDED','REFUNDED')),0) AS net,
            COALESCE(SUM(amount) FILTER (WHERE status = 'PENDING'),0) AS pending
       FROM payments WHERE order_id = $1`,
    [orderId],
  );
  const due = o.final_total ?? o.agreed_total;
  return { due, paid: s.net, pending: s.pending, balance: Math.max(0, due - s.net) };
}

/** Activates (or schedules, for renewals) a subscription once its payment succeeded. Idempotent. */
export async function activateSubscription(c: pg.PoolClient, subscriptionId: string, actorId: string | null) {
  const sub = await one(c, 'SELECT * FROM subscriptions WHERE id = $1 FOR UPDATE', [subscriptionId]);
  if (!sub || sub.status !== 'PENDING_PAYMENT') return sub;
  const current = await one(
    c,
    `SELECT MAX(ends_at) AS ends FROM subscriptions WHERE user_id = $1 AND status = 'ACTIVE' AND ends_at > now() AND id <> $2`,
    [sub.user_id, sub.id],
  );
  const start = current?.ends ? new Date(current.ends) : new Date();
  const end = new Date(start.getTime() + Number(sub.plan_snapshot.validityDays) * 86_400_000);
  const updated = await one(c, `UPDATE subscriptions SET status = 'ACTIVE', starts_at = $2, ends_at = $3 WHERE id = $1 RETURNING *`, [sub.id, start, end]);
  await audit(c, { actorId, action: 'subscription.activate', entityType: 'subscription', entityId: sub.id, after: { startsAt: start, endsAt: end } });
  await notify(c, sub.user_id, { type: 'SUBSCRIPTION', title: 'Laundry Dash', body: `Subscription active until ${end.toISOString().slice(0, 10)}` });
  return updated;
}

/**
 * Applies an authoritative provider status to a payment, exactly once.
 * - Dedup: (payment_id, provider_event_id) is unique; a replayed webhook inserts nothing and changes nothing.
 * - Only PENDING payments can move; terminal states are never overwritten by late/duplicate callbacks.
 * - UNKNOWN/PENDING results leave the payment PENDING (recorded for traceability).
 */
export async function applyProviderStatus(
  paymentId: string,
  result: { status: ProviderStatus; reason?: string },
  source: 'WEBHOOK' | 'POLL',
  eventId: string | null,
) {
  return tx(async (c) => {
    const p = await one(c, 'SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
    if (!p) return { changed: false, duplicate: false, payment: null };
    if (eventId) {
      const ins = await c.query(
        `INSERT INTO payment_events (payment_id, source, provider_event_id, from_status, to_status, detail)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [p.id, source, eventId, p.status, p.status, JSON.stringify({ providerStatus: result.status })],
      );
      if (ins.rowCount === 0) return { changed: false, duplicate: true, payment: p };
    }
    await c.query('UPDATE payments SET last_checked_at = now() WHERE id = $1', [p.id]);
    if (p.status !== 'PENDING' || result.status === 'PENDING' || result.status === 'UNKNOWN') {
      if (!eventId && (result.status === 'UNKNOWN')) {
        await c.query(`INSERT INTO payment_events (payment_id, source, from_status, to_status, detail) VALUES ($1,$2,$3,$3,$4)`, [
          p.id, source, p.status, JSON.stringify({ providerStatus: 'UNKNOWN', note: 'Result unknown; stays pending until checked' }),
        ]);
      }
      return { changed: false, duplicate: false, payment: p };
    }
    const to = result.status; // SUCCESSFUL | FAILED
    const updated = await one(c, 'UPDATE payments SET status = $2, updated_at = now() WHERE id = $1 RETURNING *', [p.id, to]);
    await c.query(`INSERT INTO payment_events (payment_id, source, from_status, to_status, detail) VALUES ($1,$2,$3,$4,$5)`, [
      p.id, source, p.status, to, JSON.stringify({ reason: result.reason ?? null }),
    ]);
    if (p.order_id) {
      await refreshOrderPaymentStatus(c, p.order_id);
      await addOrderEvent(c, { orderId: p.order_id, type: 'PAYMENT', note: `Mobile Money payment of ${p.amount} RWF ${to.toLowerCase()}${p.provider_mode === 'test' ? ' (TEST MODE)' : ''}` });
    }
    if (p.subscription_id && to === 'SUCCESSFUL') await activateSubscription(c, p.subscription_id, null);
    await notify(c, p.user_id, {
      type: 'PAYMENT',
      orderId: p.order_id,
      title: 'Laundry Dash',
      body: to === 'SUCCESSFUL' ? `Payment of ${p.amount} RWF received.` : `Payment of ${p.amount} RWF did not go through.`,
    });
    return { changed: true, duplicate: false, payment: updated };
  });
}

/** Server-to-provider status check (used by webhooks, customer polling and the staff "check status" button). */
export async function verifyWithProvider(paymentId: string, source: 'WEBHOOK' | 'POLL', eventId: string | null) {
  const p = await one(pool, 'SELECT * FROM payments WHERE id = $1', [paymentId]);
  if (!p || !paymentProvider || p.provider !== paymentProvider.name || !p.provider_reference) return null;
  const result = await paymentProvider.fetchStatus(p.provider_reference);
  return applyProviderStatus(p.id, result, source, eventId);
}

/** Creates a PENDING provider payment and asks the provider to prompt the customer's phone. */
export async function startMobileMoneyPayment(opts: {
  userId: string;
  orderId?: string | null;
  subscriptionId?: string | null;
  amount: number;
  msisdn: string;
  msisdnMasked: string;
  note: string;
}) {
  if (!paymentProvider) throw conflict('PAYMENT_PROVIDER_NOT_CONFIGURED', 'Mobile Money is not set up yet. Please pay cash or Mobile Money directly to our staff.');
  const p = await tx(async (c) => {
    if (opts.orderId) {
      await c.query('SELECT 1 FROM orders WHERE id = $1 FOR UPDATE', [opts.orderId]);
      const pending = await one(c, `SELECT * FROM payments WHERE order_id = $1 AND status = 'PENDING' AND method = 'MOBILE_MONEY'`, [opts.orderId]);
      if (pending) throw conflict('PAYMENT_ALREADY_PENDING', 'A payment for this order is already waiting for confirmation on your phone.', { paymentId: pending.id });
    }
    return one(
      c,
      `INSERT INTO payments (user_id, order_id, subscription_id, amount, method, provider, provider_mode, payer_msisdn_masked, status)
       VALUES ($1,$2,$3,$4,'MOBILE_MONEY',$5,$6,$7,'PENDING') RETURNING *`,
      [opts.userId, opts.orderId ?? null, opts.subscriptionId ?? null, opts.amount, paymentProvider!.name, paymentProvider!.mode, opts.msisdnMasked],
    );
  });
  const r = await paymentProvider.initiate({ paymentId: p.id, amount: opts.amount, msisdn: opts.msisdn, note: opts.note });
  const updated = await tx(async (c) => {
    await c.query(`INSERT INTO payment_events (payment_id, source, from_status, to_status, detail) VALUES ($1,'INITIATE','PENDING',$2,$3)`, [
      p.id, r.status, JSON.stringify({ reason: r.reason ?? null }),
    ]);
    return one(c, 'UPDATE payments SET provider_reference = $2, status = $3, updated_at = now() WHERE id = $1 RETURNING *', [p.id, r.providerReference, r.status]);
  });
  log.info('payment_initiated', { paymentId: p.id, provider: paymentProvider.name, status: r.status });
  return updated;
}

/** Staff-recorded payment (cash, or Mobile Money sent directly to the business number). */
export async function recordManualPayment(
  c: pg.PoolClient,
  opts: { userId: string; orderId?: string | null; subscriptionId?: string | null; amount: number; method: string; reference?: string | null; note?: string; actorId: string; ip?: string | null },
) {
  const p = await one(
    c,
    `INSERT INTO payments (user_id, order_id, subscription_id, amount, method, status, manual_reference, recorded_by)
     VALUES ($1,$2,$3,$4,$5,'SUCCESSFUL',$6,$7) RETURNING *`,
    [opts.userId, opts.orderId ?? null, opts.subscriptionId ?? null, opts.amount, opts.method, opts.reference ?? null, opts.actorId],
  );
  await c.query(`INSERT INTO payment_events (payment_id, source, from_status, to_status, detail, actor_user_id) VALUES ($1,'MANUAL',NULL,'SUCCESSFUL',$2,$3)`, [
    p.id, JSON.stringify({ note: opts.note ?? '' }), opts.actorId,
  ]);
  await audit(c, { actorId: opts.actorId, action: 'payment.manual', entityType: 'payment', entityId: p.id, after: { amount: opts.amount, method: opts.method, reference: opts.reference, orderId: opts.orderId, subscriptionId: opts.subscriptionId }, ip: opts.ip });
  if (opts.orderId) {
    await refreshOrderPaymentStatus(c, opts.orderId);
    await addOrderEvent(c, { orderId: opts.orderId, type: 'PAYMENT', note: `${opts.method} payment of ${opts.amount} RWF recorded by staff`, actorId: opts.actorId });
  }
  if (opts.subscriptionId) await activateSubscription(c, opts.subscriptionId, opts.actorId);
  return p;
}

export async function paymentHistory(db: Db, userId: string, limit: number, offset: number) {
  return q(db, 'SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [userId, limit, offset]);
}
