import type pg from 'pg';
import { audit } from '../audit.js';
import { one, q, type Db } from '../db.js';
import { conflict, notFound, unprocessable } from '../errors.js';
import { canTransition, guardTransition, type OrderStatus } from '../domain/orderStatus.js';
import { priceOrder, type PriceLineInput, type PricingResult, type SubscriptionTerms } from '../domain/pricing.js';
import { notifyOrderStatus } from './notify.js';

/** Active subscription terms for a user, with remaining allowance (excluding usage by `excludeOrderId`). */
export async function getSubscriptionTerms(
  db: Db,
  opts: { userId?: string; subscriptionId?: string; excludeOrderId?: string | null },
): Promise<SubscriptionTerms | null> {
  const sub = opts.subscriptionId
    ? await one(db, `SELECT * FROM subscriptions WHERE id = $1 AND status = 'ACTIVE' AND ends_at > now()`, [opts.subscriptionId])
    : await one(
        db,
        `SELECT * FROM subscriptions WHERE user_id = $1 AND status = 'ACTIVE' AND starts_at <= now() AND ends_at > now()
         ORDER BY ends_at ASC LIMIT 1`,
        [opts.userId],
      );
  if (!sub) return null;
  const used = await one(
    db,
    `SELECT COALESCE(SUM(units_used),0) AS units, COALESCE(SUM(trips_used),0) AS trips
       FROM subscription_usage WHERE subscription_id = $1 AND reversed_at IS NULL AND order_id IS DISTINCT FROM $2`,
    [sub.id, opts.excludeOrderId ?? null],
  );
  const p = sub.plan_snapshot;
  return {
    subscriptionId: sub.id,
    allowanceUnit: p.allowanceUnit,
    unitsRemaining: Math.max(0, Number(p.allowanceQuantity) - Number(used.units)),
    tripsRemaining: Math.max(0, Number(p.freeTrips) - Number(used.trips)),
    overageDiscountPercent: p.overageDiscountPercent,
    includedServiceIds: p.includedServiceIds,
  };
}

