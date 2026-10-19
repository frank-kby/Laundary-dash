export const ORDER_STATUSES = [
  'PENDING_CONFIRMATION',
  'CONFIRMED',
  'PICKUP_SCHEDULED',
  'PICKED_UP',
  'RECEIVED',
  'INSPECTION_REQUIRED',
  'AWAITING_APPROVAL',
  'PROCESSING',
  'READY_FOR_DELIVERY',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLED',
  'ON_HOLD',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Allowed edges. ON_HOLD's exits are handled specially (resume to the status it was held from, or cancel). */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING_CONFIRMATION: ['CONFIRMED', 'CANCELLED', 'ON_HOLD'],
  CONFIRMED: ['PICKUP_SCHEDULED', 'PICKED_UP', 'CANCELLED', 'ON_HOLD'],
  PICKUP_SCHEDULED: ['PICKED_UP', 'CONFIRMED', 'CANCELLED', 'ON_HOLD'],
  PICKED_UP: ['RECEIVED', 'ON_HOLD'],
  RECEIVED: ['INSPECTION_REQUIRED', 'AWAITING_APPROVAL', 'PROCESSING', 'ON_HOLD'],
  INSPECTION_REQUIRED: ['AWAITING_APPROVAL', 'RECEIVED', 'PROCESSING', 'ON_HOLD'],
  AWAITING_APPROVAL: ['RECEIVED', 'INSPECTION_REQUIRED', 'ON_HOLD'],
  PROCESSING: ['READY_FOR_DELIVERY', 'ON_HOLD'],
  READY_FOR_DELIVERY: ['OUT_FOR_DELIVERY', 'DELIVERED', 'ON_HOLD'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'READY_FOR_DELIVERY', 'ON_HOLD'],
  DELIVERED: [],
  CANCELLED: [],
  ON_HOLD: ['CANCELLED'], // + resume target, see canTransition
};

/** Statuses a customer may cancel or reschedule from (before garments are collected). */
export const CUSTOMER_CANCELLABLE: OrderStatus[] = ['PENDING_CONFIRMATION', 'CONFIRMED', 'PICKUP_SCHEDULED'];

/** Transitions that only system workflows may perform (not the generic staff status endpoint). */
export const WORKFLOW_ONLY: OrderStatus[] = ['AWAITING_APPROVAL'];

export const TERMINAL: OrderStatus[] = ['DELIVERED', 'CANCELLED'];

export function canTransition(from: OrderStatus, to: OrderStatus, holdFrom?: OrderStatus | null): boolean {
  if (from === to) return false;
  if (from === 'ON_HOLD') return to === 'CANCELLED' || (!!holdFrom && to === holdFrom);
  return TRANSITIONS[from].includes(to);
}

export function allowedNext(from: OrderStatus, holdFrom?: OrderStatus | null): OrderStatus[] {
  if (from === 'ON_HOLD') return holdFrom ? [holdFrom, 'CANCELLED'] : ['CANCELLED'];
  return TRANSITIONS[from];
}

export interface TransitionContext {
  inspectionRecorded: boolean;
  hasPendingRevision: boolean;
  currentTotal: number; // recomputed by the pricing engine
  agreedTotal: number;
  deliveryPreference: 'DELIVER_TO_ADDRESS' | 'COLLECT_AT_SHOP';
}

/** Business guards on top of the edge table. Returns an error code or null. */
export function guardTransition(from: OrderStatus, to: OrderStatus, ctx: TransitionContext): string | null {
  if (to === 'PROCESSING') {
    if (!ctx.inspectionRecorded) return 'INSPECTION_REQUIRED';
    if (ctx.hasPendingRevision) return 'PRICE_APPROVAL_PENDING';
    if (ctx.currentTotal > ctx.agreedTotal) return 'PRICE_APPROVAL_REQUIRED';
  }
  if (from === 'READY_FOR_DELIVERY' && to === 'DELIVERED' && ctx.deliveryPreference !== 'COLLECT_AT_SHOP') {
    return 'DELIVERY_REQUIRES_RIDER';
  }
  if (from === 'READY_FOR_DELIVERY' && to === 'OUT_FOR_DELIVERY' && ctx.deliveryPreference === 'COLLECT_AT_SHOP') {
    return 'CUSTOMER_COLLECTS_AT_SHOP';
  }
  return null;
}
