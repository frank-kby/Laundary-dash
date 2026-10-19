import crypto from 'node:crypto';
import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { one, pool, q, tx, type Db } from '../db.js';
import { badRequest, conflict, notFound, unprocessable } from '../errors.js';
import { idParam, idempotent, paged, pagination } from '../http.js';
import { normalizePhone } from '../identifiers.js';
import { CUSTOMER_CANCELLABLE } from '../domain/orderStatus.js';
import { priceOrder, type PriceLineInput } from '../domain/pricing.js';
import { requireAuth } from '../auth/session.js';
import { addOrderEvent, getSubscriptionTerms, lockOrder, transitionOrder } from '../services/orders.js';
import { notify } from '../services/notify.js';
import { orderDetail, orderSummaryDto } from '../services/orderView.js';
import { SLOT_CUTOFF_MINUTES } from './catalog.js';

const itemSchema = z
  .object({
    wardrobeItemId: z.uuid().optional(),
    name: z.string().trim().max(80).optional(),
    categoryId: z.uuid().optional(),
    color: z.string().trim().max(40).optional(),
    careNotes: z.string().trim().max(300).optional(),
    quantity: z.number().positive().max(100),
    serviceId: z.uuid(),
    saveToWardrobe: z.boolean().default(false),
  })
  .refine((i) => i.wardrobeItemId || (i.name && i.categoryId), { message: 'Choose a wardrobe item or describe the garment and pick a category.' });

const inlineAddress = z.object({
  label: z.string().trim().min(1).max(40).default('Home'),
  serviceAreaId: z.uuid(),
  street: z.string().trim().max(120).default(''),
  landmark: z.string().trim().min(2, 'Add a landmark so our rider can find you.').max(160),
  details: z.string().trim().max(300).default(''),
  contactPhone: z.string().trim().max(20).nullable().optional(),
});

export const bookingSchema = z.object({
  items: z.array(itemSchema).min(1, 'Add at least one item.').max(50),
  pickupAddressId: z.uuid().optional(),
  pickupAddress: inlineAddress.optional(),
  pickupSlotId: z.uuid(),
  deliveryPreference: z.enum(['DELIVER_TO_ADDRESS', 'COLLECT_AT_SHOP']),
  deliveryAddressId: z.uuid().optional(), // omitted + DELIVER_TO_ADDRESS => same as pickup
  notes: z.string().trim().max(500).default(''),
});
type BookingInput = z.infer<typeof bookingSchema>;

const quoteSchema = bookingSchema.extend({ pickupSlotId: z.uuid().optional() });

async function loadAddress(db: Db, userId: string, id: string) {
  const a = await one(
    db,
    `SELECT a.*, s.name AS area_name, s.pickup_fee, s.delivery_fee, s.active AS area_active
       FROM addresses a JOIN service_areas s ON s.id = a.service_area_id WHERE a.id = $1 AND a.user_id = $2 AND a.deleted_at IS NULL`,
    [id, userId],
  );
  if (!a) throw badRequest('Address not found.');
  if (!a.area_active) throw unprocessable('AREA_NOT_SERVED', 'We no longer serve that area.');
  return a;
}
const addressSnapshot = (a: any) => ({
  label: a.label, serviceAreaId: a.service_area_id, serviceAreaName: a.area_name, street: a.street, landmark: a.landmark,
  details: a.details, contactPhone: a.contact_phone, latitude: a.latitude, longitude: a.longitude,
});

/**
 * Builds everything about a booking from server-side data only: item snapshots, prices, fees, subscription
 * coverage. Shared by /quote and /bookings so the confirmed price equals the quoted price.
 */
