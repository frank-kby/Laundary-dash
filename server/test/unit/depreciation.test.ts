import { describe, expect, it } from 'vitest';
import { depreciate } from '../../src/domain/depreciation.js';

const today = new Date('2026-10-21T10:00:00Z');
const monthsAgo = (m: number) => new Date(today.getTime() - m * 30.4375 * 86_400_000);

describe('straight-line depreciation', () => {
  it('is worth full value on the day it was bought', () => {
    const d = depreciate({ value: 20000, quantity: 1, acquiredOn: today, lifespanMonths: 24, today });
    expect(d).toMatchObject({ remainingShare: 1, currentValue: 20000, replaceSuggested: false, monthsLeft: 24 });
  });

  it('loses value evenly over the lifespan', () => {
    const d = depreciate({ value: 20000, quantity: 3, acquiredOn: monthsAgo(12), lifespanMonths: 24, today });
    expect(d.remainingShare).toBeCloseTo(0.5, 2);
    expect(d.currentValue).toBe(10000);
    expect(d.totalOriginal).toBe(60000);
    expect(d.totalCurrent).toBe(30000);
    expect(d.ageMonths).toBe(12);
  });

  it('suggests replacing at 20% or less, and never goes below zero', () => {
    expect(depreciate({ value: 10000, quantity: 1, acquiredOn: monthsAgo(19.3), lifespanMonths: 24, today }).replaceSuggested).toBe(true);
    expect(depreciate({ value: 10000, quantity: 1, acquiredOn: monthsAgo(18), lifespanMonths: 24, today }).replaceSuggested).toBe(false);
    const old = depreciate({ value: 10000, quantity: 1, acquiredOn: monthsAgo(60), lifespanMonths: 24, today });
    expect(old).toMatchObject({ remainingShare: 0, currentValue: 0, monthsLeft: 0, replaceSuggested: true });
  });

  it('rounds to the nearest 100 RWF and handles missing values', () => {
    expect(depreciate({ value: 12345, quantity: 1, acquiredOn: monthsAgo(1), lifespanMonths: 36, today }).currentValue! % 100).toBe(0);
    expect(depreciate({ value: null, quantity: 2, acquiredOn: monthsAgo(1), lifespanMonths: 36, today })).toMatchObject({ currentValue: null, totalCurrent: null });
  });

  it('treats a future date as new', () => {
    expect(depreciate({ value: 5000, quantity: 1, acquiredOn: new Date('2027-01-01'), lifespanMonths: 12, today }).remainingShare).toBe(1);
  });
});
