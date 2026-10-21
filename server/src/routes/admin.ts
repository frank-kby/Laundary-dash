import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { one, pool, q, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { idParam, paged, pagination } from '../http.js';
import { normalizeEmail, normalizePhone } from '../identifiers.js';
import { ORDER_STATUSES, WORKFLOW_ONLY, type OrderStatus } from '../domain/orderStatus.js';
import { requireRole, destroyAllSessionsForUser } from '../auth/session.js';
import { addOrderEvent, computeOrderPrice, decideRevision, lockOrder, proposeRevision, transitionOrder } from '../services/orders.js';
import { orderDetail, orderSummaryDto } from '../services/orderView.js';
import { orderBalance, paymentDto, recordManualPayment, refreshOrderPaymentStatus, verifyWithProvider } from '../services/payments.js';
import { hashPassword, issueResetToken, passwordSchema, userDto } from './auth.js';
import { getContact, setContact } from '../services/settings.js';
import { areaDto, categoryDto, serviceDto } from './catalog.js';
import { planDto, subscriptionDto } from './subscriptions.js';
import { sendPhoto } from './me.js';

export const adminRouter = Router();
adminRouter.use(requireRole('STAFF', 'ADMIN'));
const adminOnly = requireRole('ADMIN');
const actorOf = (req: any) => ({ id: req.user.id, role: req.user.role, ip: req.ip });

// ===================== Orders =====================
const orderFilter = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  q: z.string().trim().max(80).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  areaId: z.uuid().optional(),
  openIssues: z.enum(['true', 'false']).optional(),
});

