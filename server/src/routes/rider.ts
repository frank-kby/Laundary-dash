import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../audit.js';
import { one, pool, q, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { idParam } from '../http.js';
import { requireRole } from '../auth/session.js';
import { addOrderEvent, lockOrder, transitionOrder } from '../services/orders.js';

export const riderRouter = Router();
riderRouter.use(requireRole('RIDER'));

/** Only what a rider needs: where, when, who to call, how many items. No prices, payments or emails. */
function taskDto(t: any) {
  const address = t.task_type === 'PICKUP' ? t.pickup_address_snapshot : t.delivery_address_snapshot;
  return {
    id: t.id,
    type: t.task_type,
    status: t.status,
    orderReference: t.reference,
    orderStatus: t.order_status,
    windowStart: t.window_start,
    windowEnd: t.window_end,
    instructions: t.instructions,
    customerName: t.full_name,
    contactPhone: address?.contactPhone || t.phone,
    address: address
      ? { area: address.serviceAreaName, street: address.street, landmark: address.landmark, details: address.details, latitude: address.latitude, longitude: address.longitude }
      : null,
    itemCount: t.item_count,
    customerNotes: t.customer_notes,
    failureReason: t.failure_reason,
    updatedAt: t.updated_at,
  };
}

const TASK_SELECT = `
  SELECT t.*, o.reference, o.status AS order_status, u.full_name, u.phone, b.pickup_address_snapshot, b.delivery_address_snapshot, b.customer_notes,
         (SELECT COALESCE(SUM(COALESCE(i.received_quantity, CASE WHEN i.pricing_unit='ITEM' THEN i.declared_quantity ELSE 1 END)),0)::int
            FROM order_items i WHERE i.order_id = o.id) AS item_count
    FROM rider_tasks t JOIN orders o ON o.id = t.order_id JOIN users u ON u.id = o.user_id JOIN bookings b ON b.order_id = o.id`;

riderRouter.get('/tasks', async (req, res) => {
  const { scope } = z.object({ scope: z.enum(['active', 'done']).default('active') }).parse(req.query);
  const rows = await q(
    pool,
    `${TASK_SELECT} WHERE t.rider_user_id = $1 AND t.status ${scope === 'active' ? `IN ('ASSIGNED','EN_ROUTE')` : `IN ('COMPLETED','FAILED')`}
      ORDER BY ${scope === 'active' ? 't.window_start NULLS LAST, t.created_at' : 't.updated_at DESC'} LIMIT 100`,
    [req.user!.id],
  );
  res.json({ items: rows.map(taskDto) });
});

riderRouter.get('/tasks/:id', async (req, res) => {
  const t = await one(pool, `${TASK_SELECT} WHERE t.id = $1 AND t.rider_user_id = $2`, [idParam(req), req.user!.id]);
  if (!t) throw notFound('Task not found.');
  res.json({ task: taskDto(t) });
});

const eventSchema = z.object({
  type: z.enum(['START', 'COMPLETE', 'FAIL']),
  note: z.string().trim().max(500).default(''),
  failureReason: z.enum(['CUSTOMER_UNREACHABLE', 'CUSTOMER_ABSENT', 'ADDRESS_NOT_FOUND', 'CUSTOMER_REFUSED', 'ITEMS_NOT_READY', 'OTHER']).optional(),
  collectedItemCount: z.number().int().min(0).max(500).optional(), // rider's count at the door; staff do the formal inspection
});

riderRouter.post('/tasks/:id/events', async (req, res) => {
  const b = eventSchema.parse(req.body);
  const id = idParam(req);
  const actor = { id: req.user!.id, role: req.user!.role, ip: req.ip };
  await tx(async (c) => {
    const t = await one(c, 'SELECT * FROM rider_tasks WHERE id = $1 AND rider_user_id = $2 FOR UPDATE', [id, req.user!.id]);
    if (!t) throw notFound('Task not found.');
    if (!['ASSIGNED', 'EN_ROUTE'].includes(t.status)) throw conflict('TASK_CLOSED', 'This task is already closed.');
    let o = await lockOrder(c, t.order_id);

    if (b.type === 'START') {
      if (t.status !== 'ASSIGNED') throw conflict('ALREADY_STARTED', 'Task already started.');
      await c.query(`UPDATE rider_tasks SET status = 'EN_ROUTE', updated_at = now() WHERE id = $1`, [id]);
      if (t.task_type === 'DELIVERY' && o.status === 'READY_FOR_DELIVERY') await transitionOrder(c, o, 'OUT_FOR_DELIVERY', actor, 'Rider on the way');
      else await addOrderEvent(c, { orderId: o.id, type: 'TASK', note: `Rider started ${t.task_type.toLowerCase()}`, actorId: actor.id });
    }

    if (b.type === 'COMPLETE') {
      if (t.task_type === 'PICKUP') {
        if (!['PICKUP_SCHEDULED', 'CONFIRMED'].includes(o.status)) throw conflict('INVALID_STATE', `Order is ${o.status}; pickup cannot be completed.`);
        await transitionOrder(c, o, 'PICKED_UP', actor, b.collectedItemCount !== undefined ? `Rider collected ${b.collectedItemCount} item(s). ${b.note}`.trim() : b.note || 'Collected');
      } else {
        if (o.status === 'READY_FOR_DELIVERY') o = await transitionOrder(c, o, 'OUT_FOR_DELIVERY', actor, 'Rider on the way');
        if (o.status !== 'OUT_FOR_DELIVERY') throw conflict('INVALID_STATE', `Order is ${o.status}; delivery cannot be completed.`);
        await transitionOrder(c, o, 'DELIVERED', actor, b.note || 'Delivered');
      }
      await c.query(`UPDATE rider_tasks SET status = 'COMPLETED', updated_at = now() WHERE id = $1`, [id]);
    }

    if (b.type === 'FAIL') {
      if (!b.failureReason) throw badRequest('Choose why the task failed.');
      await c.query(`UPDATE rider_tasks SET status = 'FAILED', failure_reason = $2, updated_at = now() WHERE id = $1`, [id, b.failureReason]);
      const issueType = t.task_type === 'PICKUP' ? 'FAILED_PICKUP' : 'FAILED_DELIVERY';
      await c.query('INSERT INTO order_issues (order_id, issue_type, description, created_by) VALUES ($1,$2,$3,$4)', [o.id, issueType, `${b.failureReason}${b.note ? ': ' + b.note : ''}`, actor.id]);
      // Return the order to a state where staff can re-assign.
      if (t.task_type === 'PICKUP' && o.status === 'PICKUP_SCHEDULED') await transitionOrder(c, o, 'CONFIRMED', actor, `Pickup attempt failed (${b.failureReason})`);
      else if (t.task_type === 'DELIVERY' && o.status === 'OUT_FOR_DELIVERY') await transitionOrder(c, o, 'READY_FOR_DELIVERY', actor, `Delivery attempt failed (${b.failureReason})`);
      else await addOrderEvent(c, { orderId: o.id, type: 'ISSUE', note: `${issueType}: ${b.failureReason}`, actorId: actor.id });
    }
    await audit(c, { actorId: actor.id, action: `rider_task.${b.type.toLowerCase()}`, entityType: 'rider_task', entityId: id, after: b, ip: req.ip });
  });
  const t = await one(pool, `${TASK_SELECT} WHERE t.id = $1`, [id]);
  res.json({ task: taskDto(t) });
});
