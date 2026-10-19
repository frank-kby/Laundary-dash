import { beforeAll, describe, expect, it } from 'vitest';
import { one, pool } from '../../src/db.js';
import { customerWithAddress, futureSlot, makeUser, resetDb } from '../helpers.js';

beforeAll(resetDb);

describe('manual booking', () => {
  it('books without a wardrobe, and the confirmed total equals the quote', async () => {
    const cu = await customerWithAddress();
    const slot = await futureSlot();
    const body = {
      items: [{ name: 'Blue shirt', categoryId: cu.cat.SHIRT.id, quantity: 3, serviceId: cu.svc.WASH_IRON.id },
              { name: 'Suit jacket', categoryId: cu.cat.JACKET.id, quantity: 1, serviceId: cu.svc.DRY_CLEAN.id }],
      pickupAddressId: cu.addressId, pickupSlotId: slot.id, deliveryPreference: 'DELIVER_TO_ADDRESS',
    };
    const quote = await cu.c.post('/api/v1/bookings/quote', body);
    expect(quote.status).toBe(200);
    // 3 x 800 + 1 x 5000 (category override) + 1000 pickup + 1000 delivery
    expect(quote.body.pricing.total).toBe(9400);
    const r = await cu.c.post('/api/v1/bookings', { ...body, total: 1, unitPrice: 1 }, 'book-1-aaaa'); // client totals are ignored
    expect(r.status).toBe(201);
    expect(r.body.order.reference).toMatch(/^LD-\d{6}-[2-9A-Z]{5}$/);
    expect(r.body.order.status).toBe('PENDING_CONFIRMATION');
    expect(r.body.order.estimatedTotal).toBe(9400);
  });

  it('collect-at-shop has no delivery fee', async () => {
    const cu = await customerWithAddress();
    const r = await cu.book({ delivery: 'COLLECT_AT_SHOP' });
    expect(r.body.order.pricing.deliveryFee).toBe(0);
    expect(r.body.order.estimatedTotal).toBe(2600);
  });

  it('accepts an inline new address and adds new items to the wardrobe while booking', async () => {
    const cu = await customerWithAddress();
    const slot = await futureSlot();
    const r = await cu.c.post('/api/v1/bookings', {
      items: [{ name: 'Red dress', categoryId: cu.cat.DRESS.id, quantity: 1, serviceId: cu.svc.DRY_CLEAN.id, saveToWardrobe: true }],
      pickupAddress: { label: 'Office', serviceAreaId: cu.area.REMERA.id, landmark: 'Opposite Amahoro Stadium gate 2' },
      pickupSlotId: slot.id, deliveryPreference: 'DELIVER_TO_ADDRESS',
    }, 'inline-addr-1');
    expect(r.status).toBe(201);
    expect(r.body.order.pickupAddress.serviceAreaName).toBe('Remera');
    const w = await cu.c.get('/api/v1/me/wardrobe');
    expect(w.body.items.map((i: any) => i.name)).toContain('Red dress');
  });

  it('rejects mismatched service/garment kinds and bad weights', async () => {
    const cu = await customerWithAddress();
    expect((await cu.book({ items: [{ name: 'Boots', categoryId: cu.cat.BOOTS.id, quantity: 1, serviceId: cu.svc.WASH_IRON.id }] })).status).toBe(400);
    expect((await cu.book({ items: [{ name: 'Mixed', categoryId: cu.cat.OTHER_CLOTHES.id, quantity: 80, serviceId: cu.svc.WASH_FOLD.id }] })).status).toBe(400);
  });
});