adminRouter.get('/orders', async (req, res) => {
  const { page, pageSize, limit, offset } = pagination(req);
  const f = orderFilter.parse(req.query);
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (f.status) add('o.status = ?', f.status);
  if (f.q) add(`(o.reference ILIKE ? OR u.full_name ILIKE $${params.length + 1} OR u.phone ILIKE $${params.length + 1} OR u.email ILIKE $${params.length + 1})`, `%${f.q}%`);
  if (f.from) add('o.created_at >= ?::date', f.from);
  if (f.to) add(`o.created_at < (?::date + interval '1 day')`, f.to);
  if (f.areaId) add(`(b.pickup_address_snapshot->>'serviceAreaId') = ?`, f.areaId);
  if (f.openIssues === 'true') where.push(`EXISTS (SELECT 1 FROM order_issues i WHERE i.order_id = o.id AND i.status = 'OPEN')`);
  params.push(limit, offset);
  const rows = await q(
    pool,
    `SELECT o.*, b.id AS booking_id, ps.starts_at AS slot_start, ps.ends_at AS slot_end, u.full_name AS customer_name, u.phone AS customer_phone,
            b.pickup_address_snapshot->>'serviceAreaName' AS area_name,
            (SELECT count(*)::int FROM order_items i WHERE i.order_id = o.id) AS item_count, count(*) OVER()::int AS total
       FROM orders o JOIN bookings b ON b.order_id = o.id JOIN pickup_slots ps ON ps.id = b.pickup_slot_id JOIN users u ON u.id = o.user_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY o.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json(paged(rows.map(orderSummaryDto), rows[0]?.total ?? 0, page, pageSize));
});

adminRouter.get('/orders/:id', async (req, res) => {
  const d = await orderDetail(pool, idParam(req), 'staff');
  if (!d) throw notFound('Order not found.');
  res.json({ order: d });
});

adminRouter.get('/orders/:id/items/:itemId/photo', async (req, res) => {
  const i = await one(pool, 'SELECT photo_key FROM order_items WHERE id = $1 AND order_id = $2', [idParam(req, 'itemId'), idParam(req)]);
  if (!i?.photo_key) throw notFound('No photo.');
  await sendPhoto(res, i.photo_key);
});

adminRouter.post('/orders/:id/status', async (req, res) => {
  const b = z.object({ status: z.enum(ORDER_STATUSES), note: z.string().trim().max(500).default('') }).parse(req.body);
  if (WORKFLOW_ONLY.includes(b.status)) throw badRequest('Use a price revision to request customer approval.');
  const id = idParam(req);
  await tx(async (c) => {
    const o = await lockOrder(c, id);
    if ((b.status === 'CANCELLED' || b.status === 'ON_HOLD') && !b.note) throw badRequest('Please add a note explaining why.');
    await transitionOrder(c, o, b.status as OrderStatus, actorOf(req), b.note);
  });
  res.json({ order: await orderDetail(pool, id, 'staff') });
});

const inspectionSchema = z.object({
  items: z.array(z.object({
    id: z.uuid(),
    receivedQuantity: z.number().int().min(0).max(500).optional(),
    measuredWeightKg: z.number().min(0).max(200).optional(),
    conditionNotes: z.string().trim().max(500).default(''),
  })).default([]),
  addItems: z.array(z.object({
    name: z.string().trim().min(1).max(80),
    categoryId: z.uuid(),
    serviceId: z.uuid(),
    quantity: z.number().positive().max(500),
    conditionNotes: z.string().trim().max(500).default(''),
  })).max(50).default([]),
  adjustments: z.array(z.object({ description: z.string().trim().min(2).max(200), amount: z.number().int().min(-1_000_000).max(1_000_000) })).max(20).default([]),
  reason: z.string().trim().min(2).max(300).default('Inspection'),
});

/** Records what was actually received (counts, weight, condition) and re-prices. Increases need customer approval. */
adminRouter.post('/orders/:id/inspection', async (req, res) => {
  const b = inspectionSchema.parse(req.body);
  const id = idParam(req);
  const result = await tx(async (c) => {
    let o = await lockOrder(c, id);
    if (o.status === 'PICKED_UP') o = await transitionOrder(c, o, 'RECEIVED', actorOf(req), 'Received at shop');
    if (!['RECEIVED', 'INSPECTION_REQUIRED', 'AWAITING_APPROVAL'].includes(o.status)) {
      throw conflict('INVALID_STATE', 'Inspection can only be recorded after items arrive and before processing starts.');
    }
    const existing = await q(c, 'SELECT * FROM order_items WHERE order_id = $1', [id]);
    for (const it of b.items) {
      const cur = existing.find((e) => e.id === it.id);
      if (!cur) throw badRequest('Unknown order item.');
      if (cur.pricing_unit === 'KG' && it.measuredWeightKg === undefined) throw badRequest(`Enter the measured weight for "${cur.name}".`);
      await c.query(
        `UPDATE order_items SET received_quantity = $2, measured_weight_kg = $3, condition_notes = $4 WHERE id = $1`,
        [cur.id, it.receivedQuantity ?? (cur.pricing_unit === 'ITEM' ? Math.round(Number(cur.declared_quantity)) : null), it.measuredWeightKg ?? null, it.conditionNotes],
      );
    }
    for (const a of b.addItems) {
      const cat = await one(c, 'SELECT * FROM garment_categories WHERE id = $1', [a.categoryId]);
      const svc = await one(c, 'SELECT * FROM services WHERE id = $1 AND active', [a.serviceId]);
      if (!cat || !svc || cat.kind !== svc.kind) throw badRequest(`Added item "${a.name}": invalid category/service.`);
      const ov = await one(c, 'SELECT unit_price FROM service_category_prices WHERE service_id = $1 AND category_id = $2', [svc.id, cat.id]);
      await c.query(
        `INSERT INTO order_items (order_id, name, kind, category_code, category_name, service_id, service_code, service_name, pricing_unit, unit_price, min_charge,
                                  declared_quantity, received_quantity, measured_weight_kg, condition_notes, added_by_staff)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,true)`,
        [id, a.name, cat.kind, cat.code, cat.name_en, svc.id, svc.code, svc.name_en, svc.pricing_unit, ov?.unit_price ?? svc.unit_price, svc.min_charge, a.quantity,
         svc.pricing_unit === 'ITEM' ? Math.round(a.quantity) : null, svc.pricing_unit === 'KG' ? a.quantity : null, a.conditionNotes],
      );
    }
    for (const a of b.adjustments) {
      await c.query('INSERT INTO order_adjustments (order_id, description, amount, created_by) VALUES ($1,$2,$3,$4)', [id, a.description, a.amount, req.user!.id]);
    }
    await c.query('UPDATE orders SET inspection_recorded = true, updated_at = now() WHERE id = $1', [id]);
    const fresh = await lockOrder(c, id);
    await addOrderEvent(c, { orderId: id, type: 'INSPECTION', note: 'Items counted and inspected', actorId: req.user!.id });
    await audit(c, { actorId: req.user!.id, action: 'order.inspection', entityType: 'order', entityId: id, after: b, ip: req.ip });
    return proposeRevision(c, fresh, actorOf(req), b.reason);
  });
  res.json({ order: await orderDetail(pool, id, 'staff'), requiresApproval: result.revision.requires_approval });
});

/** Propose extra chargeable work (or a discount) before processing. */
adminRouter.post('/orders/:id/price-revisions', async (req, res) => {
  const b = z.object({
    adjustments: z.array(z.object({ description: z.string().trim().min(2).max(200), amount: z.number().int().min(-1_000_000).max(1_000_000) })).min(1).max(20),
    reason: z.string().trim().min(2).max(300),
  }).parse(req.body);
  const id = idParam(req);
  const result = await tx(async (c) => {
    const o = await lockOrder(c, id);
    if (!['RECEIVED', 'INSPECTION_REQUIRED', 'AWAITING_APPROVAL'].includes(o.status)) {
      throw conflict('INVALID_STATE', 'Prices can only be revised after items arrive and before processing starts.');
    }
    for (const a of b.adjustments) await c.query('INSERT INTO order_adjustments (order_id, description, amount, created_by) VALUES ($1,$2,$3,$4)', [id, a.description, a.amount, req.user!.id]);
    return proposeRevision(c, o, actorOf(req), b.reason);
  });
  res.status(201).json({ order: await orderDetail(pool, id, 'staff'), requiresApproval: result.revision.requires_approval });
});

/** Staff records a decision the customer gave by phone, WhatsApp or in person. */
adminRouter.post('/orders/:id/price-revisions/:revisionId/decision', async (req, res) => {
  const b = z.object({ decision: z.enum(['APPROVE', 'REJECT']), channel: z.enum(['PHONE', 'IN_PERSON', 'WHATSAPP']), note: z.string().trim().min(2, 'Note who you spoke to and when.').max(300) }).parse(req.body);
  const id = idParam(req);
  await tx(async (c) => {
    const o = await lockOrder(c, id);
    await decideRevision(c, o, idParam(req, 'revisionId'), b.decision, actorOf(req), b.channel, b.note);
  });
  res.json({ order: await orderDetail(pool, id, 'staff') });
});

adminRouter.get('/orders/:id/price-preview', async (req, res) => {
  const o = await one(pool, 'SELECT * FROM orders WHERE id = $1', [idParam(req)]);
  if (!o) throw notFound();
  res.json({ pricing: await computeOrderPrice(pool, o), agreedTotal: o.agreed_total });
});

// ----- Issues (failed pickups/deliveries, disputes, delays, payment uncertainty) -----
const ISSUE_TYPES = ['FAILED_PICKUP', 'FAILED_DELIVERY', 'GARMENT_DISPUTE', 'DELAY', 'PAYMENT_UNCERTAIN', 'DAMAGE', 'OTHER'] as const;
adminRouter.post('/orders/:id/issues', async (req, res) => {
  const b = z.object({ type: z.enum(ISSUE_TYPES), description: z.string().trim().min(3).max(1000), putOnHold: z.boolean().default(false), notifyCustomer: z.boolean().default(false) }).parse(req.body);
  const id = idParam(req);
  await tx(async (c) => {
    const o = await lockOrder(c, id);
    const issue = await one(c, 'INSERT INTO order_issues (order_id, issue_type, description, created_by) VALUES ($1,$2,$3,$4) RETURNING id', [id, b.type, b.description, req.user!.id]);
    await addOrderEvent(c, { orderId: id, type: 'ISSUE', note: `${b.type}: ${b.description}`, actorId: req.user!.id, visible: b.notifyCustomer });
    await audit(c, { actorId: req.user!.id, action: 'order.issue.open', entityType: 'order_issue', entityId: issue.id, after: b, ip: req.ip });
    if (b.putOnHold && o.status !== 'ON_HOLD') await transitionOrder(c, o, 'ON_HOLD', actorOf(req), `${b.type}`);
  });
  res.status(201).json({ order: await orderDetail(pool, id, 'staff') });
});

adminRouter.post('/issues/:id/resolve', async (req, res) => {
  const b = z.object({ resolution: z.string().trim().min(3).max(1000) }).parse(req.body);
  const issue = await one(pool, `UPDATE order_issues SET status='RESOLVED', resolution=$2, resolved_by=$3, resolved_at=now() WHERE id=$1 AND status='OPEN' RETURNING *`, [idParam(req), b.resolution, req.user!.id]);
  if (!issue) throw notFound('Open issue not found.');
  await addOrderEvent(pool, { orderId: issue.order_id, type: 'ISSUE', note: `Resolved ${issue.issue_type}: ${b.resolution}`, actorId: req.user!.id, visible: false });
  await audit(pool, { actorId: req.user!.id, action: 'order.issue.resolve', entityType: 'order_issue', entityId: issue.id, after: b, ip: req.ip });
  res.json({ order: await orderDetail(pool, issue.order_id, 'staff') });
});

// ----- Rider assignment -----
adminRouter.get('/riders', async (_req, res) => {
  const rows = await q(pool, `SELECT u.id, u.full_name, u.phone,
      (SELECT count(*)::int FROM rider_tasks t WHERE t.rider_user_id = u.id AND t.status IN ('ASSIGNED','EN_ROUTE')) AS open_tasks
      FROM users u WHERE u.role = 'RIDER' AND u.status = 'ACTIVE' ORDER BY u.full_name`);
  res.json({ items: rows.map((r) => ({ id: r.id, name: r.full_name, phone: r.phone, openTasks: r.open_tasks })) });
});

adminRouter.post('/orders/:id/rider-tasks', async (req, res) => {
  const b = z.object({ type: z.enum(['PICKUP', 'DELIVERY']), riderId: z.uuid(), instructions: z.string().trim().max(500).default('') }).parse(req.body);
  const id = idParam(req);
  await tx(async (c) => {
    const o = await lockOrder(c, id);
    const rider = await one(c, `SELECT id FROM users WHERE id = $1 AND role = 'RIDER' AND status = 'ACTIVE'`, [b.riderId]);
    if (!rider) throw badRequest('Choose an active rider.');
    const booking = await one(c, 'SELECT b.*, ps.starts_at, ps.ends_at FROM bookings b JOIN pickup_slots ps ON ps.id = b.pickup_slot_id WHERE b.order_id = $1', [id]);
    if (b.type === 'PICKUP' && !['CONFIRMED', 'PICKUP_SCHEDULED'].includes(o.status)) throw conflict('INVALID_STATE', 'Confirm the booking before assigning a pickup.');
    if (b.type === 'DELIVERY') {
      if (o.status !== 'READY_FOR_DELIVERY') throw conflict('INVALID_STATE', 'Order must be ready before assigning delivery.');
      if (booking.delivery_preference !== 'DELIVER_TO_ADDRESS') throw conflict('CUSTOMER_COLLECTS_AT_SHOP', 'The customer collects this order at the shop.');
    }
    // Re-assigning replaces the previous live task.
    await c.query(`UPDATE rider_tasks SET status='CANCELLED', updated_at=now() WHERE order_id=$1 AND task_type=$2 AND status IN ('ASSIGNED','EN_ROUTE')`, [id, b.type]);
    await c.query(
      `INSERT INTO rider_tasks (order_id, rider_user_id, task_type, window_start, window_end, instructions, assigned_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, b.riderId, b.type, b.type === 'PICKUP' ? booking.starts_at : null, b.type === 'PICKUP' ? booking.ends_at : null, b.instructions, req.user!.id],
    );
    await addOrderEvent(c, { orderId: id, type: 'TASK', note: `${b.type} assigned to rider`, actorId: req.user!.id, visible: false });
    if (b.type === 'PICKUP' && o.status === 'CONFIRMED') await transitionOrder(c, o, 'PICKUP_SCHEDULED', actorOf(req), 'Rider assigned');
  });
  res.status(201).json({ order: await orderDetail(pool, id, 'staff') });
});

