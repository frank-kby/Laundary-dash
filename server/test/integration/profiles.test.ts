import { beforeAll, describe, expect, it } from 'vitest';
import { one, pool } from '../../src/db.js';
import { client, customerWithAddress, futureSlot, makeUser, resetDb } from '../helpers.js';

beforeAll(resetDb);

describe('personal / business profiles and gender', () => {
  it('registers a business account with name and type', async () => {
    const r = await client().post('/api/v1/auth/register', {
      fullName: 'Grace', phone: '0788 900 100', password: 'goodpassword', accountType: 'BUSINESS', businessName: 'Kacyiru Suites', businessType: 'APARTMENTS',
    });
    expect(r.status).toBe(201);
    expect(r.body.user).toMatchObject({ accountType: 'BUSINESS', businessName: 'Kacyiru Suites', businessType: 'APARTMENTS', gender: null });
  });

  it('requires a business name for business accounts', async () => {
    const r = await client().post('/api/v1/auth/register', { fullName: 'No Name', phone: '0788 900 101', password: 'goodpassword', accountType: 'BUSINESS' });
    expect(r.status).toBe(400);
  });

  it('defaults to personal, stores gender, and clears business details when switching back', async () => {
    const c = client();
    const r = await c.post('/api/v1/auth/register', { fullName: 'Eric', email: 'eric.p@example.com', password: 'goodpassword', gender: 'MALE' });
    expect(r.body.user).toMatchObject({ accountType: 'PERSONAL', gender: 'MALE' });
    const b = await c.patch('/api/v1/me', { accountType: 'BUSINESS', businessName: 'Eric Rentals', businessType: 'CLOTHES_RENTAL' });
    expect(b.body.user).toMatchObject({ accountType: 'BUSINESS', businessName: 'Eric Rentals', gender: 'MALE' });
    const p = await c.patch('/api/v1/me', { accountType: 'PERSONAL' });
    expect(p.body.user).toMatchObject({ accountType: 'PERSONAL', businessName: null, businessType: null });
    expect((await c.patch('/api/v1/me', { gender: null })).body.user.gender).toBeNull();
  });

  it('exposes category gender, segment and lifespan in the catalogue', async () => {
    const r = await client().get('/api/v1/services');
    const byCode = Object.fromEntries(r.body.categories.map((c: any) => [c.code, c]));
    expect(byCode.SKIRT).toMatchObject({ gender: 'FEMALE', segment: 'PERSONAL' });
    expect(byCode.TIE).toMatchObject({ gender: 'MALE' });
    expect(byCode.BED_SHEET).toMatchObject({ segment: 'BUSINESS', lifespanMonths: 24 });
    expect(byCode.JACKET.lifespanMonths).toBe(60);
  });
});

describe('business contact numbers (admin settings)', () => {
  it('admins update WhatsApp and phone; customers see them immediately; audited', async () => {
    const admin = await makeUser('ADMIN');
    const staff = await makeUser('STAFF');
    expect((await staff.c.put('/api/v1/admin/settings/contact', { phone: '0788111222', whatsapp: '0788333444' })).status).toBe(403);
    expect((await admin.c.put('/api/v1/admin/settings/contact', { phone: '12', whatsapp: '0788333444' })).status).toBe(400);
    const r = await admin.c.put('/api/v1/admin/settings/contact', { phone: '0788 111 222', whatsapp: '+250 788 333 444' });
    expect(r.body.contact).toEqual({ phone: '+250788111222', whatsapp: '250788333444', source: 'settings' });
    const cfg = await client().get('/api/v1/config');
    expect(cfg.body.support).toEqual({ phone: '+250788111222', whatsapp: '250788333444' });
    expect((await staff.c.get('/api/v1/admin/settings/contact')).body.contact.phone).toBe('+250788111222');
    const log = await one(pool, `SELECT after_data FROM audit_logs WHERE action = 'settings.contact' ORDER BY id DESC LIMIT 1`);
    expect(log.after_data.whatsapp).toBe('250788333444');
  });
});

