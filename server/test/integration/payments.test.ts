import { beforeAll, describe, expect, it } from 'vitest';
import { one, pool } from '../../src/db.js';
import { signSimulatorWebhook } from '../../src/providers/payments.js';
import { app, customerWithAddress, makeUser, resetDb } from '../helpers.js';
import request from 'supertest';

let staff: Awaited<ReturnType<typeof makeUser>>;
let admin: Awaited<ReturnType<typeof makeUser>>;
beforeAll(async () => {
  await resetDb();
  staff = await makeUser('STAFF');
  admin = await makeUser('ADMIN');
});

const hook = (body: object, headers?: Record<string, string>) => {
  const raw = JSON.stringify(body);
  return request(app).post('/api/v1/payments/webhooks/simulator').set(headers ?? signSimulatorWebhook(raw)).send(raw);
};

describe('Mobile Money (TEST MODE simulator)', () => {
  it('initiates with a server-computed amount, labelled test mode, never storing the full number', async () => {
    const cu = await customerWithAddress();
    const o = (await cu.book()).body.order;
    const r = await cu.c.post('/api/v1/payments', { orderId: o.id, msisdn: '0788 555 123', amount: 1 }, 'pay-1-abcdef');
    expect(r.status).toBe(201);
    expect(r.body.payment).toMatchObject({ amount: 3600, status: 'PENDING', testMode: true, payerMsisdnMasked: '+25078****123' });
    const row = await one(pool, 'SELECT * FROM payments WHERE id = $1', [r.body.payment.id]);
    expect(JSON.stringify(row)).not.toContain('788555123');
    // A second concurrent payment for the same order is refused
    expect((await cu.c.post('/api/v1/payments', { orderId: o.id, msisdn: '0788555123' }, 'pay-2-abcdef')).status).toBe(409);
  });

  it('processes a duplicated webhook exactly once, verifying with the provider', async () => {
    const cu = await customerWithAddress();
    const o = (await cu.book()).body.order;
    const p = (await cu.c.post('/api/v1/payments', { orderId: o.id, msisdn: '0788555124' }, 'pay-3-abcdef')).body.payment;
    const row = await one(pool, 'SELECT provider_reference FROM payments WHERE id = $1', [p.id]);
    const { paymentProvider } = await import('../../src/providers/payments.js');
    (paymentProvider as any).settle(row.provider_reference, 'SUCCESSFUL'); // provider now says SUCCESSFUL

    const body = { eventId: 'evt_dupe_1', reference: row.provider_reference, status: 'SUCCESSFUL' };
    const [a, b, c] = await Promise.all([hook(body), hook(body), hook(body)]);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect([a, b, c].filter((x) => x.body.duplicate === true)).toHaveLength(2);

    const events = await one(pool, `SELECT count(*)::int AS n FROM payment_events WHERE payment_id = $1 AND to_status = 'SUCCESSFUL' AND from_status = 'PENDING'`, [p.id]);
    expect(events.n).toBe(1);
    const order = (await cu.c.get(`/api/v1/orders/${o.id}`)).body.order;
    expect(order.paymentStatus).toBe('PAID');
    expect(order.status).toBe('PENDING_CONFIRMATION'); // payment never moves order status

    // A late, conflicting webhook cannot flip a terminal payment
    (paymentProvider as any).settle(row.provider_reference, 'FAILED');
    await hook({ eventId: 'evt_late_2', reference: row.provider_reference, status: 'FAILED' });
    expect((await one(pool, 'SELECT status FROM payments WHERE id = $1', [p.id])).status).toBe('SUCCESSFUL');
  });

  it('does not trust the webhook body: a forged "SUCCESSFUL" leaves the payment pending', async () => {
    const cu = await customerWithAddress();
    const o = (await cu.book()).body.order;
    const p = (await cu.c.post('/api/v1/payments', { orderId: o.id, msisdn: '0788555125' }, 'pay-4-abcdef')).body.payment;
    const row = await one(pool, 'SELECT provider_reference FROM payments WHERE id = $1', [p.id]);
    await hook({ eventId: 'evt_forged', reference: row.provider_reference, status: 'SUCCESSFUL' }); // provider still PENDING
    expect((await cu.c.get(`/api/v1/payments/${p.id}`)).body.payment.status).toBe('PENDING');
  });

  it('rejects unsigned / badly signed webhooks', async () => {
    const r = await request(app).post('/api/v1/payments/webhooks/simulator').set('content-type', 'application/json').send('{"eventId":"x","reference":"y"}');
    expect(r.status).toBe(401);
    const raw = JSON.stringify({ eventId: 'x', reference: 'y' });
    expect((await request(app).post('/api/v1/payments/webhooks/simulator').set({ ...signSimulatorWebhook(raw), 'x-ld-signature': '0'.repeat(64) }).send(raw)).status).toBe(401);
  });

  it('keeps unknown provider results pending', async () => {
    const cu = await customerWithAddress();
    const o = (await cu.book()).body.order;
    const p = (await cu.c.post('/api/v1/payments', { orderId: o.id, msisdn: '0788555126' }, 'pay-5-abcdef')).body.payment;
    await pool.query(`UPDATE payments SET provider_reference = 'SIM-lost-after-restart', last_checked_at = NULL WHERE id = $1`, [p.id]);
    expect((await cu.c.get(`/api/v1/payments/${p.id}`)).body.payment.status).toBe('PENDING');
    const ev = await one(pool, `SELECT detail FROM payment_events WHERE payment_id = $1 AND source = 'POLL' ORDER BY created_at DESC LIMIT 1`, [p.id]);
    expect(ev.detail.providerStatus).toBe('UNKNOWN');
  });

  it('handles simulated declines', async () => {
    const cu = await customerWithAddress();
    const o = (await cu.book()).body.order;
    const r = await cu.c.post('/api/v1/payments', { orderId: o.id, msisdn: '0788550000' }, 'pay-6-abcdef');
    expect(r.body.payment.status).toBe('FAILED');
  });
});

