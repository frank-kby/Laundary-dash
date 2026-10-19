import { describe, expect, it } from 'vitest';
import { allowedNext, canTransition, guardTransition, ORDER_STATUSES } from '../../src/domain/orderStatus.js';
import { normalizeEmail, normalizePhone, parseIdentifier } from '../../src/identifiers.js';
import { SimulatorProvider, signSimulatorWebhook } from '../../src/providers/payments.js';
import { sniffImage } from '../../src/providers/storage.js';
import { toCsv, zonedTime } from '../../src/routes/admin.js';

describe('order state machine', () => {
  it('allows the happy path', () => {
    const path = ['PENDING_CONFIRMATION', 'CONFIRMED', 'PICKUP_SCHEDULED', 'PICKED_UP', 'RECEIVED', 'PROCESSING', 'READY_FOR_DELIVERY', 'OUT_FOR_DELIVERY', 'DELIVERED'] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i], path[i + 1])).toBe(true);
  });
  it('blocks skipping and leaving terminal states', () => {
    expect(canTransition('PENDING_CONFIRMATION', 'DELIVERED')).toBe(false);
    expect(canTransition('PICKED_UP', 'CANCELLED')).toBe(false); // must go via ON_HOLD after collection
    for (const s of ORDER_STATUSES) {
      expect(canTransition('DELIVERED', s)).toBe(false);
      expect(canTransition('CANCELLED', s)).toBe(false);
    }
  });
  it('resumes ON_HOLD only to where it came from, or cancels', () => {
    expect(canTransition('ON_HOLD', 'PROCESSING', 'PROCESSING')).toBe(true);
    expect(canTransition('ON_HOLD', 'DELIVERED', 'PROCESSING')).toBe(false);
    expect(canTransition('ON_HOLD', 'CANCELLED', 'PROCESSING')).toBe(true);
    expect(allowedNext('ON_HOLD', 'RECEIVED')).toEqual(['RECEIVED', 'CANCELLED']);
  });
  it('guards processing behind inspection and approval', () => {
    const base = { inspectionRecorded: true, hasPendingRevision: false, currentTotal: 5000, agreedTotal: 5000, deliveryPreference: 'DELIVER_TO_ADDRESS' as const };
    expect(guardTransition('RECEIVED', 'PROCESSING', base)).toBeNull();
    expect(guardTransition('RECEIVED', 'PROCESSING', { ...base, inspectionRecorded: false })).toBe('INSPECTION_REQUIRED');
    expect(guardTransition('RECEIVED', 'PROCESSING', { ...base, hasPendingRevision: true })).toBe('PRICE_APPROVAL_PENDING');
    expect(guardTransition('RECEIVED', 'PROCESSING', { ...base, currentTotal: 6000 })).toBe('PRICE_APPROVAL_REQUIRED');
    expect(guardTransition('RECEIVED', 'PROCESSING', { ...base, currentTotal: 4000 })).toBeNull();
  });
  it('requires a rider for address deliveries', () => {
    const ctx = { inspectionRecorded: true, hasPendingRevision: false, currentTotal: 0, agreedTotal: 0 };
    expect(guardTransition('READY_FOR_DELIVERY', 'DELIVERED', { ...ctx, deliveryPreference: 'DELIVER_TO_ADDRESS' })).toBe('DELIVERY_REQUIRES_RIDER');
    expect(guardTransition('READY_FOR_DELIVERY', 'DELIVERED', { ...ctx, deliveryPreference: 'COLLECT_AT_SHOP' })).toBeNull();
  });
});

describe('identifiers', () => {
  it('normalizes Rwandan phone formats to E.164', () => {
    for (const p of ['0788123456', '788123456', '+250788123456', '250788123456', '078 812-3456', '(+250) 788 123 456']) {
      expect(normalizePhone(p)).toBe('+250788123456');
    }
    expect(normalizePhone('0721234567')).toBe('+250721234567');
  });
  it('rejects invalid phones', () => {
    for (const p of ['12', 'abc', '07881234', '+2507881234567890']) expect(normalizePhone(p)).toBeNull();
  });
  it('normalizes emails', () => {
    expect(normalizeEmail('  Alice@Example.COM ')).toBe('alice@example.com');
    expect(normalizeEmail('not-an-email')).toBeNull();
  });
  it('detects identifier type', () => {
    expect(parseIdentifier('a@b.co')).toEqual({ type: 'email', value: 'a@b.co' });
    expect(parseIdentifier('0788123456')).toEqual({ type: 'phone', value: '+250788123456' });
  });
});

describe('simulator webhook verification', () => {
  const sim = new SimulatorProvider();
  const body = JSON.stringify({ eventId: 'evt_1', reference: 'SIM-1', status: 'SUCCESSFUL' });
  it('accepts a valid signature', () => {
    expect(sim.verifyWebhook({ rawBody: Buffer.from(body), headers: signSimulatorWebhook(body), query: {} })).toMatchObject({ ok: true, providerReference: 'SIM-1', eventId: 'evt_1' });
  });
  it('rejects tampered bodies, bad signatures and stale timestamps', () => {
    const h = signSimulatorWebhook(body);
    expect(sim.verifyWebhook({ rawBody: Buffer.from(body.replace('SUCCESSFUL', 'FAILED')), headers: h, query: {} }).ok).toBe(false);
    expect(sim.verifyWebhook({ rawBody: Buffer.from(body), headers: { ...h, 'x-ld-signature': 'f'.repeat(64) }, query: {} }).ok).toBe(false);
    expect(sim.verifyWebhook({ rawBody: Buffer.from(body), headers: signSimulatorWebhook(body, Math.floor(Date.now() / 1000) - 3600), query: {} }).ok).toBe(false);
  });
  it('reports UNKNOWN for references it never issued', async () => {
    expect((await sim.fetchStatus('SIM-nope')).status).toBe('UNKNOWN');
  });
});

describe('utilities', () => {
  it('converts Kigali wall-clock time to UTC (UTC+2)', () => {
    expect(zonedTime('2026-10-20', 8, 0, 'Africa/Kigali').toISOString()).toBe('2026-10-20T06:00:00.000Z');
  });
  it('escapes CSV and neutralises spreadsheet formulas', () => {
    const csv = toCsv([{ a: '=HYPERLINK("x")', b: 'x,y', c: 'say "hi"' }], ['a', 'b', 'c']);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('"x,y"');
    expect(csv).toContain('"say ""hi"""');
  });
  it('sniffs image types from magic bytes', () => {
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('<svg onload=alert(1)>'))).toBeNull();
  });
});
