import { beforeAll, describe, expect, it } from 'vitest';
import { one, pool } from '../../src/db.js';
import { customerWithAddress, makeUser, resetDb } from '../helpers.js';

let staff: Awaited<ReturnType<typeof makeUser>>;
let rider: Awaited<ReturnType<typeof makeUser>>;
beforeAll(async () => {
  await resetDb();
  staff = await makeUser('STAFF');
  rider = await makeUser('RIDER');
});

async function toReceived(cu: Awaited<ReturnType<typeof customerWithAddress>>, items?: any[]) {
  const r = await cu.book(items ? { items } : {});
  const id = r.body.order.id;
  expect((await staff.c.post(`/api/v1/admin/orders/${id}/status`, { status: 'CONFIRMED' })).status).toBe(200);
  const t = await staff.c.post(`/api/v1/admin/orders/${id}/rider-tasks`, { type: 'PICKUP', riderId: rider.user.id });
  expect(t.status).toBe(201);
  expect(t.body.order.status).toBe('PICKUP_SCHEDULED');
  const tasks = await rider.c.get('/api/v1/rider/tasks');
  const task = tasks.body.items.find((x: any) => x.orderReference === r.body.order.reference);
  expect(task).toBeTruthy();
  expect(task).not.toHaveProperty('total');
  expect((await rider.c.post(`/api/v1/rider/tasks/${task.id}/events`, { type: 'START' })).status).toBe(200);
  expect((await rider.c.post(`/api/v1/rider/tasks/${task.id}/events`, { type: 'COMPLETE', collectedItemCount: 3 })).status).toBe(200);
  return { id, order: r.body.order };
}

