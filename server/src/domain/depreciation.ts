/**
 * Straight-line depreciation for wardrobe items.
 * An item loses value evenly over its category's typical lifespan and is worth 0 at the end.
 * This is an estimate to help people decide when to replace or donate clothes, not an accounting valuation.
 */
export const DAYS_PER_MONTH = 30.4375;
/** At or below this share of original value we suggest replacing/donating the item. */
export const REPLACE_THRESHOLD = 0.2;

export interface DepreciationInput {
  value: number | null; // RWF per piece
  quantity: number;
  acquiredOn: Date; // purchase date (or date added when unknown)
  lifespanMonths: number;
  today?: Date;
}

export interface Depreciation {
  ageMonths: number;
  lifespanMonths: number;
  remainingShare: number; // 0..1
  currentValue: number | null; // per piece, rounded to 100 RWF
  totalOriginal: number | null; // value * quantity
  totalCurrent: number | null;
  replaceSuggested: boolean;
  monthsLeft: number;
}

const startOfDayUtc = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

export function depreciate(i: DepreciationInput): Depreciation {
  const today = i.today ?? new Date();
  const lifespan = Math.max(1, Math.round(i.lifespanMonths));
  const days = Math.max(0, (startOfDayUtc(today) - startOfDayUtc(i.acquiredOn)) / 86_400_000);
  const ageMonths = days / DAYS_PER_MONTH;
  const remainingShare = Math.min(1, Math.max(0, 1 - ageMonths / lifespan));
  const currentValue = i.value == null ? null : Math.round((i.value * remainingShare) / 100) * 100;
  // Whole calendar months owned (for display, e.g. "owned 12 months").
  const a = i.acquiredOn, t = today;
  const calMonths = Math.max(0, (t.getUTCFullYear() - a.getUTCFullYear()) * 12 + (t.getUTCMonth() - a.getUTCMonth()) - (t.getUTCDate() < a.getUTCDate() ? 1 : 0));
  return {
    ageMonths: calMonths,
    lifespanMonths: lifespan,
    remainingShare: Math.round(remainingShare * 1000) / 1000,
    currentValue,
    totalOriginal: i.value == null ? null : i.value * i.quantity,
    totalCurrent: currentValue == null ? null : currentValue * i.quantity,
    replaceSuggested: remainingShare <= REPLACE_THRESHOLD,
    monthsLeft: Math.max(0, Math.ceil(lifespan - ageMonths)),
  };
}

/** SQL expression for the remaining share, kept in step with depreciate() for sorting/filtering. */
export const REMAINING_SHARE_SQL = `GREATEST(0, LEAST(1, 1 - ((CURRENT_DATE - COALESCE(w.acquired_on, w.created_at::date))::numeric / ${DAYS_PER_MONTH}) / GREATEST(c.lifespan_months, 1)))`;
