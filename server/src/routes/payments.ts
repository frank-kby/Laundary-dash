import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { one, pool } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { idParam, idempotent, paged, pagination } from '../http.js';
import { normalizePhone } from '../identifiers.js';
import { log, maskPhone } from '../log.js';
import { paymentProvider, SimulatorProvider } from '../providers/payments.js';
import { requireAuth } from '../auth/session.js';
import { orderBalance, paymentDto, paymentHistory, startMobileMoneyPayment, verifyWithProvider } from '../services/payments.js';

export const paymentsRouter = Router();

// ---------- Provider webhook (no session, no CSRF; authenticated by signature/secret) ----------
paymentsRouter.post('/webhooks/:provider', async (req, res) => {
  const provider = String(req.params.provider);
  if (!paymentProvider || provider !== paymentProvider.name) throw notFound('Unknown provider.');
  const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const v = paymentProvider.verifyWebhook({ rawBody, headers: req.headers, query: req.query as any });
  if (!v.ok) {
    log.warn('webhook_rejected', { provider });
    throw new AppError(401, 'INVALID_SIGNATURE', 'Webhook could not be verified.');
  }
  const p = await one(pool, 'SELECT id FROM payments WHERE provider = $1 AND provider_reference = $2', [provider, v.providerReference]);
  if (!p) {
    // Acknowledge so the provider stops retrying; nothing to change.
    log.warn('webhook_unknown_reference', { provider });
    res.status(202).json({ received: true });
    return;
  }
  // The webhook body is NOT trusted for the outcome: re-check with the provider, apply once.
  const r = await verifyWithProvider(p.id, 'WEBHOOK', v.eventId);
  res.status(200).json({ received: true, duplicate: r?.duplicate ?? false });
});

paymentsRouter.use(requireAuth);

const initiateSchema = z
  .object({
    orderId: z.uuid().optional(),
    subscriptionId: z.uuid().optional(),
    msisdn: z.string().trim().max(20),
  })
  .refine((b) => !!b.orderId !== !!b.subscriptionId, 'Provide exactly one of orderId or subscriptionId.');

/** Starts a Mobile Money request-to-pay. The amount is always computed server-side. */
paymentsRouter.post('/', async (req, res) => {
  await idempotent(req, res, 'POST /payments', async () => {
    const b = initiateSchema.parse(req.body);
    const msisdn = normalizePhone(b.msisdn);
    if (!msisdn) throw badRequest('Enter the Mobile Money number, e.g. 078 123 4567.');
    let amount: number;
    let note: string;
    if (b.orderId) {
      const o = await one(pool, 'SELECT * FROM orders WHERE id = $1 AND user_id = $2', [b.orderId, req.user!.id]);
      if (!o) throw notFound('Order not found.');
      if (o.status === 'CANCELLED') throw conflict('ORDER_CANCELLED', 'This order was cancelled.');
      if (o.status === 'AWAITING_APPROVAL') throw conflict('PRICE_PENDING', 'Please approve or reject the price change first.');
      const bal = await orderBalance(pool, o.id);
      amount = bal.balance;
      note = `Laundry Dash ${o.reference}`;
    } else {
      const s = await one(pool, `SELECT * FROM subscriptions WHERE id = $1 AND user_id = $2 AND status = 'PENDING_PAYMENT'`, [b.subscriptionId, req.user!.id]);
      if (!s) throw notFound('Subscription awaiting payment not found.');
      const paid = await one(pool, `SELECT 1 FROM payments WHERE subscription_id = $1 AND status IN ('PENDING','SUCCESSFUL')`, [s.id]);
      if (paid) throw conflict('PAYMENT_ALREADY_PENDING', 'A payment for this subscription is already in progress.');
      amount = s.plan_snapshot.price;
      note = `Laundry Dash plan ${s.plan_snapshot.code}`;
    }
    if (amount <= 0) throw conflict('NOTHING_TO_PAY', 'There is nothing left to pay.');
    const p = await startMobileMoneyPayment({
      userId: req.user!.id, orderId: b.orderId ?? null, subscriptionId: b.subscriptionId ?? null, amount, msisdn, msisdnMasked: maskPhone(msisdn)!, note,
    });
    return { status: 201, body: { payment: paymentDto(p), message: p.status === 'PENDING' ? 'Check your phone and approve the payment prompt with your PIN.' : 'The payment could not be started.' } };
  });
});

paymentsRouter.get('/', async (req, res) => {
  const { page, pageSize, limit, offset } = pagination(req);
  const rows = await paymentHistory(pool, req.user!.id, limit, offset);
  const total = await one(pool, 'SELECT count(*)::int AS n FROM payments WHERE user_id = $1', [req.user!.id]);
  res.json(paged(rows.map(paymentDto), total.n, page, pageSize));
});

paymentsRouter.get('/:id', async (req, res) => {
  const id = idParam(req);
  let p = await one(pool, 'SELECT * FROM payments WHERE id = $1 AND user_id = $2', [id, req.user!.id]);
  if (!p) throw notFound('Payment not found.');
  // Pending provider payments are re-checked server-side, throttled to once per 15s.
  if (p.status === 'PENDING' && p.provider && (!p.last_checked_at || Date.now() - new Date(p.last_checked_at).getTime() > 15_000)) {
    await verifyWithProvider(p.id, 'POLL', null);
    p = await one(pool, 'SELECT * FROM payments WHERE id = $1', [id]);
  }
  res.json({ payment: paymentDto(p) });
});

/** TEST MODE only: lets a tester decide what the simulated phone prompt does. */
paymentsRouter.post('/:id/simulate', async (req, res) => {
  if (!(paymentProvider instanceof SimulatorProvider) || config.NODE_ENV === 'production' && process.env.ALLOW_SIMULATOR_IN_PRODUCTION !== 'true') {
    throw forbidden('Simulation is only available in TEST MODE.');
  }
  const { outcome } = z.object({ outcome: z.enum(['SUCCESSFUL', 'FAILED']) }).parse(req.body);
  const p = await one(pool, 'SELECT * FROM payments WHERE id = $1', [idParam(req)]);
  const isStaff = ['STAFF', 'ADMIN'].includes(req.user!.role);
  if (!p || (p.user_id !== req.user!.id && !isStaff)) throw notFound('Payment not found.');
  if (p.provider !== 'simulator' || p.status !== 'PENDING') throw conflict('NOT_PENDING', 'Only pending TEST MODE payments can be simulated.');
  const hook = paymentProvider.settle(p.provider_reference, outcome);
  if (!hook) throw conflict('UNKNOWN_TO_SIMULATOR', 'The simulator no longer knows this payment (server restarted). It stays pending; staff can resolve it manually.');
  // Deliver through the same verification path as a real webhook.
  const v = paymentProvider.verifyWebhook({ rawBody: Buffer.from(hook.body), headers: hook.headers, query: {} });
  if (v.ok) await verifyWithProvider(p.id, 'WEBHOOK', v.eventId);
  const updated = await one(pool, 'SELECT * FROM payments WHERE id = $1', [p.id]);
  res.json({ payment: paymentDto(updated) });
});
