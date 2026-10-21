import { beforeAll, describe, expect, it } from 'vitest';
import { one, pool } from '../../src/db.js';
import { customerWithAddress, makeUser, resetDb } from '../helpers.js';

beforeAll(resetDb);

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a6a40000000049454e44ae426082', 'hex');

describe('virtual wardrobe', () => {
  it('stores colour swatch and value, and reports totals', async () => {
    const cu = await customerWithAddress();
    const a = await cu.c.post('/api/v1/me/wardrobe', { categoryId: cu.cat.SHIRT.id, name: 'Kitenge shirt', color: 'Green', colorHex: '#2E7D4F', quantity: 2, purchaseValue: 15000 });
    expect(a.status).toBe(201);
    expect(a.body.item).toMatchObject({ colorHex: '#2E7D4F', purchaseValue: 15000, timesCleaned: 0 });
    await cu.c.post('/api/v1/me/wardrobe', { categoryId: cu.cat.SNEAKERS.id, name: 'Running shoes', purchaseValue: 40000 });
    await cu.c.post('/api/v1/me/wardrobe', { categoryId: cu.cat.DRESS.id, name: 'Blue dress' }); // value optional
    const list = await cu.c.get('/api/v1/me/wardrobe');
    expect(list.body.stats).toMatchObject({ items: 3, pieces: 4, totalValue: 70000, currentValue: 70000, clothes: 2, shoes: 1, withPhotos: 0, toReplace: 0 });
  });

  it('validates colour and value', async () => {
    const cu = await customerWithAddress();
    expect((await cu.c.post('/api/v1/me/wardrobe', { categoryId: cu.cat.SHIRT.id, name: 'X', colorHex: 'red' })).status).toBe(400);
    expect((await cu.c.post('/api/v1/me/wardrobe', { categoryId: cu.cat.SHIRT.id, name: 'X', purchaseValue: -5 })).status).toBe(400);
    expect((await cu.c.post('/api/v1/me/wardrobe', { categoryId: cu.cat.SHIRT.id, name: 'X', purchaseValue: 12.5 })).status).toBe(400);
  });

  it('filters by kind, category and search; sorts by value', async () => {
    const cu = await customerWithAddress();
    for (const [cat, name, v] of [['SHIRT', 'White shirt', 8000], ['SHIRT', 'Blue shirt', 12000], ['BOOTS', 'Leather boots', 60000]] as const) {
      await cu.c.post('/api/v1/me/wardrobe', { categoryId: cu.cat[cat].id, name, purchaseValue: v });
    }
    expect((await cu.c.get('/api/v1/me/wardrobe?kind=SHOES')).body.items.map((i: any) => i.name)).toEqual(['Leather boots']);
    expect((await cu.c.get(`/api/v1/me/wardrobe?categoryId=${cu.cat.SHIRT.id}`)).body.total).toBe(2);
    expect((await cu.c.get('/api/v1/me/wardrobe?q=blue')).body.items.map((i: any) => i.name)).toEqual(['Blue shirt']);
    expect((await cu.c.get('/api/v1/me/wardrobe?q=%25')).body.total).toBe(0); // wildcard is escaped
    expect((await cu.c.get('/api/v1/me/wardrobe?sort=value')).body.items[0].name).toBe('Leather boots');
  });

  it('PATCH changes only the fields sent and can clear value/colour', async () => {
    const cu = await customerWithAddress();
    const a = (await cu.c.post('/api/v1/me/wardrobe', { categoryId: cu.cat.SHIRT.id, name: 'Shirt', color: 'Red', colorHex: '#B42318', quantity: 3, purchaseValue: 9000, careNotes: 'No bleach' })).body.item;
    const p = await cu.c.patch(`/api/v1/me/wardrobe/${a.id}`, { name: 'Red shirt' });
    expect(p.body.item).toMatchObject({ name: 'Red shirt', color: 'Red', colorHex: '#B42318', quantity: 3, purchaseValue: 9000, careNotes: 'No bleach' });
    const c = await cu.c.patch(`/api/v1/me/wardrobe/${a.id}`, { purchaseValue: null, colorHex: null });
    expect(c.body.item).toMatchObject({ purchaseValue: null, colorHex: null, quantity: 3 });
  });

  it('counts times cleaned from delivered orders and snapshots the colour', async () => {
    const cu = await customerWithAddress();
    const staff = await makeUser('STAFF');
    const w = (await cu.c.post('/api/v1/me/wardrobe', { categoryId: cu.cat.SHIRT.id, name: 'Office shirt', colorHex: '#FFFFFF', quantity: 1 })).body.item;
    const o = (await cu.book({ items: [{ wardrobeItemId: w.id, quantity: 1, serviceId: cu.svc.WASH_IRON.id }], delivery: 'COLLECT_AT_SHOP' })).body.order;
    expect(o.items[0].colorHex).toBe('#FFFFFF');
    for (const s of ['CONFIRMED', 'PICKED_UP']) await staff.c.post(`/api/v1/admin/orders/${o.id}/status`, { status: s, note: 'x' });
    await staff.c.post(`/api/v1/admin/orders/${o.id}/inspection`, { items: [{ id: o.items[0].id, receivedQuantity: 1 }] });
    for (const s of ['PROCESSING', 'READY_FOR_DELIVERY', 'DELIVERED']) await staff.c.post(`/api/v1/admin/orders/${o.id}/status`, { status: s });
    const item = (await cu.c.get(`/api/v1/me/wardrobe/${w.id}`)).body.item;
    expect(item.timesCleaned).toBe(1);
    expect(item.lastCleanedAt).toBeTruthy();
  });
});