describe('guest quotes', () => {
  it('lets a guest price a booking with an inline address, but not use saved data or book', async () => {
    const { svc, cat, area } = await (await import('../helpers.js')).catalogue();
    const slot = await futureSlot();
    const body = {
      items: [{ name: 'Blue shirt', categoryId: cat.SHIRT.id, quantity: 2, serviceId: svc.WASH_IRON.id }],
      pickupAddress: { serviceAreaId: area.KIMIHURURA.id, landmark: 'Near KCC' },
      pickupSlotId: slot.id,
      deliveryPreference: 'DELIVER_TO_ADDRESS',
    };
    const guest = client();
    const q = await guest.post('/api/v1/bookings/quote', body);
    expect(q.status).toBe(200);
    expect(q.body.pricing.total).toBe(3600);
    const cu = await customerWithAddress();
    expect((await guest.post('/api/v1/bookings/quote', { ...body, pickupAddress: undefined, pickupAddressId: cu.addressId })).status).toBe(401);
    expect((await guest.post('/api/v1/bookings', body, 'guest-key-123')).status).toBe(401);
    expect((await guest.get('/api/v1/me/wardrobe')).status).toBe(401);
  });
});

describe('wardrobe depreciation and business locations', () => {
  it('reports current value from purchase date and category lifespan', async () => {
    const cu = await customerWithAddress();
    const twelveMonthsAgo = new Date(Date.now() - 365.25 * 86_400_000).toISOString().slice(0, 10);
    const t = await cu.c.post('/api/v1/me/wardrobe', { categoryId: cu.cat.TSHIRT.id, name: 'Old tee', quantity: 2, purchaseValue: 10000, acquiredOn: twelveMonthsAgo });
    expect(t.status).toBe(201);
    expect(t.body.item.depreciation).toMatchObject({ lifespanMonths: 24, currentValue: 5000, totalCurrent: 10000, replaceSuggested: false });
    const veryOld = new Date(Date.now() - 3 * 365.25 * 86_400_000).toISOString().slice(0, 10);
    await cu.c.post('/api/v1/me/wardrobe', { categoryId: cu.cat.SNEAKERS.id, name: 'Worn sneakers', purchaseValue: 30000, acquiredOn: veryOld });
    await cu.c.post('/api/v1/me/wardrobe', { categoryId: cu.cat.JACKET.id, name: 'New blazer', purchaseValue: 60000 }); // no date → added today
    const list = await cu.c.get('/api/v1/me/wardrobe?sort=worn');
    expect(list.body.items.map((i: any) => i.name)).toEqual(['Worn sneakers', 'Old tee', 'New blazer']);
    expect(list.body.stats).toMatchObject({ totalValue: 110000, currentValue: 70000, toReplace: 1 });
    expect((await cu.c.get('/api/v1/me/wardrobe?replace=true')).body.items.map((i: any) => i.name)).toEqual(['Worn sneakers']);
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    expect((await cu.c.post('/api/v1/me/wardrobe', { categoryId: cu.cat.SHIRT.id, name: 'X', acquiredOn: future })).status).toBe(400);
  });

  it('lets a business track stock per location', async () => {
    const biz = client();
    await biz.post('/api/v1/auth/register', { fullName: 'Ange', email: 'ange.biz@example.com', password: 'goodpassword', accountType: 'BUSINESS', businessName: 'Remera Apartments', businessType: 'APARTMENTS' });
    const cats = (await biz.get('/api/v1/services')).body.categories;
    const sheet = cats.find((c: any) => c.code === 'BED_SHEET').id;
    const towel = cats.find((c: any) => c.code === 'TOWEL').id;
    await biz.post('/api/v1/me/wardrobe', { categoryId: sheet, name: 'White queen sheets', quantity: 12, location: 'Apartment 2B', purchaseValue: 15000 });
    await biz.post('/api/v1/me/wardrobe', { categoryId: towel, name: 'Bath towels', quantity: 20, location: 'Apartment 2B' });
    await biz.post('/api/v1/me/wardrobe', { categoryId: towel, name: 'Bath towels', quantity: 16, location: 'Apartment 4A' });
    const all = (await biz.get('/api/v1/me/wardrobe')).body;
    expect(all.stats).toMatchObject({ items: 3, pieces: 48, locations: ['Apartment 2B', 'Apartment 4A'], totalValue: 180000 });
    const twoB = (await biz.get('/api/v1/me/wardrobe?location=Apartment%202B')).body;
    expect(twoB.total).toBe(2);
  });
});
