import { Router } from 'express';
import { z } from 'zod';
import { one, pool, tx } from '../db.js';
import { notFound } from '../errors.js';
import { idParam } from '../http.js';
import { requireAuth } from '../auth/session.js';
import { decideRevision, lockOrder } from '../services/orders.js';
import { orderDetail } from '../services/orderView.js';

export const ordersRouter = Router();
ordersRouter.use(requireAuth);

async function assertOwner(orderId: string, userId: string) {
  const o = await one(pool, 'SELECT id FROM orders WHERE id = $1 AND user_id = $2', [orderId, userId]);
  if (!o) throw notFound('Order not found.'); // 404, not 403: don't confirm other customers' orders exist
}

ordersRouter.get('/:id', async (req, res) => {
  const id = idParam(req);
  await assertOwner(id, req.user!.id);
  res.json({ order: await orderDetail(pool, id, 'customer') });
});

ordersRouter.get('/:id/events', async (req, res) => {
  const id = idParam(req);
  await assertOwner(id, req.user!.id);
  const d = await orderDetail(pool, id, 'customer');
  res.json({ items: d!.events });
});

const approvalSchema = z.object({ revisionId: z.uuid(), decision: z.enum(['APPROVE', 'REJECT']), note: z.string().trim().max(300).default('') });

ordersRouter.post('/:id/price-approval', async (req, res) => {
  const id = idParam(req);
  const b = approvalSchema.parse(req.body);
  await tx(async (c) => {
    const o = await lockOrder(c, id);
    if (o.user_id !== req.user!.id) throw notFound('Order not found.');
    await decideRevision(c, o, b.revisionId, b.decision, { id: req.user!.id, role: req.user!.role, ip: req.ip }, 'APP', b.note);
  });
  res.json({ order: await orderDetail(pool, id, 'customer') });
});