describe('database photo storage (PHOTO_STORAGE=db)', () => {
  it('stores photos in PostgreSQL privately and cleans up on replace/delete', async () => {
    const { storage } = await import('../../src/providers/storage.js');
    expect(storage.kind).toBe('db');
    const cu = await customerWithAddress();
    const other = await makeUser('CUSTOMER');
    const w = (await cu.c.post('/api/v1/me/wardrobe', { categoryId: cu.cat.SHIRT.id, name: 'Photo shirt' })).body.item;
    const up = await cu.c.agent.put(`/api/v1/me/wardrobe/${w.id}/photo`).set('X-Requested-With', 'LaundryDash').attach('photo', PNG, 'p.png');
    expect(up.status).toBe(200);
    const row = await one(pool, 'SELECT user_id, content_type, size FROM stored_photos WHERE user_id = $1', [cu.user.id]);
    expect(row).toMatchObject({ content_type: 'image/png', size: PNG.length });
    const img = await cu.c.get(up.body.item.photoUrl);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toContain('image/png');
    expect(img.headers['cache-control']).toContain('private');
    expect((await other.c.get(up.body.item.photoUrl)).status).toBe(404);
    // replacing removes the old blob; deleting the item removes the last one
    await cu.c.agent.put(`/api/v1/me/wardrobe/${w.id}/photo`).set('X-Requested-With', 'LaundryDash').attach('photo', PNG, 'p.png');
    expect((await one(pool, 'SELECT count(*)::int AS n FROM stored_photos WHERE user_id = $1', [cu.user.id])).n).toBe(1);
    await cu.c.del(`/api/v1/me/wardrobe/${w.id}`);
    expect((await one(pool, 'SELECT count(*)::int AS n FROM stored_photos WHERE user_id = $1', [cu.user.id])).n).toBe(0);
  });

  it('keeps a photo that a past order still references', async () => {
    const cu = await customerWithAddress();
    const w = (await cu.c.post('/api/v1/me/wardrobe', { categoryId: cu.cat.SHIRT.id, name: 'Kept photo' })).body.item;
    await cu.c.agent.put(`/api/v1/me/wardrobe/${w.id}/photo`).set('X-Requested-With', 'LaundryDash').attach('photo', PNG, 'p.png');
    await cu.book({ items: [{ wardrobeItemId: w.id, quantity: 1, serviceId: cu.svc.WASH_IRON.id }] });
    await cu.c.del(`/api/v1/me/wardrobe/${w.id}`);
    expect((await one(pool, 'SELECT count(*)::int AS n FROM stored_photos WHERE user_id = $1', [cu.user.id])).n).toBe(1);
  });
});