describe('customer booking through delivery (API)', () => {
  it('inspection increase requires approval; processing is blocked until approved', async () => {
    const cu = await customerWithAddress();
    const { id, order } = await toReceived(cu);
    expect(order.estimatedTotal).toBe(3600); // 2 x 800 + 2000 fees

    // Staff counts 3 shirts (not 2) and adds stain removal.
    const insp = await staff.c.post(`/api/v1/admin/orders/${id}/inspection`, {
      items: [{ id: order.items[0].id, receivedQuantity: 3, conditionNotes: 'Ink stain on cuff' }],
      adjustments: [{ description: 'Stain removal', amount: 1000 }],
      reason: '3 shirts received, stain treatment needed',
    });
    expect(insp.status).toBe(200);
    expect(insp.body.requiresApproval).toBe(true);
    expect(insp.body.order.status).toBe('AWAITING_APPROVAL');

    // Work cannot proceed.
    const blocked = await staff.c.post(`/api/v1/admin/orders/${id}/status`, { status: 'PROCESSING' });
    expect(blocked.status).toBe(409);

    const view = await cu.c.get(`/api/v1/orders/${id}`);
    expect(view.body.order.pendingRevision.proposedTotal).toBe(5400);
    // Customers don't see staff-only fields
    expect(view.body.order.customer).toBeUndefined();

    const ok = await cu.c.post(`/api/v1/orders/${id}/price-approval`, { revisionId: view.body.order.pendingRevision.id, decision: 'APPROVE' });
    expect(ok.status).toBe(200);
    expect(ok.body.order.status).toBe('RECEIVED');
    expect(ok.body.order.agreedTotal).toBe(5400);
    // cannot decide twice
    expect((await cu.c.post(`/api/v1/orders/${id}/price-approval`, { revisionId: view.body.order.pendingRevision.id, decision: 'REJECT' })).status).toBe(409);

    expect((await staff.c.post(`/api/v1/admin/orders/${id}/status`, { status: 'PROCESSING' })).body.order.finalTotal).toBe(5400);
    expect((await staff.c.post(`/api/v1/admin/orders/${id}/status`, { status: 'READY_FOR_DELIVERY' })).status).toBe(200);
    // Address delivery must go through a rider
    expect((await staff.c.post(`/api/v1/admin/orders/${id}/status`, { status: 'DELIVERED' })).status).toBe(422);
    await staff.c.post(`/api/v1/admin/orders/${id}/rider-tasks`, { type: 'DELIVERY', riderId: rider.user.id });
    const dt = (await rider.c.get('/api/v1/rider/tasks')).body.items.find((x: any) => x.type === 'DELIVERY' && x.orderReference === order.reference);
    await rider.c.post(`/api/v1/rider/tasks/${dt.id}/events`, { type: 'START' });
    expect((await cu.c.get(`/api/v1/orders/${id}`)).body.order.status).toBe('OUT_FOR_DELIVERY');
    await rider.c.post(`/api/v1/rider/tasks/${dt.id}/events`, { type: 'COMPLETE' });
    const done = await cu.c.get(`/api/v1/orders/${id}`);
    expect(done.body.order.status).toBe('DELIVERED');
    expect(done.body.order.paymentStatus).toBe('UNPAID'); // order and payment status are independent
    const statuses = done.body.order.events.filter((e: any) => e.type === 'STATUS_CHANGE').map((e: any) => e.toStatus);
    expect(statuses).toEqual(['PENDING_CONFIRMATION', 'CONFIRMED', 'PICKUP_SCHEDULED', 'PICKED_UP', 'RECEIVED', 'AWAITING_APPROVAL', 'RECEIVED', 'PROCESSING', 'READY_FOR_DELIVERY', 'OUT_FOR_DELIVERY', 'DELIVERED']);
    const audits = await one(pool, `SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = $1 AND action IN ('order.status','order.price_revision')`, [id]);
    expect(audits.n).toBeGreaterThanOrEqual(10);
  });

  it('rejection voids the extra work and returns the order to inspection', async () => {
    const cu = await customerWithAddress();
    const { id, order } = await toReceived(cu);
    await staff.c.post(`/api/v1/admin/orders/${id}/inspection`, { items: [{ id: order.items[0].id, receivedQuantity: 2 }], adjustments: [{ description: 'Re-dye', amount: 4000 }], reason: 'Faded' });
    const v = await cu.c.get(`/api/v1/orders/${id}`);
    const r = await cu.c.post(`/api/v1/orders/${id}/price-approval`, { revisionId: v.body.order.pendingRevision.id, decision: 'REJECT', note: 'No thanks' });
    expect(r.body.order.status).toBe('INSPECTION_REQUIRED');
    expect(r.body.order.agreedTotal).toBe(3600);
    // Now processing at the originally agreed scope is allowed.
    expect((await staff.c.post(`/api/v1/admin/orders/${id}/status`, { status: 'PROCESSING' })).body.order.finalTotal).toBe(3600);
  });

  it('a decrease is applied without needing approval; staff can record a phone approval', async () => {
    const cu = await customerWithAddress();
    const { id, order } = await toReceived(cu);
    const r = await staff.c.post(`/api/v1/admin/orders/${id}/inspection`, { items: [{ id: order.items[0].id, receivedQuantity: 1 }] });
    expect(r.body.requiresApproval).toBe(false);
    expect(r.body.order.agreedTotal).toBe(2800);
    const up = await staff.c.post(`/api/v1/admin/orders/${id}/price-revisions`, { adjustments: [{ description: 'Button repair', amount: 500 }], reason: 'Missing button' });
    expect(up.body.order.status).toBe('AWAITING_APPROVAL');
    const rev = up.body.order.pendingRevision.id;
    expect((await staff.c.post(`/api/v1/admin/orders/${id}/price-revisions/${rev}/decision`, { decision: 'APPROVE', channel: 'PHONE', note: 'Called customer 10:15, agreed' })).body.order.agreedTotal).toBe(3300);
  });

  it('records failed pickups as issues and returns the order for re-assignment', async () => {
    const cu = await customerWithAddress();
    const r = await cu.book();
    const id = r.body.order.id;
    await staff.c.post(`/api/v1/admin/orders/${id}/status`, { status: 'CONFIRMED' });
    await staff.c.post(`/api/v1/admin/orders/${id}/rider-tasks`, { type: 'PICKUP', riderId: rider.user.id });
    const task = (await rider.c.get('/api/v1/rider/tasks')).body.items.find((x: any) => x.orderReference === r.body.order.reference);
    expect((await rider.c.post(`/api/v1/rider/tasks/${task.id}/events`, { type: 'FAIL' })).status).toBe(400);
    await rider.c.post(`/api/v1/rider/tasks/${task.id}/events`, { type: 'FAIL', failureReason: 'CUSTOMER_UNREACHABLE', note: 'Called twice' });
    const d = await staff.c.get(`/api/v1/admin/orders/${id}`);
    expect(d.body.order.status).toBe('CONFIRMED');
    expect(d.body.order.issues[0]).toMatchObject({ type: 'FAILED_PICKUP', status: 'OPEN' });
    expect((await staff.c.post(`/api/v1/admin/issues/${d.body.order.issues[0].id}/resolve`, { resolution: 'Rebooked for tomorrow' })).status).toBe(200);
  });

  it('validates transitions server-side and supports hold/resume', async () => {
    const cu = await customerWithAddress();
    const r = await cu.book();
    const id = r.body.order.id;
    expect((await staff.c.post(`/api/v1/admin/orders/${id}/status`, { status: 'DELIVERED' })).body.error.code).toBe('INVALID_TRANSITION');
    expect((await staff.c.post(`/api/v1/admin/orders/${id}/status`, { status: 'ON_HOLD' })).status).toBe(400); // note required
    expect((await staff.c.post(`/api/v1/admin/orders/${id}/status`, { status: 'ON_HOLD', note: 'Address unclear' })).body.order.status).toBe('ON_HOLD');
    expect((await staff.c.post(`/api/v1/admin/orders/${id}/status`, { status: 'CONFIRMED' })).status).toBe(409);
    expect((await staff.c.post(`/api/v1/admin/orders/${id}/status`, { status: 'PENDING_CONFIRMATION' })).body.order.status).toBe('PENDING_CONFIRMATION');
  });

  it('customers cannot cancel after pickup', async () => {
    const cu = await customerWithAddress();
    const { order } = await toReceived(cu);
    expect((await cu.c.post(`/api/v1/bookings/${order.bookingId}/cancel`)).status).toBe(409);
  });
});
