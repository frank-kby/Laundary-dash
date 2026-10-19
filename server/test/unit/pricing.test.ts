import { describe, expect, it } from 'vitest';
import { priceOrder, revisionRequiresApproval, type PriceLineInput, type SubscriptionTerms } from '../../src/domain/pricing.js';

const line = (o: Partial<PriceLineInput> = {}): PriceLineInput => ({
  ref: 'r1', label: 'Shirt', serviceId: 'WI', serviceName: 'Wash & iron', pricingUnit: 'ITEM', unitPrice: 800, minCharge: 0, quantity: 2, ...o,
});
const sub = (o: Partial<SubscriptionTerms> = {}): SubscriptionTerms => ({
  subscriptionId: 'sub1', allowanceUnit: 'KG', unitsRemaining: 10, tripsRemaining: 2, overageDiscountPercent: 10, includedServiceIds: ['WF'], ...o,
});

describe('priceOrder', () => {
  it('sums per-item lines and fees', () => {
    const r = priceOrder({ lines: [line(), line({ ref: 'r2', unitPrice: 1000, quantity: 1 })], pickupFee: 1000, deliveryFee: 1000 });
    expect(r.itemsSubtotal).toBe(2600);
    expect(r.total).toBe(4600);
    expect(r.currency).toBe('RWF');
  });

  it('prices per-kg with decimals and rounds to whole RWF', () => {
    const r = priceOrder({ lines: [line({ serviceId: 'WF', pricingUnit: 'KG', unitPrice: 1500, quantity: 3.33 })], pickupFee: 0, deliveryFee: 0 });
    expect(r.lines[0].gross).toBe(4995);
    expect(Number.isInteger(r.total)).toBe(true);
  });

  it('applies the minimum charge per service', () => {
    const r = priceOrder({ lines: [line({ serviceId: 'WF', pricingUnit: 'KG', unitPrice: 1500, minCharge: 3000, quantity: 1 })], pickupFee: 0, deliveryFee: 0 });
    expect(r.minimumChargeTopUps).toEqual([{ serviceId: 'WF', serviceName: 'Wash & iron', amount: 1500 }]);
    expect(r.total).toBe(3000);
  });

  it('rounds item quantities to whole numbers', () => {
    expect(priceOrder({ lines: [line({ quantity: 2.4 })], pickupFee: 0, deliveryFee: 0 }).lines[0].quantity).toBe(2);
  });

  it('covers eligible units from a subscription and discounts overage', () => {
    const r = priceOrder({
      lines: [line({ serviceId: 'WF', pricingUnit: 'KG', unitPrice: 1500, quantity: 12 })],
      pickupFee: 1000, deliveryFee: 1000, subscription: sub(),
    });
    expect(r.lines[0].coveredQuantity).toBe(10);
    expect(r.lines[0].coveredValue).toBe(15000);
    expect(r.lines[0].overageDiscount).toBe(300); // 10% of 2kg*1500
    expect(r.lines[0].net).toBe(2700);
    expect(r.feesWaived).toBe(2000);
    expect(r.subscriptionUnitsUsed).toBe(10);
    expect(r.subscriptionTripsUsed).toBe(1);
    expect(r.total).toBe(2700);
  });

  it('does not apply subscription to services outside the plan or with a different unit', () => {
    const r = priceOrder({ lines: [line()], pickupFee: 0, deliveryFee: 0, subscription: sub({ allowanceUnit: 'ITEM', includedServiceIds: ['OTHER'] }) });
    expect(r.subscriptionUnitsUsed).toBe(0);
    expect(r.subscriptionId).toBeNull();
    expect(r.total).toBe(1600);
  });

  it('does not waive fees when no trips remain', () => {
    const r = priceOrder({ lines: [line()], pickupFee: 1000, deliveryFee: 500, subscription: sub({ tripsRemaining: 0 }) });
    expect(r.feesWaived).toBe(0);
    expect(r.total).toBe(3100);
  });

  it('skips minimum charge when subscription covered the service', () => {
    const r = priceOrder({ lines: [line({ serviceId: 'WF', pricingUnit: 'KG', unitPrice: 1500, minCharge: 3000, quantity: 1 })], pickupFee: 0, deliveryFee: 0, subscription: sub() });
    expect(r.minimumChargeTopUps).toHaveLength(0);
    expect(r.total).toBe(0);
  });

  it('includes adjustments and never goes below zero', () => {
    expect(priceOrder({ lines: [line()], pickupFee: 0, deliveryFee: 0, adjustments: [{ description: 'Stain removal', amount: 1500 }] }).total).toBe(3100);
    expect(priceOrder({ lines: [line()], pickupFee: 0, deliveryFee: 0, adjustments: [{ description: 'Goodwill', amount: -99999 }] }).total).toBe(0);
  });

  it('rejects invalid inputs', () => {
    expect(() => priceOrder({ lines: [line({ quantity: 0 })], pickupFee: 0, deliveryFee: 0 })).toThrow();
    expect(() => priceOrder({ lines: [line({ unitPrice: 10.5 })], pickupFee: 0, deliveryFee: 0 })).toThrow();
    expect(() => priceOrder({ lines: [line()], pickupFee: 0, deliveryFee: 0, adjustments: [{ description: 'x', amount: 1.5 }] })).toThrow();
  });

  it('flags only increases as needing approval', () => {
    expect(revisionRequiresApproval(5000, 5001)).toBe(true);
    expect(revisionRequiresApproval(5000, 5000)).toBe(false);
    expect(revisionRequiresApproval(5000, 3000)).toBe(false);
  });
});