// ----- Payments -----
const manualPaymentSchema = z.object({
  amount: z.number().int().positive().max(10_000_000),
  method: z.enum(['CASH', 'MANUAL_MOBILE_MONEY', 'BANK_TRANSFER']),
  reference: z.string().trim().max(100).optional(),
  note: z.string().trim().max(300).default(''),
});

adminRouter.post('/orders/:id/payments/manual', async (req, res) => {
  const b = manualPaymentSchema.parse(req.body);
  if (b.method !== 'CASH' && !b.reference) throw badRequest('Enter the transaction reference for non-cash payments.');
  const id = idParam(req);
  await tx(async (c) => {
    const o = await lockOrder(c, id);
    if (o.status === 'CANCELLED') throw conflict('ORDER_CANCELLED', 'Order is cancelled.');
    const bal = await orderBalance(c, id);
    if (b.amount > bal.balance) throw unprocessable('OVERPAYMENT', `Amount exceeds the outstanding balance (${bal.balance} RWF).`);
    await recordManualPayment(c, { userId: o.user_id, orderId: id, amount: b.amount, method: b.method, reference: b.reference, note: b.note, actorId: req.user!.id, ip: req.ip });
  });
  res.status(201).json({ order: await orderDetail(pool, id, 'staff') });
});

adminRouter.post('/payments/:id/check-status', async (req, res) => {
  const id = idParam(req);
  const r = await verifyWithProvider(id, 'POLL', null);
  if (!r) throw conflict('NOT_CHECKABLE', 'This payment has no configured provider to check with.');
  const p = await one(pool, 'SELECT * FROM payments WHERE id = $1', [id]);
  res.json({ payment: paymentDto(p) });
});