describe('manual payments and refunds', () => {
  it('staff record cash; overpayment is refused; refunds are admin-only and audited', async () => {
    const cu = await customerWithAddress();
    const o = (await cu.book()).body.order;
    expect((await staff.c.post(`/api/v1/admin/orders/${o.id}/payments/manual`, { amount: 99999, method: 'CASH' })).status).toBe(422);
    expect((await staff.c.post(`/api/v1/admin/orders/${o.id}/payments/manual`, { amount: 1000, method: 'MANUAL_MOBILE_MONEY' })).status).toBe(400); // reference required
    const part = await staff.c.post(`/api/v1/admin/orders/${o.id}/payments/manual`, { amount: 1600, method: 'CASH' });
    expect(part.body.order.paymentStatus).toBe('PARTIALLY_PAID');
    const full = await staff.c.post(`/api/v1/admin/orders/${o.id}/payments/manual`, { amount: 2000, method: 'MANUAL_MOBILE_MONEY', reference: 'MP123456' });
    expect(full.body.order.paymentStatus).toBe('PAID');
    const pay = full.body.order.payments[0];
    expect((await staff.c.post(`/api/v1/admin/payments/${pay.id}/refunds`, { amount: 500, method: 'CASH', reason: 'Late' })).status).toBe(403);
    const ref = await admin.c.post(`/api/v1/admin/payments/${pay.id}/refunds`, { amount: 500, method: 'CASH', reason: 'Late delivery goodwill' });
    expect(ref.body.payment).toMatchObject({ status: 'PARTIALLY_REFUNDED', refundedAmount: 500 });
    expect((await admin.c.post(`/api/v1/admin/payments/${pay.id}/refunds`, { amount: 5000, method: 'CASH', reason: 'Too much' })).status).toBe(422);
    const a = await one(pool, `SELECT count(*)::int AS n FROM audit_logs WHERE action IN ('payment.manual','payment.refund')`);
    expect(a.n).toBeGreaterThanOrEqual(3);
    expect((await cu.c.get(`/api/v1/orders/${o.id}`)).body.order.paymentStatus).toBe('PARTIALLY_REFUNDED');
  });
});

describe('subscriptions', () => {
  it('activates after payment, covers usage, and never deducts twice', async () => {
    const cu = await customerWithAddress();
    const rider = await makeUser('RIDER');
    const plans = (await cu.c.get('/api/v1/subscription-plans')).body.items;
    const basic = plans.find((p: any) => p.code === 'BASIC_MONTHLY');
    const s = await cu.c.post('/api/v1/subscriptions', { planId: basic.id });
    expect(s.body.subscription.status).toBe('PENDING_PAYMENT');
    expect((await cu.c.post('/api/v1/subscriptions', { planId: basic.id })).status).toBe(409);
    expect((await staff.c.post(`/api/v1/admin/subscriptions/${s.body.subscription.id}/payments/manual`, { amount: 1, method: 'CASH' })).status).toBe(422);
    await staff.c.post(`/api/v1/admin/subscriptions/${s.body.subscription.id}/payments/manual`, { amount: basic.price, method: 'CASH' });
    const cur = (await cu.c.get('/api/v1/subscriptions/current')).body;
    expect(cur.active).toMatchObject({ status: 'ACTIVE', unitsRemaining: 15, tripsRemaining: 2 });

    // 6 kg estimated wash & fold: covered by allowance, fees waived
    const book = await cu.book({ items: [{ name: 'Mixed laundry', categoryId: cu.cat.OTHER_CLOTHES.id, quantity: 6, serviceId: cu.svc.WASH_FOLD.id }] });
    expect(book.body.order.estimatedTotal).toBe(0);
    const id = book.body.order.id;
    await staff.c.post(`/api/v1/admin/orders/${id}/status`, { status: 'CONFIRMED' });
    await staff.c.post(`/api/v1/admin/orders/${id}/status`, { status: 'PICKED_UP', note: 'Customer dropped off' });
    await staff.c.post(`/api/v1/admin/orders/${id}/inspection`, { items: [{ id: book.body.order.items[0].id, measuredWeightKg: 7 }] });
    await staff.c.post(`/api/v1/admin/orders/${id}/status`, { status: 'PROCESSING' });
    // Put on hold and resume back to PROCESSING: allowance must not be deducted again.
    await staff.c.post(`/api/v1/admin/orders/${id}/status`, { status: 'ON_HOLD', note: 'Machine broke' });
    await staff.c.post(`/api/v1/admin/orders/${id}/status`, { status: 'PROCESSING' });
    const usage = await one(pool, 'SELECT count(*)::int AS n, SUM(units_used) AS units FROM subscription_usage WHERE order_id = $1', [id]);
    expect(usage).toEqual({ n: 1, units: 7 });
    const after = (await cu.c.get('/api/v1/subscriptions/current')).body.active;
    expect(after.unitsRemaining).toBe(8);
    expect(after.tripsRemaining).toBe(1);
    void rider;
  });
});