describe('duplicate submissions & capacity', () => {
  it('replays the same response for a repeated Idempotency-Key and creates one order', async () => {
    const cu = await customerWithAddress();
    const slot = await futureSlot();
    const a = await cu.book({ slotId: slot.id, key: 'dup-key-12345' });
    const b = await cu.book({ slotId: slot.id, key: 'dup-key-12345' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body.order.id).toBe(a.body.order.id);
    const n = await one(pool, 'SELECT count(*)::int AS n FROM orders WHERE user_id = $1', [cu.user.id]);
    expect(n.n).toBe(1);
  });

  it('rejects reuse of a key with a different body', async () => {
    const cu = await customerWithAddress();
    await cu.book({ key: 'reuse-key-1234' });
    const r = await cu.book({ key: 'reuse-key-1234', items: [{ name: 'Other', categoryId: cu.cat.SHIRT.id, quantity: 5, serviceId: cu.svc.WASH_IRON.id }] });
    expect(r.status).toBe(422);
  });

  it('never overbooks a slot under concurrent requests', async () => {
    const slot = await futureSlot(1);
    await pool.query('UPDATE pickup_slots SET booked_count = 0 WHERE id = $1', [slot.id]);
    const customers = await Promise.all([1, 2, 3, 4].map(() => customerWithAddress()));
    const results = await Promise.all(customers.map((cu) => cu.book({ slotId: slot.id })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'SLOT_UNAVAILABLE')).toBe(true);
    const s = await one(pool, 'SELECT booked_count FROM pickup_slots WHERE id = $1', [slot.id]);
    expect(s.booked_count).toBe(1);
  });
});

describe('ownership, cancel & reschedule', () => {
  it("returns 404 for another customer's booking and order", async () => {
    const a = await customerWithAddress();
    const b = await makeUser('CUSTOMER');
    const r = await a.book();
    expect((await b.c.get(`/api/v1/bookings/${r.body.order.bookingId}`)).status).toBe(404);
    expect((await b.c.get(`/api/v1/orders/${r.body.order.id}`)).status).toBe(404);
    expect((await b.c.post(`/api/v1/bookings/${r.body.order.bookingId}/cancel`)).status).toBe(404);
  });

  it('cancelling releases the slot; reschedule moves it', async () => {
    const cu = await customerWithAddress();
    const s1 = await futureSlot();
    const before = (await one(pool, 'SELECT booked_count FROM pickup_slots WHERE id = $1', [s1.id])).booked_count;
    const r = await cu.book({ slotId: s1.id });
    const s2 = await one(pool, `SELECT * FROM pickup_slots WHERE id <> $1 AND starts_at > now() + interval '2 hours' AND booked_count < capacity ORDER BY starts_at LIMIT 1`, [s1.id]);
    const rs = await cu.c.post(`/api/v1/bookings/${r.body.order.bookingId}/reschedule`, { pickupSlotId: s2.id });
    expect(rs.status).toBe(200);
    expect(rs.body.order.pickupSlot.id).toBe(s2.id);
    expect((await one(pool, 'SELECT booked_count FROM pickup_slots WHERE id = $1', [s1.id])).booked_count).toBe(before);
    const c = await cu.c.post(`/api/v1/bookings/${r.body.order.bookingId}/cancel`, { reason: 'Travelling' });
    expect(c.body.order.status).toBe('CANCELLED');
    expect((await cu.c.post(`/api/v1/bookings/${r.body.order.bookingId}/cancel`)).status).toBe(409);
  });
});

describe('wardrobe snapshots', () => {
  it('editing or deleting a wardrobe item does not rewrite past orders', async () => {
    const cu = await customerWithAddress();
    const w = await cu.c.post('/api/v1/me/wardrobe', { categoryId: cu.cat.SHIRT.id, name: 'Green kitenge shirt', color: 'Green', quantity: 2 });
    expect(w.status).toBe(201);
    const r = await cu.book({ items: [{ wardrobeItemId: w.body.item.id, quantity: 2, serviceId: cu.svc.WASH_IRON.id }] });
    expect(r.status).toBe(201);
    await cu.c.patch(`/api/v1/me/wardrobe/${w.body.item.id}`, { name: 'Renamed', color: 'Black' });
    await cu.c.del(`/api/v1/me/wardrobe/${w.body.item.id}`);
    const o = await cu.c.get(`/api/v1/orders/${r.body.order.id}`);
    expect(o.body.order.items[0].name).toBe('Green kitenge shirt');
    expect(o.body.order.items[0].color).toBe('Green');
  });

  it('cannot use another customer’s wardrobe item', async () => {
    const owner = await customerWithAddress();
    const other = await customerWithAddress();
    const w = await owner.c.post('/api/v1/me/wardrobe', { categoryId: owner.cat.SHIRT.id, name: 'Mine' });
    expect((await other.c.get(`/api/v1/me/wardrobe/${w.body.item.id}`)).status).toBe(404);
    expect((await other.book({ items: [{ wardrobeItemId: w.body.item.id, quantity: 1, serviceId: other.svc.WASH_IRON.id }] })).status).toBe(400);
  });

  it('uploads a private photo only the owner can read', async () => {
    const cu = await customerWithAddress();
    const other = await makeUser('CUSTOMER');
    const w = await cu.c.post('/api/v1/me/wardrobe', { categoryId: cu.cat.SHIRT.id, name: 'With photo' });
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a6a40000000049454e44ae426082', 'hex');
    const up = await cu.c.agent.put(`/api/v1/me/wardrobe/${w.body.item.id}/photo`).set('X-Requested-With', 'LaundryDash').attach('photo', png, 'p.png');
    expect(up.status).toBe(200);
    expect((await cu.c.get(up.body.item.photoUrl)).status).toBe(200);
    expect((await other.c.get(up.body.item.photoUrl)).status).toBe(404);
    const bad = await cu.c.agent.put(`/api/v1/me/wardrobe/${w.body.item.id}/photo`).set('X-Requested-With', 'LaundryDash').attach('photo', Buffer.from('<svg/>'), 'x.png');
    expect(bad.status).toBe(400);
  });
});
