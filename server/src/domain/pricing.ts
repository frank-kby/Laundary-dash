/**
 * Pure pricing engine. All money is integer RWF. The server is the only place totals are computed;
 * client-supplied totals are never accepted.
 */
export type PricingUnit = 'ITEM' | 'KG';

export interface PriceLineInput {
  ref: string; // order item id or temp key
  label: string;
  serviceId: string;
  serviceName: string;
  pricingUnit: PricingUnit;
  unitPrice: number;
  minCharge: number;
  quantity: number; // items, or kg
}

export interface AdjustmentInput {
  description: string;
  amount: number; // may be negative
}

export interface SubscriptionTerms {
  subscriptionId: string;
  allowanceUnit: PricingUnit;
  unitsRemaining: number;
  tripsRemaining: number;
  overageDiscountPercent: number;
  includedServiceIds: string[];
}

export interface PricingInput {
  lines: PriceLineInput[];
  pickupFee: number;
  deliveryFee: number; // 0 when customer collects at shop
  adjustments?: AdjustmentInput[];
  subscription?: SubscriptionTerms | null;
}

export interface PricedLine {
  ref: string;
  label: string;
  serviceId: string;
  serviceName: string;
  pricingUnit: PricingUnit;
  unitPrice: number;
  quantity: number;
  gross: number;
  coveredQuantity: number;
  coveredValue: number;
  overageDiscount: number;
  net: number;
}

export interface PricingResult {
  lines: PricedLine[];
  minimumChargeTopUps: { serviceId: string; serviceName: string; amount: number }[];
  itemsSubtotal: number;
  pickupFee: number;
  deliveryFee: number;
  feesWaived: number;
  adjustments: AdjustmentInput[];
  adjustmentsTotal: number;
  subscriptionUnitsUsed: number;
  subscriptionTripsUsed: number;
  subscriptionId: string | null;
  total: number;
  currency: 'RWF';
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function priceOrder(input: PricingInput): PricingResult {
  const sub = input.subscription ?? null;
  let unitsLeft = sub ? Math.max(0, sub.unitsRemaining) : 0;
  let unitsUsed = 0;

  const lines: PricedLine[] = input.lines.map((l) => {
    if (!(l.quantity > 0)) throw new Error(`Invalid quantity for ${l.label}`);
    if (l.unitPrice < 0 || !Number.isInteger(l.unitPrice)) throw new Error('Unit price must be a non-negative integer');
    const qty = l.pricingUnit === 'ITEM' ? Math.round(l.quantity) : round2(l.quantity);
    const gross = Math.round(l.unitPrice * qty);
    const eligible = !!sub && sub.allowanceUnit === l.pricingUnit && sub.includedServiceIds.includes(l.serviceId);
    let coveredQuantity = 0;
    let coveredValue = 0;
    let overageDiscount = 0;
    if (eligible) {
      coveredQuantity = round2(Math.min(qty, unitsLeft));
      unitsLeft = round2(unitsLeft - coveredQuantity);
      unitsUsed = round2(unitsUsed + coveredQuantity);
      coveredValue = Math.round(l.unitPrice * coveredQuantity);
      const overageValue = gross - coveredValue;
      overageDiscount = Math.round((overageValue * sub!.overageDiscountPercent) / 100);
    }
    return {
      ref: l.ref,
      label: l.label,
      serviceId: l.serviceId,
      serviceName: l.serviceName,
      pricingUnit: l.pricingUnit,
      unitPrice: l.unitPrice,
      quantity: qty,
      gross,
      coveredQuantity,
      coveredValue,
      overageDiscount,
      net: gross - coveredValue - overageDiscount,
    };
  });

  // Minimum charge per service, only for services with no subscription coverage.
  const byService = new Map<string, { name: string; min: number; net: number; covered: number }>();
  input.lines.forEach((l, i) => {
    const e = byService.get(l.serviceId) ?? { name: l.serviceName, min: l.minCharge, net: 0, covered: 0 };
    e.net += lines[i].net;
    e.covered += lines[i].coveredQuantity;
    e.min = Math.max(e.min, l.minCharge);
    byService.set(l.serviceId, e);
  });
  const minimumChargeTopUps = [...byService.entries()]
    .filter(([, e]) => e.covered === 0 && e.net < e.min)
    .map(([serviceId, e]) => ({ serviceId, serviceName: e.name, amount: e.min - e.net }));

  const itemsSubtotal = lines.reduce((s, l) => s + l.net, 0) + minimumChargeTopUps.reduce((s, t) => s + t.amount, 0);

  let feesWaived = 0;
  let tripsUsed = 0;
  const fees = input.pickupFee + input.deliveryFee;
  if (sub && sub.tripsRemaining >= 1 && fees > 0) {
    feesWaived = fees;
    tripsUsed = 1;
  }

  const adjustments = (input.adjustments ?? []).map((a) => {
    if (!Number.isInteger(a.amount)) throw new Error('Adjustment must be an integer amount');
    return { description: a.description, amount: a.amount };
  });
  const adjustmentsTotal = adjustments.reduce((s, a) => s + a.amount, 0);

  const total = Math.max(0, itemsSubtotal + fees - feesWaived + adjustmentsTotal);

  return {
    lines,
    minimumChargeTopUps,
    itemsSubtotal,
    pickupFee: input.pickupFee,
    deliveryFee: input.deliveryFee,
    feesWaived,
    adjustments,
    adjustmentsTotal,
    subscriptionUnitsUsed: unitsUsed,
    subscriptionTripsUsed: tripsUsed,
    subscriptionId: sub && (unitsUsed > 0 || tripsUsed > 0) ? sub.subscriptionId : null,
    total,
    currency: 'RWF',
  };
}

/** Does moving from `agreedTotal` to `newTotal` need the customer's approval before work proceeds? */
export function revisionRequiresApproval(agreedTotal: number, newTotal: number): boolean {
  return newTotal > agreedTotal;
}
