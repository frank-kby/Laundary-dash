import { beforeAll, describe, expect, it } from 'vitest';
import { customerWithAddress, makeUser, resetDb } from '../helpers.js';

let customer: Awaited<ReturnType<typeof customerWithAddress>>;
let rider: Awaited<ReturnType<typeof makeUser>>;
let rider2: Awaited<ReturnType<typeof makeUser>>;
let staff: Awaited<ReturnType<typeof makeUser>>;
let admin: Awaited<ReturnType<typeof makeUser>>;
let orderId: string;

beforeAll(async () => {
  await resetDb();
  customer = await customerWithAddress();
  rider = await makeUser('RIDER');
  rider2 = await makeUser('RIDER');
  staff = await makeUser('STAFF');
  admin = await makeUser('ADMIN');
  orderId = (await customer.book()).body.order.id;
});

describe('role permissions', () => {
  it('blocks unauthenticated access', async () => {
    const { client } = await import('../helpers.js');
    expect((await client().get('/api/v1/me')).status).toBe(401);
    expect((await client().get('/api/v1/admin/orders')).status).toBe(401);
  });

  it('customers cannot use staff or rider endpoints', async () => {
    expect((await customer.c.get('/api/v1/admin/orders')).status).toBe(403);
    expect((await customer.c.post(`/api/v1/admin/orders/${orderId}/status`, { status: 'CONFIRMED' })).status).toBe(403);
    expect((await customer.c.get('/api/v1/rider/tasks')).status).toBe(403);
  });

  it('riders cannot change prices, payments, statuses or roles', async () => {
    expect((await rider.c.post(`/api/v1/admin/orders/${orderId}/status`, { status: 'CONFIRMED' })).status).toBe(403);
    expect((await rider.c.post(`/api/v1/admin/orders/${orderId}/price-revisions`, { adjustments: [{ description: 'x', amount: 1 }], reason: 'x' })).status).toBe(403);
    expect((await rider.c.post(`/api/v1/admin/orders/${orderId}/payments/manual`, { amount: 100, method: 'CASH' })).status).toBe(403);
    expect((await rider.c.patch(`/api/v1/admin/users/${rider.user.id}`, { role: 'ADMIN' })).status).toBe(403);
    expect((await rider.c.put(`/api/v1/admin/services/${customer.svc.WASH_IRON.id}`, {})).status).toBe(403);
  });

  it('riders only see their own tasks, with no financial data', async () => {
    await staff.c.post(`/api/v1/admin/orders/${orderId}/status`, { status: 'CONFIRMED' });
    await staff.c.post(`/api/v1/admin/orders/${orderId}/rider-tasks`, { type: 'PICKUP', riderId: rider.user.id });
    const mine = (await rider.c.get('/api/v1/rider/tasks')).body.items;
    expect(mine).toHaveLength(1);
    const json = JSON.stringify(mine[0]);
    for (const k of ['total', 'price', 'payment', 'email']) expect(json.toLowerCase()).not.toContain(`"${k}`);
    expect((await rider2.c.get('/api/v1/rider/tasks')).body.items).toHaveLength(0);
    expect((await rider2.c.get(`/api/v1/rider/tasks/${mine[0].id}`)).status).toBe(404);
    expect((await rider2.c.post(`/api/v1/rider/tasks/${mine[0].id}/events`, { type: 'START' })).status).toBe(404);
  });

  it('staff run operations but cannot change configuration, roles or refunds', async () => {
    expect((await staff.c.get('/api/v1/admin/orders')).status).toBe(200);
    expect((await staff.c.get('/api/v1/admin/reports/orders.csv')).headers['content-type']).toContain('text/csv');
    expect((await staff.c.patch(`/api/v1/admin/users/${rider.user.id}`, { role: 'STAFF' })).status).toBe(403);
    expect((await staff.c.post('/api/v1/admin/service-areas', { code: 'X1', name: 'X', district: 'Gasabo', pickupFee: 1, deliveryFee: 1 })).status).toBe(403);
    expect((await staff.c.get('/api/v1/admin/audit-logs')).status).toBe(403);
  });

  it('admins change roles; the change takes effect immediately and is audited', async () => {
    const target = await makeUser('CUSTOMER');
    expect((await target.c.get('/api/v1/me')).status).toBe(200);
    const r = await admin.c.patch(`/api/v1/admin/users/${target.user.id}`, { role: 'RIDER' });
    expect(r.body.user.role).toBe('RIDER');
    expect((await target.c.get('/api/v1/me')).status).toBe(401); // sessions revoked
    expect((await admin.c.patch(`/api/v1/admin/users/${admin.user.id}`, { role: 'CUSTOMER' })).status).toBe(403);
    const logs = (await admin.c.get('/api/v1/admin/audit-logs')).body.items;
    expect(logs.some((l: any) => l.action === 'user.permissions' && l.entityId === target.user.id)).toBe(true);
  });

  it('admin price changes do not alter existing orders', async () => {
    const before = (await customer.c.get(`/api/v1/orders/${orderId}`)).body.order.items[0].unitPrice;
    const svc = (await admin.c.get('/api/v1/admin/services')).body.items.find((s: any) => s.code === 'WASH_IRON');
    const r = await admin.c.put(`/api/v1/admin/services/${svc.id}`, { ...svc, unitPrice: 1200 });
    expect(r.status).toBe(200);
    expect((await customer.c.get(`/api/v1/orders/${orderId}`)).body.order.items[0].unitPrice).toBe(before);
  });
});