adminRouter.post('/payments/:id/refunds', adminOnly, async (req, res) => {
  const b = z.object({
    amount: z.number().int().positive(),
    method: z.enum(['CASH', 'MANUAL_MOBILE_MONEY', 'BANK_TRANSFER']),
    reason: z.string().trim().min(3).max(300),
    reference: z.string().trim().max(100).optional(),
  }).parse(req.body);
  const id = idParam(req);
  const p = await tx(async (c) => {
    const p = await one(c, 'SELECT * FROM payments WHERE id = $1 FOR UPDATE', [id]);
    if (!p) throw notFound('Payment not found.');
    if (!['SUCCESSFUL', 'PARTIALLY_REFUNDED'].includes(p.status)) throw conflict('NOT_REFUNDABLE', 'Only successful payments can be refunded.');
    if (b.amount > p.amount - p.refunded_amount) throw unprocessable('REFUND_TOO_LARGE', `Maximum refundable is ${p.amount - p.refunded_amount} RWF.`);
    await c.query('INSERT INTO refunds (payment_id, amount, method, reason, reference, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [p.id, b.amount, b.method, b.reason, b.reference ?? null, req.user!.id]);
    const refunded = p.refunded_amount + b.amount;
    const status = refunded === p.amount ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    const u = await one(c, 'UPDATE payments SET refunded_amount = $2, status = $3, updated_at = now() WHERE id = $1 RETURNING *', [p.id, refunded, status]);
    await c.query(`INSERT INTO payment_events (payment_id, source, from_status, to_status, detail, actor_user_id) VALUES ($1,'MANUAL',$2,$3,$4,$5)`, [p.id, p.status, status, JSON.stringify({ refund: b.amount, reason: b.reason }), req.user!.id]);
    await audit(c, { actorId: req.user!.id, action: 'payment.refund', entityType: 'payment', entityId: p.id, before: { refunded: p.refunded_amount }, after: b, ip: req.ip });
    if (p.order_id) {
      await refreshOrderPaymentStatus(c, p.order_id);
      await addOrderEvent(c, { orderId: p.order_id, type: 'PAYMENT', note: `Refund of ${b.amount} RWF (${b.method})`, actorId: req.user!.id });
    }
    return u;
  });
  res.status(201).json({ payment: paymentDto(p) });
});

adminRouter.get('/payments', async (req, res) => {
  const { page, pageSize, limit, offset } = pagination(req);
  const { status } = z.object({ status: z.enum(['PENDING', 'SUCCESSFUL', 'FAILED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED']).optional() }).parse(req.query);
  const rows = await q(
    pool,
    `SELECT p.*, u.full_name, o.reference, count(*) OVER()::int AS total FROM payments p JOIN users u ON u.id = p.user_id LEFT JOIN orders o ON o.id = p.order_id
      ${status ? 'WHERE p.status = $3' : ''} ORDER BY p.created_at DESC LIMIT $1 OFFSET $2`,
    status ? [limit, offset, status] : [limit, offset],
  );
  res.json(paged(rows.map((r) => ({ ...paymentDto(r), customerName: r.full_name, orderReference: r.reference })), rows[0]?.total ?? 0, page, pageSize));
});

// ===================== Subscriptions =====================
adminRouter.get('/subscriptions', async (req, res) => {
  const { page, pageSize, limit, offset } = pagination(req);
  const rows = await q(
    pool,
    `SELECT s.*, u.full_name, u.phone, u.email, count(*) OVER()::int AS total FROM subscriptions s JOIN users u ON u.id = s.user_id
      ORDER BY (s.status = 'PENDING_PAYMENT') DESC, s.created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  res.json(paged(rows.map((r) => ({ ...subscriptionDto(r), customerName: r.full_name, customerPhone: r.phone, customerEmail: r.email })), rows[0]?.total ?? 0, page, pageSize));
});

adminRouter.post('/subscriptions/:id/payments/manual', async (req, res) => {
  const b = manualPaymentSchema.parse(req.body);
  if (b.method !== 'CASH' && !b.reference) throw badRequest('Enter the transaction reference for non-cash payments.');
  const id = idParam(req);
  await tx(async (c) => {
    const s = await one(c, 'SELECT * FROM subscriptions WHERE id = $1 FOR UPDATE', [id]);
    if (!s || s.status !== 'PENDING_PAYMENT') throw conflict('NOT_PENDING', 'Subscription is not awaiting payment.');
    if (b.amount !== s.plan_snapshot.price) throw unprocessable('AMOUNT_MISMATCH', `Plan price is ${s.plan_snapshot.price} RWF.`);
    const pend = await one(c, `SELECT 1 FROM payments WHERE subscription_id = $1 AND status = 'PENDING'`, [id]);
    if (pend) throw conflict('PAYMENT_ALREADY_PENDING', 'A Mobile Money payment is pending for this subscription. Check its status first.');
    await recordManualPayment(c, { userId: s.user_id, subscriptionId: id, amount: b.amount, method: b.method, reference: b.reference, note: b.note, actorId: req.user!.id, ip: req.ip });
  });
  res.status(201).json({ subscription: subscriptionDto(await one(pool, 'SELECT * FROM subscriptions WHERE id = $1', [id])) });
});

// ===================== Catalogue configuration (ADMIN writes) =====================
const serviceSchema = z.object({
  code: z.string().trim().regex(/^[A-Z0-9_]{2,30}$/, 'Use capitals, digits and _'),
  nameEn: z.string().trim().min(2).max(80),
  nameRw: z.string().trim().min(2).max(80),
  descriptionEn: z.string().trim().max(300).default(''),
  descriptionRw: z.string().trim().max(300).default(''),
  kind: z.enum(['CLOTHES', 'SHOES']),
  pricingUnit: z.enum(['ITEM', 'KG']),
  unitPrice: z.number().int().min(0).max(1_000_000),
  minCharge: z.number().int().min(0).max(1_000_000).default(0),
  turnaroundHours: z.number().int().min(1).max(720).default(48),
  active: z.boolean().default(true),
  categoryPrices: z.array(z.object({ categoryId: z.uuid(), unitPrice: z.number().int().min(0).max(1_000_000) })).default([]),
});

adminRouter.get('/services', async (_req, res) => {
  const [s, o] = await Promise.all([q(pool, 'SELECT * FROM services ORDER BY sort_order, name_en'), q(pool, 'SELECT * FROM service_category_prices')]);
  res.json({ items: s.map((x) => serviceDto(x, o)) });
});

async function saveService(id: string | null, b: z.infer<typeof serviceSchema>, req: any) {
  return tx(async (c) => {
    const before = id ? await one(c, 'SELECT * FROM services WHERE id = $1 FOR UPDATE', [id]) : null;
    if (id && !before) throw notFound('Service not found.');
    const s = id
      ? await one(c, `UPDATE services SET code=$2,name_en=$3,name_rw=$4,description_en=$5,description_rw=$6,kind=$7,pricing_unit=$8,unit_price=$9,min_charge=$10,turnaround_hours=$11,active=$12,updated_at=now() WHERE id=$1 RETURNING *`,
          [id, b.code, b.nameEn, b.nameRw, b.descriptionEn, b.descriptionRw, b.kind, b.pricingUnit, b.unitPrice, b.minCharge, b.turnaroundHours, b.active])
      : await one(c, `INSERT INTO services (code,name_en,name_rw,description_en,description_rw,kind,pricing_unit,unit_price,min_charge,turnaround_hours,active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [b.code, b.nameEn, b.nameRw, b.descriptionEn, b.descriptionRw, b.kind, b.pricingUnit, b.unitPrice, b.minCharge, b.turnaroundHours, b.active]);
    const prevPrices = await q(c, 'SELECT category_id, unit_price FROM service_category_prices WHERE service_id = $1', [s.id]);
    await c.query('DELETE FROM service_category_prices WHERE service_id = $1', [s.id]);
    for (const p of b.categoryPrices) await c.query('INSERT INTO service_category_prices (service_id, category_id, unit_price) VALUES ($1,$2,$3)', [s.id, p.categoryId, p.unitPrice]);
    // Price changes are audited; existing orders keep their own snapshot prices.
    await audit(c, { actorId: req.user.id, action: id ? 'service.update' : 'service.create', entityType: 'service', entityId: s.id, before: before ? { ...before, categoryPrices: prevPrices } : undefined, after: b, ip: req.ip });
    const o = await q(c, 'SELECT * FROM service_category_prices WHERE service_id = $1', [s.id]);
    return serviceDto(s, o);
  });
}
const uniqueOr409 = async <T>(fn: () => Promise<T>) => {
  try {
    return await fn();
  } catch (e: any) {
    if (e?.code === '23505') throw conflict('DUPLICATE', 'That code is already used.');
    throw e;
  }
};

adminRouter.post('/services', adminOnly, async (req, res) => {
  res.status(201).json({ service: await uniqueOr409(() => saveService(null, serviceSchema.parse(req.body), req)) });
});
adminRouter.put('/services/:id', adminOnly, async (req, res) => {
  res.json({ service: await uniqueOr409(() => saveService(idParam(req), serviceSchema.parse(req.body), req)) });
});

const areaSchema = z.object({
  code: z.string().trim().regex(/^[A-Z0-9_]{2,30}$/),
  name: z.string().trim().min(2).max(80),
  district: z.enum(['Gasabo', 'Kicukiro', 'Nyarugenge']),
  landmarks: z.string().trim().max(500).default(''),
  pickupFee: z.number().int().min(0).max(100_000),
  deliveryFee: z.number().int().min(0).max(100_000),
  active: z.boolean().default(true),
});
adminRouter.get('/service-areas', async (_req, res) => {
  res.json({ items: (await q(pool, 'SELECT * FROM service_areas ORDER BY sort_order, name')).map(areaDto) });
});
adminRouter.post('/service-areas', adminOnly, async (req, res) => {
  const b = areaSchema.parse(req.body);
  const a = await uniqueOr409(() => one(pool, 'INSERT INTO service_areas (code,name,district,landmarks,pickup_fee,delivery_fee,active) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [b.code, b.name, b.district, b.landmarks, b.pickupFee, b.deliveryFee, b.active]));
  await audit(pool, { actorId: req.user!.id, action: 'service_area.create', entityType: 'service_area', entityId: a.id, after: b, ip: req.ip });
  res.status(201).json({ area: areaDto(a) });
});
adminRouter.put('/service-areas/:id', adminOnly, async (req, res) => {
  const b = areaSchema.parse(req.body);
  const id = idParam(req);
  const before = await one(pool, 'SELECT * FROM service_areas WHERE id = $1', [id]);
  if (!before) throw notFound();
  const a = await uniqueOr409(() => one(pool, 'UPDATE service_areas SET code=$2,name=$3,district=$4,landmarks=$5,pickup_fee=$6,delivery_fee=$7,active=$8 WHERE id=$1 RETURNING *', [id, b.code, b.name, b.district, b.landmarks, b.pickupFee, b.deliveryFee, b.active]));
  await audit(pool, { actorId: req.user!.id, action: 'service_area.update', entityType: 'service_area', entityId: id, before, after: b, ip: req.ip });
  res.json({ area: areaDto(a) });
});

const categorySchema = z.object({
  code: z.string().trim().regex(/^[A-Z0-9_]{2,30}$/),
  kind: z.enum(['CLOTHES', 'SHOES']),
  nameEn: z.string().trim().min(2).max(60),
  nameRw: z.string().trim().min(2).max(60),
  gender: z.enum(['ANY', 'FEMALE', 'MALE']).default('ANY'),
  segment: z.enum(['PERSONAL', 'BUSINESS']).default('PERSONAL'),
  lifespanMonths: z.number().int().min(1).max(240).default(36),
  active: z.boolean().default(true),
});
adminRouter.get('/categories', async (_req, res) => {
  res.json({ items: (await q(pool, 'SELECT * FROM garment_categories ORDER BY sort_order, name_en')).map(categoryDto) });
});
adminRouter.post('/categories', adminOnly, async (req, res) => {
  const b = categorySchema.parse(req.body);
  const c = await uniqueOr409(() => one(pool, 'INSERT INTO garment_categories (code,kind,name_en,name_rw,gender,segment,lifespan_months,active,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,100) RETURNING *', [b.code, b.kind, b.nameEn, b.nameRw, b.gender, b.segment, b.lifespanMonths, b.active]));
  await audit(pool, { actorId: req.user!.id, action: 'category.create', entityType: 'category', entityId: c.id, after: b, ip: req.ip });
  res.status(201).json({ category: categoryDto(c) });
});
adminRouter.put('/categories/:id', adminOnly, async (req, res) => {
  const b = categorySchema.parse(req.body);
  const id = idParam(req);
  const c = await uniqueOr409(() => one(pool, 'UPDATE garment_categories SET code=$2,kind=$3,name_en=$4,name_rw=$5,gender=$6,segment=$7,lifespan_months=$8,active=$9 WHERE id=$1 RETURNING *', [id, b.code, b.kind, b.nameEn, b.nameRw, b.gender, b.segment, b.lifespanMonths, b.active]));
  if (!c) throw notFound();
  await audit(pool, { actorId: req.user!.id, action: 'category.update', entityType: 'category', entityId: id, after: b, ip: req.ip });
  res.json({ category: categoryDto(c) });
});

const planSchema = z.object({
  code: z.string().trim().regex(/^[A-Z0-9_]{2,30}$/),
  nameEn: z.string().trim().min(2).max(80),
  nameRw: z.string().trim().min(2).max(80),
  descriptionEn: z.string().trim().max(500).default(''),
  descriptionRw: z.string().trim().max(500).default(''),
  price: z.number().int().min(0).max(10_000_000),
  validityDays: z.number().int().min(1).max(366),
  allowanceUnit: z.enum(['ITEM', 'KG']),
  allowanceQuantity: z.number().min(0).max(10_000),
  freeTrips: z.number().int().min(0).max(100),
  overageDiscountPercent: z.number().int().min(0).max(100),
  includedServiceIds: z.array(z.uuid()).min(1),
  active: z.boolean().default(true),
});
adminRouter.get('/subscription-plans', async (_req, res) => {
  const plans = await q(pool, 'SELECT * FROM subscription_plans ORDER BY price');
  const links = await q(pool, 'SELECT * FROM subscription_plan_services');
  res.json({ items: plans.map((p) => planDto(p, links.filter((l) => l.plan_id === p.id).map((l) => l.service_id))) });
});
async function savePlan(id: string | null, b: z.infer<typeof planSchema>, req: any) {
  return tx(async (c) => {
    const svcs = await q(c, 'SELECT id, pricing_unit FROM services WHERE id = ANY($1)', [b.includedServiceIds]);
    if (svcs.length !== b.includedServiceIds.length) throw badRequest('Unknown service in plan.');
    if (svcs.some((s) => s.pricing_unit !== b.allowanceUnit)) throw badRequest(`Included services must be priced per ${b.allowanceUnit === 'KG' ? 'kg' : 'item'} to match the allowance.`);
    const before = id ? await one(c, 'SELECT * FROM subscription_plans WHERE id = $1', [id]) : null;
    if (id && !before) throw notFound();
    const p = id
      ? await one(c, `UPDATE subscription_plans SET code=$2,name_en=$3,name_rw=$4,description_en=$5,description_rw=$6,price=$7,validity_days=$8,allowance_unit=$9,allowance_quantity=$10,free_trips=$11,overage_discount_percent=$12,active=$13,updated_at=now() WHERE id=$1 RETURNING *`,
          [id, b.code, b.nameEn, b.nameRw, b.descriptionEn, b.descriptionRw, b.price, b.validityDays, b.allowanceUnit, b.allowanceQuantity, b.freeTrips, b.overageDiscountPercent, b.active])
      : await one(c, `INSERT INTO subscription_plans (code,name_en,name_rw,description_en,description_rw,price,validity_days,allowance_unit,allowance_quantity,free_trips,overage_discount_percent,active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [b.code, b.nameEn, b.nameRw, b.descriptionEn, b.descriptionRw, b.price, b.validityDays, b.allowanceUnit, b.allowanceQuantity, b.freeTrips, b.overageDiscountPercent, b.active]);
    await c.query('DELETE FROM subscription_plan_services WHERE plan_id = $1', [p.id]);
    for (const s of b.includedServiceIds) await c.query('INSERT INTO subscription_plan_services (plan_id, service_id) VALUES ($1,$2)', [p.id, s]);
    // Existing subscriptions keep their purchased terms (plan_snapshot).
    await audit(c, { actorId: req.user.id, action: id ? 'plan.update' : 'plan.create', entityType: 'subscription_plan', entityId: p.id, before, after: b, ip: req.ip });
    return planDto(p, b.includedServiceIds);
  });
}
adminRouter.post('/subscription-plans', adminOnly, async (req, res) => {
  res.status(201).json({ plan: await uniqueOr409(() => savePlan(null, planSchema.parse(req.body), req)) });
});
adminRouter.put('/subscription-plans/:id', adminOnly, async (req, res) => {
  res.json({ plan: await uniqueOr409(() => savePlan(idParam(req), planSchema.parse(req.body), req)) });
});

// ----- Business contact numbers shown to customers (WhatsApp + phone) -----
adminRouter.get('/settings/contact', async (_req, res) => {
  res.json({ contact: await getContact(pool) });
});

adminRouter.put('/settings/contact', adminOnly, async (req, res) => {
  const b = z.object({ phone: z.string().trim().max(20), whatsapp: z.string().trim().max(20) }).parse(req.body);
  const phone = normalizePhone(b.phone);
  const wa = normalizePhone(b.whatsapp);
  if (!phone) throw badRequest('Enter a valid phone number for calls, e.g. 078 123 4567.', [{ path: 'phone', message: 'invalid' }]);
  if (!wa) throw badRequest('Enter a valid WhatsApp number, e.g. 078 123 4567.', [{ path: 'whatsapp', message: 'invalid' }]);
  const before = await getContact(pool);
  const value = { phone, whatsapp: wa.replace(/\D/g, '') }; // wa.me needs digits only, no +
  await setContact(pool, value, req.user!.id);
  await audit(pool, { actorId: req.user!.id, action: 'settings.contact', entityType: 'app_settings', entityId: 'contact', before, after: value, ip: req.ip });
  res.json({ contact: { ...value, source: 'settings' } });
});

// ----- Pickup slots -----
adminRouter.get('/pickup-slots', async (req, res) => {
  const { days } = z.object({ days: z.coerce.number().int().min(1).max(31).default(7) }).parse(req.query);
  const rows = await q(pool, `SELECT * FROM pickup_slots WHERE ends_at > now() AND starts_at < now() + ($1 || ' days')::interval ORDER BY starts_at`, [String(days)]);
  res.json({ items: rows.map((s) => ({ id: s.id, startsAt: s.starts_at, endsAt: s.ends_at, capacity: s.capacity, booked: s.booked_count, active: s.active })) });
});

/** Converts a local wall-clock time in the business timezone to a UTC Date (works for DST zones too). */
export function zonedTime(dateIso: string, hour: number, minute: number, tz = config.BUSINESS_TIMEZONE): Date {
  const guess = new Date(`${dateIso}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(guess);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asLocal = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return new Date(guess.getTime() - (asLocal - guess.getTime()));
}

export const slotGenSchema = z.object({
  days: z.number().int().min(1).max(31).default(7),
  startHour: z.number().int().min(5).max(20).default(8),
  endHour: z.number().int().min(6).max(22).default(18),
  slotMinutes: z.number().int().refine((n) => [60, 90, 120, 180].includes(n)).default(120),
  capacity: z.number().int().min(1).max(100).default(4),
  weekdays: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5, 6]), // Mon–Sat
});

export async function generateSlots(b: z.infer<typeof slotGenSchema>) {
  let created = 0;
  const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: config.BUSINESS_TIMEZONE }).format(new Date());
  for (let d = 0; d < b.days; d++) {
    const day = new Date(`${todayLocal}T12:00:00Z`);
    day.setUTCDate(day.getUTCDate() + d);
    if (!b.weekdays.includes(day.getUTCDay())) continue;
    const iso = day.toISOString().slice(0, 10);
    for (let m = b.startHour * 60; m + b.slotMinutes <= b.endHour * 60; m += b.slotMinutes) {
      const start = zonedTime(iso, Math.floor(m / 60), m % 60);
      const end = new Date(start.getTime() + b.slotMinutes * 60_000);
      if (start <= new Date()) continue;
      const r = await pool.query('INSERT INTO pickup_slots (starts_at, ends_at, capacity) VALUES ($1,$2,$3) ON CONFLICT (starts_at, ends_at) DO NOTHING', [start, end, b.capacity]);
      created += r.rowCount ?? 0;
    }
  }
  return created;
}

adminRouter.post('/pickup-slots/generate', async (req, res) => {
  const b = slotGenSchema.parse(req.body ?? {});
  if (b.endHour <= b.startHour) throw badRequest('End hour must be after start hour.');
  const created = await generateSlots(b);
  await audit(pool, { actorId: req.user!.id, action: 'slots.generate', entityType: 'pickup_slot', after: { ...b, created }, ip: req.ip });
  res.status(201).json({ created });
});

adminRouter.patch('/pickup-slots/:id', async (req, res) => {
  const b = z.object({ capacity: z.number().int().min(0).max(100).optional(), active: z.boolean().optional() }).parse(req.body);
  const id = idParam(req);
  const cur = await one(pool, 'SELECT * FROM pickup_slots WHERE id = $1', [id]);
  if (!cur) throw notFound();
  if (b.capacity !== undefined && b.capacity < cur.booked_count) throw conflict('CAPACITY_BELOW_BOOKED', `${cur.booked_count} bookings already use this slot.`);
  const s = await one(pool, 'UPDATE pickup_slots SET capacity = COALESCE($2, capacity), active = COALESCE($3, active) WHERE id = $1 RETURNING *', [id, b.capacity ?? null, b.active ?? null]);
  await audit(pool, { actorId: req.user!.id, action: 'slot.update', entityType: 'pickup_slot', entityId: id, before: cur, after: b, ip: req.ip });
  res.json({ slot: { id: s.id, startsAt: s.starts_at, endsAt: s.ends_at, capacity: s.capacity, booked: s.booked_count, active: s.active } });
});

// ===================== Users & roles (ADMIN) =====================
adminRouter.get('/users', async (req, res) => {
  const { page, pageSize, limit, offset } = pagination(req);
  const f = z.object({ role: z.enum(['CUSTOMER', 'RIDER', 'STAFF', 'ADMIN']).optional(), q: z.string().trim().max(80).optional() }).parse(req.query);
  const params: unknown[] = [limit, offset];
  const where: string[] = [];
  if (f.role) { params.push(f.role); where.push(`role = $${params.length}`); }
  if (f.q) { params.push(`%${f.q}%`); where.push(`(full_name ILIKE $${params.length} OR email ILIKE $${params.length} OR phone ILIKE $${params.length})`); }
  const rows = await q(pool, `SELECT *, count(*) OVER()::int AS total FROM users ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT $1 OFFSET $2`, params);
  res.json(paged(rows.map((u) => ({ ...userDto(u), status: u.status })), rows[0]?.total ?? 0, page, pageSize));
});

adminRouter.post('/users', adminOnly, async (req, res) => {
  const b = z.object({ fullName: z.string().trim().min(2).max(100), email: z.string().optional(), phone: z.string().optional(), password: passwordSchema, role: z.enum(['CUSTOMER', 'RIDER', 'STAFF', 'ADMIN']) }).parse(req.body);
  const email = b.email ? normalizeEmail(b.email) : null;
  const phone = b.phone ? normalizePhone(b.phone) : null;
  if ((b.email && !email) || (b.phone && !phone) || (!email && !phone)) throw badRequest('Enter a valid email or phone.');
  const u = await uniqueOr409(async () => one(pool, 'INSERT INTO users (full_name, email, phone, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING *', [b.fullName, email, phone, await hashPassword(b.password), b.role]));
  await audit(pool, { actorId: req.user!.id, action: 'user.create', entityType: 'user', entityId: u.id, after: { role: b.role }, ip: req.ip });
  res.status(201).json({ user: userDto(u) });
});

adminRouter.patch('/users/:id', adminOnly, async (req, res) => {
  const b = z.object({ role: z.enum(['CUSTOMER', 'RIDER', 'STAFF', 'ADMIN']).optional(), status: z.enum(['ACTIVE', 'DISABLED']).optional() }).parse(req.body);
  const id = idParam(req);
  if (id === req.user!.id) throw forbidden('You cannot change your own role or status.');
  const u = await tx(async (c) => {
    const before = await one(c, 'SELECT role, status FROM users WHERE id = $1 FOR UPDATE', [id]);
    if (!before) throw notFound();
    const u = await one(c, 'UPDATE users SET role = COALESCE($2, role), status = COALESCE($3, status), updated_at = now() WHERE id = $1 RETURNING *', [id, b.role ?? null, b.status ?? null]);
    if (b.status === 'DISABLED' || (b.role && b.role !== before.role)) await destroyAllSessionsForUser(c, id); // new permissions take effect immediately
    await audit(c, { actorId: req.user!.id, action: 'user.permissions', entityType: 'user', entityId: id, before, after: b, ip: req.ip });
    return u;
  });
  res.json({ user: { ...userDto(u), status: u.status } });
});

/**
 * Staff-assisted reset for phone-only accounts (no SMS is configured). Procedure: staff verifies identity
 * (in person, or by calling back the registered number and confirming recent order details), then gives the
 * customer this single-use 30-minute link. Every issuance is audited.
 */
adminRouter.post('/users/:id/password-reset-link', adminOnly, async (req, res) => {
  const b = z.object({ verificationNote: z.string().trim().min(10, 'Describe how identity was verified.').max(500) }).parse(req.body);
  const id = idParam(req);
  const u = await one(pool, `SELECT id, role FROM users WHERE id = $1 AND status = 'ACTIVE'`, [id]);
  if (!u) throw notFound();
  if (u.role !== 'CUSTOMER' && u.role !== 'RIDER') throw forbidden('Staff/admin passwords must be reset by the account owner via email.');
  const link = await issueResetToken(id, req.user!.id);
  await audit(pool, { actorId: req.user!.id, action: 'user.assisted_reset_link', entityType: 'user', entityId: id, after: { verificationNote: b.verificationNote }, ip: req.ip });
  res.set('Cache-Control', 'no-store');
  res.status(201).json({ link, expiresInMinutes: 30 });
});

adminRouter.get('/audit-logs', adminOnly, async (req, res) => {
  const { page, pageSize, limit, offset } = pagination(req);
  const rows = await q(pool, `SELECT a.*, u.full_name AS actor_name, count(*) OVER()::int AS total FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id ORDER BY a.id DESC LIMIT $1 OFFSET $2`, [limit, offset]);
  res.json(paged(rows.map((r) => ({ id: r.id, actor: r.actor_name, action: r.action, entityType: r.entity_type, entityId: r.entity_id, before: r.before_data, after: r.after_data, createdAt: r.created_at })), rows[0]?.total ?? 0, page, pageSize));
});

// ===================== Reports =====================
const rangeSchema = z.object({ from: z.iso.date(), to: z.iso.date() });
function range(req: any) {
  const now = new Date();
  const def = { from: new Date(now.getTime() - 30 * 86400_000).toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) };
  return rangeSchema.parse({ ...def, ...req.query });
}

adminRouter.get('/reports/summary', async (req, res) => {
  const r = range(req);
  const s = await one(pool, `
    SELECT count(*)::int AS orders,
           count(*) FILTER (WHERE status = 'DELIVERED')::int AS delivered,
           count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
           count(*) FILTER (WHERE status NOT IN ('DELIVERED','CANCELLED'))::int AS open,
           COALESCE(SUM(COALESCE(final_total, agreed_total)) FILTER (WHERE status <> 'CANCELLED'),0)::int AS order_value
      FROM orders WHERE created_at >= $1::date AND created_at < $2::date + interval '1 day'`, [r.from, r.to]);
  const p = await one(pool, `
    SELECT COALESCE(SUM(amount - refunded_amount) FILTER (WHERE status IN ('SUCCESSFUL','PARTIALLY_REFUNDED','REFUNDED')),0)::int AS collected,
           count(*) FILTER (WHERE status = 'PENDING')::int AS pending_payments
      FROM payments WHERE created_at >= $1::date AND created_at < $2::date + interval '1 day'`, [r.from, r.to]);
  const issues = await one(pool, `SELECT count(*)::int AS n FROM order_issues WHERE status = 'OPEN'`);
  const byStatus = await q(pool, `SELECT status, count(*)::int AS n FROM orders WHERE status NOT IN ('DELIVERED','CANCELLED') GROUP BY status`);
  res.json({ range: r, ...s, ...p, openIssues: issues.n, openByStatus: Object.fromEntries(byStatus.map((x) => [x.status, x.n])) });
});

/** CSV with formula-injection protection for spreadsheet apps. */
export function toCsv(rows: Record<string, unknown>[], cols: string[]) {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

adminRouter.get('/reports/orders.csv', async (req, res) => {
  const r = range(req);
  const rows = await q(pool, `
    SELECT o.reference, o.created_at, o.status, o.payment_status, u.full_name AS customer, b.pickup_address_snapshot->>'serviceAreaName' AS area,
           o.estimated_total, o.agreed_total, o.final_total, b.delivery_preference,
           (SELECT count(*) FROM order_items i WHERE i.order_id = o.id) AS items
      FROM orders o JOIN bookings b ON b.order_id = o.id JOIN users u ON u.id = o.user_id
     WHERE o.created_at >= $1::date AND o.created_at < $2::date + interval '1 day' ORDER BY o.created_at`, [r.from, r.to]);
  res.type('text/csv').attachment(`orders_${r.from}_${r.to}.csv`).send(toCsv(rows, ['reference', 'created_at', 'status', 'payment_status', 'customer', 'area', 'items', 'estimated_total', 'agreed_total', 'final_total', 'delivery_preference']));
});

adminRouter.get('/reports/payments.csv', async (req, res) => {
  const r = range(req);
  const rows = await q(pool, `
    SELECT p.created_at, p.id, o.reference AS order_reference, p.subscription_id, u.full_name AS customer, p.amount, p.refunded_amount, p.method, p.provider,
           p.provider_mode, p.status, p.manual_reference, rb.full_name AS recorded_by
      FROM payments p JOIN users u ON u.id = p.user_id LEFT JOIN orders o ON o.id = p.order_id LEFT JOIN users rb ON rb.id = p.recorded_by
     WHERE p.created_at >= $1::date AND p.created_at < $2::date + interval '1 day' ORDER BY p.created_at`, [r.from, r.to]);
  res.type('text/csv').attachment(`payments_${r.from}_${r.to}.csv`).send(toCsv(rows, ['created_at', 'id', 'order_reference', 'subscription_id', 'customer', 'amount', 'refunded_amount', 'method', 'provider', 'provider_mode', 'status', 'manual_reference', 'recorded_by']));
});
