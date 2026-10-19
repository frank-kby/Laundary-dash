import { one, q, type Db } from '../db.js';
import { allowedNext, type OrderStatus } from '../domain/orderStatus.js';
import { orderBalance, paymentDto } from './payments.js';

/** Composite order view. `audience` controls which fields/events are visible. */
export async function orderDetail(db: Db, orderId: string, audience: 'customer' | 'staff') {
  const o = await one(
    db,
    `SELECT o.*, b.id AS booking_id, b.pickup_slot_id, b.pickup_address_snapshot, b.delivery_preference, b.delivery_address_snapshot,
            b.customer_notes, b.reschedule_count, ps.starts_at AS slot_start, ps.ends_at AS slot_end,
            u.full_name AS customer_name, u.phone AS customer_phone, u.email AS customer_email
       FROM orders o JOIN bookings b ON b.order_id = o.id JOIN pickup_slots ps ON ps.id = b.pickup_slot_id JOIN users u ON u.id = o.user_id
      WHERE o.id = $1`,
    [orderId],
  );
  if (!o) return null;
  const [items, events, revisions, payments, issues, tasks, adjustments, balance] = await Promise.all([
    q(db, 'SELECT * FROM order_items WHERE order_id = $1 ORDER BY created_at, id', [orderId]),
    q(
      db,
      `SELECT e.*, u.full_name AS actor_name, u.role AS actor_role FROM order_events e LEFT JOIN users u ON u.id = e.actor_user_id
        WHERE e.order_id = $1 ${audience === 'customer' ? 'AND e.visible_to_customer' : ''} ORDER BY e.created_at`,
      [orderId],
    ),
    q(db, 'SELECT * FROM price_revisions WHERE order_id = $1 ORDER BY created_at DESC', [orderId]),
    q(db, 'SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC', [orderId]),
    audience === 'staff' ? q(db, 'SELECT * FROM order_issues WHERE order_id = $1 ORDER BY created_at DESC', [orderId]) : Promise.resolve([]),
    audience === 'staff'
      ? q(db, `SELECT t.*, u.full_name AS rider_name FROM rider_tasks t JOIN users u ON u.id = t.rider_user_id WHERE t.order_id = $1 ORDER BY t.created_at DESC`, [orderId])
      : Promise.resolve([]),
    q(db, 'SELECT * FROM order_adjustments WHERE order_id = $1 ORDER BY created_at', [orderId]),
    orderBalance(db, orderId),
  ]);
  const pending = revisions.find((r) => r.status === 'PENDING');
  return {
    id: o.id,
    bookingId: o.booking_id,
    reference: o.reference,
    status: o.status,
    holdFromStatus: o.hold_from_status,
    paymentStatus: o.payment_status,
    estimatedTotal: o.estimated_total,
    agreedTotal: o.agreed_total,
    finalTotal: o.final_total,
    balance,
    pricing: o.pricing_snapshot,
    inspectionRecorded: o.inspection_recorded,
    pickupSlot: { id: o.pickup_slot_id, startsAt: o.slot_start, endsAt: o.slot_end },
    pickupAddress: o.pickup_address_snapshot,
    deliveryPreference: o.delivery_preference,
    deliveryAddress: o.delivery_address_snapshot,
    customerNotes: o.customer_notes,
    rescheduleCount: o.reschedule_count,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
    customer: audience === 'staff' ? { id: o.user_id, name: o.customer_name, phone: o.customer_phone, email: o.customer_email } : undefined,
    allowedNextStatuses: audience === 'staff' ? allowedNext(o.status as OrderStatus, o.hold_from_status) : undefined,
    items: items.map((i) => ({
      id: i.id,
      wardrobeItemId: i.wardrobe_item_id,
      name: i.name,
      kind: i.kind,
      categoryCode: i.category_code,
      categoryName: i.category_name,
      color: i.color,
      careNotes: i.care_notes,
      hasPhoto: !!i.photo_key,
      serviceId: i.service_id,
      serviceName: i.service_name,
      pricingUnit: i.pricing_unit,
      unitPrice: i.unit_price,
      declaredQuantity: i.declared_quantity,
      receivedQuantity: i.received_quantity,
      measuredWeightKg: i.measured_weight_kg,
      conditionNotes: i.condition_notes,
      addedByStaff: i.added_by_staff,
    })),
    adjustments: adjustments.map((a) => ({ id: a.id, description: a.description, amount: a.amount, voided: !!a.voided_at, revisionId: a.revision_id })),
    events: events.map((e) => ({
      id: e.id,
      type: e.event_type,
      fromStatus: e.from_status,
      toStatus: e.to_status,
      note: e.note,
      actor: audience === 'staff' ? e.actor_name : e.actor_role && e.actor_role !== 'CUSTOMER' ? 'Laundry Dash' : e.actor_name ? 'You' : null,
      createdAt: e.created_at,
    })),
    pendingRevision: pending
      ? { id: pending.id, previousTotal: pending.previous_total, proposedTotal: pending.proposed_total, reason: pending.reason, pricing: pending.pricing_snapshot, createdAt: pending.created_at }
      : null,
    revisions: revisions.map((r) => ({ id: r.id, previousTotal: r.previous_total, proposedTotal: r.proposed_total, reason: r.reason, status: r.status, requiresApproval: r.requires_approval, decisionChannel: r.decision_channel, decidedAt: r.decided_at, createdAt: r.created_at })),
    payments: payments.map(paymentDto),
    issues: issues.map((i) => ({ id: i.id, type: i.issue_type, status: i.status, description: i.description, resolution: i.resolution, createdAt: i.created_at, resolvedAt: i.resolved_at })),
    riderTasks: tasks.map((t) => ({ id: t.id, type: t.task_type, status: t.status, riderId: t.rider_user_id, riderName: t.rider_name, windowStart: t.window_start, windowEnd: t.window_end, failureReason: t.failure_reason, createdAt: t.created_at })),
  };
}

export function orderSummaryDto(o: any) {
  return {
    id: o.id,
    bookingId: o.booking_id,
    reference: o.reference,
    status: o.status,
    paymentStatus: o.payment_status,
    total: o.final_total ?? o.agreed_total,
    pickupSlot: o.slot_start ? { startsAt: o.slot_start, endsAt: o.slot_end } : undefined,
    itemCount: o.item_count,
    customerName: o.customer_name,
    customerPhone: o.customer_phone,
    areaName: o.area_name,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
  };
}