export async function lockOrder(c: pg.PoolClient, orderId: string) {
  const o = await one(c, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
  if (!o) throw notFound('Order not found.');
  return o;
}

/** Re-prices an order from its items as actually received, its live adjustments, and its locked fees. */
export async function computeOrderPrice(db: Db, order: any, extraAdjustments: { description: string; amount: number }[] = []): Promise<PricingResult> {
  const items = await q(db, 'SELECT * FROM order_items WHERE order_id = $1 ORDER BY created_at, id', [order.id]);
  const lines: PriceLineInput[] = items
    .map((i) => {
      const qty =
        i.pricing_unit === 'KG'
          ? i.measured_weight_kg ?? Number(i.declared_quantity)
          : i.received_quantity ?? Number(i.declared_quantity);
      return {
        ref: i.id,
        label: i.name,
        serviceId: i.service_id,
        serviceName: i.service_name,
        pricingUnit: i.pricing_unit,
        unitPrice: i.unit_price,
        minCharge: i.min_charge,
        quantity: Number(qty),
      };
    })
    .filter((l) => l.quantity > 0); // items recorded as "0 received" are not charged
  const adjustments = (
    await q(db, 'SELECT description, amount FROM order_adjustments WHERE order_id = $1 AND voided_at IS NULL ORDER BY created_at', [order.id])
  ).concat(extraAdjustments);
  const subscription = order.subscription_id
    ? await getSubscriptionTerms(db, { subscriptionId: order.subscription_id, excludeOrderId: order.id })
    : null;
  const snap = order.pricing_snapshot;
  return priceOrder({ lines, pickupFee: snap.pickupFee, deliveryFee: snap.deliveryFee, adjustments, subscription });
}

export async function addOrderEvent(
  db: Db,
  e: { orderId: string; type: string; from?: string | null; to?: string | null; note?: string; actorId?: string | null; visible?: boolean },
) {
  await db.query(
    `INSERT INTO order_events (order_id, event_type, from_status, to_status, note, actor_user_id, visible_to_customer)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [e.orderId, e.type, e.from ?? null, e.to ?? null, e.note ?? '', e.actorId ?? null, e.visible ?? true],
  );
}

/**
 * The single path for changing order status. Validates the edge and business guards, writes the
 * event + audit log, notifies the customer, and performs side effects (slot release, usage lock-in).
 */
export async function transitionOrder(
  c: pg.PoolClient,
  order: any,
  to: OrderStatus,
  actor: { id: string; role: string; ip?: string | null },
  note = '',
): Promise<any> {
  const from = order.status as OrderStatus;
  if (!canTransition(from, to, order.hold_from_status)) {
    throw conflict('INVALID_TRANSITION', `Cannot change status from ${from} to ${to}.`, { from, to });
  }
  const booking = await one(c, 'SELECT * FROM bookings WHERE order_id = $1', [order.id]);
  let pricing: PricingResult | null = null;
  if (to === 'PROCESSING') {
    pricing = await computeOrderPrice(c, order);
    const pending = await one(c, `SELECT 1 FROM price_revisions WHERE order_id = $1 AND status = 'PENDING'`, [order.id]);
    const code = guardTransition(from, to, {
      inspectionRecorded: order.inspection_recorded,
      hasPendingRevision: !!pending,
      currentTotal: pricing.total,
      agreedTotal: order.agreed_total,
      deliveryPreference: booking.delivery_preference,
    });
    if (code) throw unprocessable(code, guardMessage(code));
  } else {
    const code = guardTransition(from, to, {
      inspectionRecorded: order.inspection_recorded,
      hasPendingRevision: false,
      currentTotal: 0,
      agreedTotal: 0,
      deliveryPreference: booking.delivery_preference,
    });
    if (code) throw unprocessable(code, guardMessage(code));
  }

  const holdFrom = to === 'ON_HOLD' ? from : from === 'ON_HOLD' ? null : order.hold_from_status;
  const updated = await one(
    c,
    `UPDATE orders SET status = $2, hold_from_status = $3, updated_at = now(),
            final_total = COALESCE($4, final_total), pricing_snapshot = COALESCE($5, pricing_snapshot)
      WHERE id = $1 RETURNING *`,
    [order.id, to, holdFrom, pricing?.total ?? null, pricing ? JSON.stringify(pricing) : null],
  );

  // Side effects
  if (to === 'PROCESSING' && pricing && pricing.subscriptionId) {
    // Unique (subscription_id, order_id) => re-entering PROCESSING can never deduct twice.
    await c.query(
      `INSERT INTO subscription_usage (subscription_id, order_id, units_used, trips_used)
       VALUES ($1,$2,$3,$4) ON CONFLICT (subscription_id, order_id) DO NOTHING`,
      [pricing.subscriptionId, order.id, pricing.subscriptionUnitsUsed, pricing.subscriptionTripsUsed],
    );
  }
  if (to === 'CANCELLED') {
    if (['PENDING_CONFIRMATION', 'CONFIRMED', 'PICKUP_SCHEDULED'].includes(from) ||
        (from === 'ON_HOLD' && ['PENDING_CONFIRMATION', 'CONFIRMED', 'PICKUP_SCHEDULED'].includes(order.hold_from_status))) {
      await c.query('UPDATE pickup_slots SET booked_count = booked_count - 1 WHERE id = $1 AND booked_count > 0', [booking.pickup_slot_id]);
    }
    await c.query(`UPDATE rider_tasks SET status = 'CANCELLED', updated_at = now() WHERE order_id = $1 AND status IN ('ASSIGNED','EN_ROUTE')`, [order.id]);
    await c.query('UPDATE subscription_usage SET reversed_at = now() WHERE order_id = $1 AND reversed_at IS NULL', [order.id]);
  }

  await addOrderEvent(c, { orderId: order.id, type: 'STATUS_CHANGE', from, to, note, actorId: actor.id });
  await audit(c, { actorId: actor.id, action: 'order.status', entityType: 'order', entityId: order.id, before: { status: from }, after: { status: to, note }, ip: actor.ip });
  await notifyOrderStatus(c, order.user_id, order.id, order.reference, to);
  return updated;
}

export function guardMessage(code: string): string {
  return (
    {
      INSPECTION_REQUIRED: 'Record the inspection (received quantities/weight) before processing.',
      PRICE_APPROVAL_PENDING: 'A price revision is waiting for the customer’s decision.',
      PRICE_APPROVAL_REQUIRED: 'The current price is higher than what the customer agreed. Propose a price revision first.',
      DELIVERY_REQUIRES_RIDER: 'This order is for delivery: send it out for delivery first.',
      CUSTOMER_COLLECTS_AT_SHOP: 'The customer collects this order at the shop.',
    }[code] ?? code
  );
}

/**
 * Creates a price revision from the current recomputed price. If the new total exceeds what the customer
 * agreed, it requires approval and the order moves to AWAITING_APPROVAL; otherwise it is auto-applied.
 */
export async function proposeRevision(
  c: pg.PoolClient,
  order: any,
  actor: { id: string; role: string; ip?: string | null },
  reason: string,
) {
  const pricing = await computeOrderPrice(c, order);
  await c.query(`UPDATE price_revisions SET status = 'SUPERSEDED' WHERE order_id = $1 AND status = 'PENDING'`, [order.id]);
  const requiresApproval = pricing.total > order.agreed_total;
  const rev = await one(
    c,
    `INSERT INTO price_revisions (order_id, previous_total, proposed_total, pricing_snapshot, reason, requires_approval, status, proposed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [order.id, order.agreed_total, pricing.total, JSON.stringify(pricing), reason, requiresApproval, requiresApproval ? 'PENDING' : 'AUTO_APPLIED', actor.id],
  );
  await c.query(`UPDATE order_adjustments SET revision_id = $2 WHERE order_id = $1 AND revision_id IS NULL AND voided_at IS NULL`, [order.id, rev.id]);
  await audit(c, { actorId: actor.id, action: 'order.price_revision', entityType: 'order', entityId: order.id, before: { agreedTotal: order.agreed_total }, after: { proposedTotal: pricing.total, requiresApproval, reason }, ip: actor.ip });
  await addOrderEvent(c, {
    orderId: order.id,
    type: 'PRICE_REVISION',
    note: `${reason} — ${order.agreed_total} → ${pricing.total} RWF${requiresApproval ? ' (needs customer approval)' : ''}`,
    actorId: actor.id,
  });
  let current = order;
  if (requiresApproval) {
    if (order.status !== 'AWAITING_APPROVAL') current = await transitionOrder(c, order, 'AWAITING_APPROVAL', actor, reason);
  } else {
    current = await one(c, 'UPDATE orders SET agreed_total = $2, pricing_snapshot = $3, updated_at = now() WHERE id = $1 RETURNING *', [order.id, pricing.total, JSON.stringify(pricing)]);
  }
  return { revision: rev, order: current, pricing };
}

/** Applies a customer's (or staff-recorded) decision on the pending revision. */
export async function decideRevision(
  c: pg.PoolClient,
  order: any,
  revisionId: string,
  decision: 'APPROVE' | 'REJECT',
  actor: { id: string; role: string; ip?: string | null },
  channel: 'APP' | 'PHONE' | 'IN_PERSON' | 'WHATSAPP',
  note = '',
) {
  const rev = await one(c, 'SELECT * FROM price_revisions WHERE id = $1 AND order_id = $2 FOR UPDATE', [revisionId, order.id]);
  if (!rev) throw notFound('Price revision not found.');
  if (rev.status !== 'PENDING') throw conflict('REVISION_NOT_PENDING', 'This price change has already been decided.');
  if (order.status !== 'AWAITING_APPROVAL') throw conflict('INVALID_STATE', 'Order is not awaiting approval.');
  const status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  await c.query(
    `UPDATE price_revisions SET status = $2, decided_by = $3, decision_channel = $4, decision_note = $5, decided_at = now() WHERE id = $1`,
    [rev.id, status, actor.id, channel, note],
  );
  let updated;
  if (decision === 'APPROVE') {
    await c.query('UPDATE orders SET agreed_total = $2, pricing_snapshot = $3, updated_at = now() WHERE id = $1', [order.id, rev.proposed_total, JSON.stringify(rev.pricing_snapshot)]);
    const fresh = await lockOrder(c, order.id);
    updated = await transitionOrder(c, fresh, 'RECEIVED', actor, `Price ${rev.proposed_total} RWF approved via ${channel}`);
  } else {
    // Proposed extra work is withdrawn; staff must re-inspect / re-propose or return the items.
    await c.query('UPDATE order_adjustments SET voided_at = now() WHERE revision_id = $1', [rev.id]);
    updated = await transitionOrder(c, order, 'INSPECTION_REQUIRED', actor, `Price change rejected via ${channel}${note ? ': ' + note : ''}`);
  }
  await audit(c, { actorId: actor.id, action: `order.price_revision.${status.toLowerCase()}`, entityType: 'price_revision', entityId: rev.id, after: { channel, note }, ip: actor.ip });
  return updated;
}