async function buildDraft(db: Db, userId: string, b: Omit<BookingInput, 'pickupSlotId'>, persist: pg.PoolClient | null) {
  // Addresses
  let pickup: any;
  if (b.pickupAddressId) pickup = await loadAddress(db, userId, b.pickupAddressId);
  else if (b.pickupAddress) {
    const area = await one(db, 'SELECT * FROM service_areas WHERE id = $1 AND active', [b.pickupAddress.serviceAreaId]);
    if (!area) throw badRequest('Please choose an area we serve.');
    const contact = b.pickupAddress.contactPhone ? normalizePhone(b.pickupAddress.contactPhone) : null;
    if (b.pickupAddress.contactPhone && !contact) throw badRequest('Contact phone is not valid.');
    pickup = { ...b.pickupAddress, id: null, service_area_id: area.id, area_name: area.name, pickup_fee: area.pickup_fee, delivery_fee: area.delivery_fee, contact_phone: contact, latitude: null, longitude: null };
    if (persist) {
      const saved = await one(persist, `INSERT INTO addresses (user_id, label, service_area_id, street, landmark, details, contact_phone) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [
        userId, pickup.label, area.id, pickup.street, pickup.landmark, pickup.details, contact,
      ]);
      pickup.id = saved.id;
    }
  } else throw badRequest('Choose a pickup address.');

  let delivery: any = null;
  if (b.deliveryPreference === 'DELIVER_TO_ADDRESS') delivery = b.deliveryAddressId ? await loadAddress(db, userId, b.deliveryAddressId) : pickup;

  // Items
  const serviceIds = [...new Set(b.items.map((i) => i.serviceId))];
  const services = new Map((await q(db, 'SELECT * FROM services WHERE id = ANY($1) AND active', [serviceIds])).map((s) => [s.id, s]));
  const overrides = await q(db, 'SELECT * FROM service_category_prices WHERE service_id = ANY($1)', [serviceIds]);
  const wardrobeIds = b.items.map((i) => i.wardrobeItemId).filter(Boolean);
  const wardrobe = new Map(
    (await q(db, `SELECT w.*, c.code AS category_code, c.name_en AS category_name FROM wardrobe_items w JOIN garment_categories c ON c.id = w.category_id
                   WHERE w.id = ANY($1) AND w.user_id = $2 AND w.deleted_at IS NULL`, [wardrobeIds, userId])).map((w) => [w.id, w]),
  );
  const catIds = b.items.map((i) => i.categoryId).filter(Boolean);
  const cats = new Map((await q(db, 'SELECT * FROM garment_categories WHERE id = ANY($1) AND active', [catIds])).map((c) => [c.id, c]));

  const snapshots: any[] = [];
  const lines: PriceLineInput[] = [];
  for (const [idx, it] of b.items.entries()) {
    const svc = services.get(it.serviceId);
    if (!svc) throw badRequest(`Item ${idx + 1}: choose an available service.`);
    let snap: any;
    if (it.wardrobeItemId) {
      const w = wardrobe.get(it.wardrobeItemId);
      if (!w) throw badRequest(`Item ${idx + 1}: wardrobe item not found.`);
      snap = { wardrobeItemId: w.id, name: w.name, kind: w.kind, categoryId: w.category_id, categoryCode: w.category_code, categoryName: w.category_name, color: w.color, careNotes: it.careNotes ?? w.care_notes, photoKey: w.photo_key };
    } else {
      const c = cats.get(it.categoryId!);
      if (!c) throw badRequest(`Item ${idx + 1}: choose a category.`);
      snap = { wardrobeItemId: null, name: it.name!, kind: c.kind, categoryId: c.id, categoryCode: c.code, categoryName: c.name_en, color: it.color ?? '', careNotes: it.careNotes ?? '', photoKey: null };
    }
    if (snap.kind !== svc.kind) throw badRequest(`Item ${idx + 1}: "${svc.name_en}" is not available for ${snap.kind.toLowerCase()}.`);
    const qty = it.quantity;
    if (svc.pricing_unit === 'ITEM' && !Number.isInteger(qty)) throw badRequest(`Item ${idx + 1}: quantity must be a whole number.`);
    if (svc.pricing_unit === 'KG' && (qty < 0.5 || qty > 50)) throw badRequest(`Item ${idx + 1}: estimated weight must be between 0.5 and 50 kg.`);
    const override = overrides.find((o) => o.service_id === svc.id && o.category_id === snap.categoryId);
    const unitPrice = override?.unit_price ?? svc.unit_price;
    const ref = crypto.randomUUID();
    snapshots.push({ ...snap, ref, service: svc, unitPrice, quantity: qty, saveToWardrobe: it.saveToWardrobe && !it.wardrobeItemId });
    lines.push({ ref, label: snap.name, serviceId: svc.id, serviceName: svc.name_en, pricingUnit: svc.pricing_unit, unitPrice, minCharge: svc.min_charge, quantity: qty });
  }

  const subscription = await getSubscriptionTerms(db, { userId });
  const pricing = priceOrder({
    lines,
    pickupFee: pickup.pickup_fee,
    deliveryFee: delivery ? delivery.delivery_fee : 0,
    subscription,
  });
  return { pickup, delivery, snapshots, pricing, subscription };
}

const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function makeReference() {
  const d = new Date();
  const ymd = `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const r = crypto.randomBytes(5);
  let s = '';
  for (let i = 0; i < 5; i++) s += REF_ALPHABET[r[i] % 32];
  return `LD-${ymd}-${s}`;
}

/** Atomically takes one place in a slot; the WHERE clause + CHECK constraint make overbooking impossible. */
async function reserveSlot(c: pg.PoolClient, slotId: string) {
  const s = await one(
    c,
    `UPDATE pickup_slots SET booked_count = booked_count + 1
      WHERE id = $1 AND active AND booked_count < capacity AND starts_at > now() + ($2 || ' minutes')::interval
      RETURNING *`,
    [slotId, String(SLOT_CUTOFF_MINUTES)],
  );
  if (!s) throw conflict('SLOT_UNAVAILABLE', 'That pickup time is no longer available. Please choose another.');
  return s;
}

export const bookingsRouter = Router();
bookingsRouter.use(requireAuth);

bookingsRouter.post('/quote', async (req, res) => {
  const b = quoteSchema.parse(req.body);
  const d = await buildDraft(pool, req.user!.id, b, null);
  res.json({
    pricing: d.pricing,
    subscriptionApplied: !!d.pricing.subscriptionId,
    note: 'Estimate. Final price is confirmed after we count/weigh your items; any increase needs your approval first.',
  });
});

bookingsRouter.post('/', async (req, res) => {
  await idempotent(req, res, 'POST /bookings', async () => {
    const b = bookingSchema.parse(req.body);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const orderId = await tx(async (c) => {
          const slot = await reserveSlot(c, b.pickupSlotId);
          const d = await buildDraft(c, req.user!.id, b, c);
          const order = await one(
            c,
            `INSERT INTO orders (reference, user_id, status, subscription_id, pricing_snapshot, estimated_total, agreed_total)
             VALUES ($1,$2,'PENDING_CONFIRMATION',$3,$4,$5,$5) RETURNING *`,
            [makeReference(), req.user!.id, d.subscription?.subscriptionId ?? null, JSON.stringify(d.pricing), d.pricing.total],
          );
          await c.query(
            `INSERT INTO bookings (order_id, user_id, pickup_slot_id, pickup_address_id, pickup_address_snapshot, delivery_preference, delivery_address_id, delivery_address_snapshot, customer_notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [order.id, req.user!.id, slot.id, d.pickup.id, JSON.stringify(addressSnapshot(d.pickup)), b.deliveryPreference, d.delivery?.id ?? null,
             d.delivery ? JSON.stringify(addressSnapshot(d.delivery)) : null, b.notes],
          );
          for (const s of d.snapshots) {
            let wardrobeId = s.wardrobeItemId;
            if (s.saveToWardrobe) {
              const w = await one(c, `INSERT INTO wardrobe_items (user_id, kind, category_id, name, color, quantity, care_notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [
                req.user!.id, s.kind, s.categoryId, s.name, s.color, s.service.pricing_unit === 'ITEM' ? s.quantity : 1, s.careNotes,
              ]);
              wardrobeId = w.id;
            }
            await c.query(
              `INSERT INTO order_items (id, order_id, wardrobe_item_id, name, kind, category_code, category_name, color, care_notes, photo_key,
                                        service_id, service_code, service_name, pricing_unit, unit_price, min_charge, declared_quantity)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
              [s.ref, order.id, wardrobeId, s.name, s.kind, s.categoryCode, s.categoryName, s.color, s.careNotes, s.photoKey,
               s.service.id, s.service.code, s.service.name_en, s.service.pricing_unit, s.unitPrice, s.service.min_charge, s.quantity],
            );
          }
          // Item refs in the stored pricing snapshot now point at real order_item ids.
          await addOrderEvent(c, { orderId: order.id, type: 'STATUS_CHANGE', to: 'PENDING_CONFIRMATION', note: 'Booking received', actorId: req.user!.id });
          await notify(c, req.user!.id, { type: 'ORDER_STATUS', orderId: order.id, title: `Order ${order.reference}`, body: 'Booking received — we will confirm shortly.' });
          return order.id;
        });
        return { status: 201, body: { order: await orderDetail(pool, orderId, 'customer') } };
      } catch (e: any) {
        if (e?.code === '23505' && String(e?.constraint).includes('reference') && attempt < 2) continue;
        throw e;
      }
    }
    throw new Error('unreachable');
  });
});

const listSchema = z.object({ scope: z.enum(['active', 'past', 'all']).default('all') });

bookingsRouter.get('/', async (req, res) => {
  const { page, pageSize, limit, offset } = pagination(req);
  const { scope } = listSchema.parse(req.query);
  const scopeSql =
    scope === 'active' ? `AND o.status NOT IN ('DELIVERED','CANCELLED')` : scope === 'past' ? `AND o.status IN ('DELIVERED','CANCELLED')` : '';
  const rows = await q(
    pool,
    `SELECT o.*, b.id AS booking_id, ps.starts_at AS slot_start, ps.ends_at AS slot_end,
            (SELECT count(*)::int FROM order_items i WHERE i.order_id = o.id) AS item_count, count(*) OVER()::int AS total
       FROM orders o JOIN bookings b ON b.order_id = o.id JOIN pickup_slots ps ON ps.id = b.pickup_slot_id
      WHERE o.user_id = $1 ${scopeSql} ORDER BY o.created_at DESC LIMIT $2 OFFSET $3`,
    [req.user!.id, limit, offset],
  );
  res.json(paged(rows.map(orderSummaryDto), rows[0]?.total ?? 0, page, pageSize));
});

async function ownBooking(db: Db, bookingId: string, userId: string) {
  const b = await one(db, 'SELECT * FROM bookings WHERE id = $1 AND user_id = $2', [bookingId, userId]);
  if (!b) throw notFound('Booking not found.');
  return b;
}

bookingsRouter.get('/:id', async (req, res) => {
  const b = await ownBooking(pool, idParam(req), req.user!.id);
  res.json({ order: await orderDetail(pool, b.order_id, 'customer') });
});

bookingsRouter.post('/:id/cancel', async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().max(300).default('') }).parse(req.body ?? {});
  const bookingId = idParam(req);
  const orderId = await tx(async (c) => {
    const b = await ownBooking(c, bookingId, req.user!.id);
    const o = await lockOrder(c, b.order_id);
    if (!CUSTOMER_CANCELLABLE.includes(o.status)) {
      throw conflict('CANNOT_CANCEL', 'This order can no longer be cancelled in the app because your items have been collected. Please contact us.');
    }
    await transitionOrder(c, o, 'CANCELLED', { id: req.user!.id, role: req.user!.role, ip: req.ip }, reason || 'Cancelled by customer');
    return o.id;
  });
  res.json({ order: await orderDetail(pool, orderId, 'customer') });
});

bookingsRouter.post('/:id/reschedule', async (req, res) => {
  const { pickupSlotId } = z.object({ pickupSlotId: z.uuid() }).parse(req.body);
  const bookingId = idParam(req);
  const orderId = await tx(async (c) => {
    const b = await ownBooking(c, bookingId, req.user!.id);
    const o = await lockOrder(c, b.order_id);
    if (!CUSTOMER_CANCELLABLE.includes(o.status)) throw conflict('CANNOT_RESCHEDULE', 'This pickup can no longer be rescheduled in the app.');
    if (b.reschedule_count >= 3) throw conflict('RESCHEDULE_LIMIT', 'You have rescheduled this booking 3 times. Please contact us.');
    if (b.pickup_slot_id === pickupSlotId) throw badRequest('That is already your pickup time.');
    const slot = await reserveSlot(c, pickupSlotId);
    await c.query('UPDATE pickup_slots SET booked_count = booked_count - 1 WHERE id = $1 AND booked_count > 0', [b.pickup_slot_id]);
    await c.query('UPDATE bookings SET pickup_slot_id = $2, reschedule_count = reschedule_count + 1 WHERE id = $1', [b.id, slot.id]);
    const actor = { id: req.user!.id, role: req.user!.role, ip: req.ip };
    // A rider already assigned to the old time must be re-assigned by staff.
    const cancelled = await c.query(`UPDATE rider_tasks SET status = 'CANCELLED', updated_at = now() WHERE order_id = $1 AND task_type = 'PICKUP' AND status IN ('ASSIGNED','EN_ROUTE')`, [o.id]);
    if (o.status === 'PICKUP_SCHEDULED') await transitionOrder(c, o, 'CONFIRMED', actor, 'Pickup rescheduled by customer');
    await addOrderEvent(c, { orderId: o.id, type: 'RESCHEDULE', note: `Pickup moved to ${new Date(slot.starts_at).toISOString()}${cancelled.rowCount ? ' (rider re-assignment needed)' : ''}`, actorId: req.user!.id });
    await audit(c, { actorId: req.user!.id, action: 'booking.reschedule', entityType: 'booking', entityId: b.id, before: { slot: b.pickup_slot_id }, after: { slot: slot.id }, ip: req.ip });
    return o.id;
  });
  res.json({ order: await orderDetail(pool, orderId, 'customer') });
});
