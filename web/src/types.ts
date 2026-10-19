export type Role = 'CUSTOMER' | 'RIDER' | 'STAFF' | 'ADMIN';
export interface User { id: string; fullName: string; email: string | null; phone: string | null; role: Role; preferredLanguage: 'en' | 'rw'; isDemo: boolean }
export interface Category { id: string; code: string; kind: 'CLOTHES' | 'SHOES'; nameEn: string; nameRw: string; active?: boolean }
export interface Service { id: string; code: string; nameEn: string; nameRw: string; descriptionEn: string; descriptionRw: string; kind: 'CLOTHES' | 'SHOES'; pricingUnit: 'ITEM' | 'KG'; unitPrice: number; minCharge: number; turnaroundHours: number; active: boolean; categoryPrices: { categoryId: string; unitPrice: number }[] }
export interface Area { id: string; code: string; name: string; district: string; landmarks: string[]; pickupFee: number; deliveryFee: number; active: boolean }
export interface Address { id: string; label: string; serviceAreaId: string; serviceAreaName: string; street: string; landmark: string; details: string; contactPhone: string | null }
export interface WardrobeItem { id: string; kind: 'CLOTHES' | 'SHOES'; categoryId: string; categoryCode: string; name: string; color: string; quantity: number; careNotes: string; hasPhoto: boolean; photoUrl: string | null }
export interface Slot { id: string; startsAt: string; endsAt: string; remaining: number; available: boolean }
export interface AppConfig { features: { emailPasswordReset: boolean; photos: boolean; mobileMoney: { provider: string; testMode: boolean } | null }; support: { phone: string; whatsapp: string } }
export interface Payment { id: string; orderId: string | null; subscriptionId: string | null; amount: number; method: string; provider: string | null; testMode: boolean; status: string; refundedAmount: number; payerMsisdnMasked: string | null; manualReference: string | null; createdAt: string }
export interface PricedLine { ref: string; label: string; serviceName: string; pricingUnit: 'ITEM' | 'KG'; unitPrice: number; quantity: number; gross: number; coveredQuantity: number; overageDiscount: number; net: number }
export interface Pricing { lines: PricedLine[]; minimumChargeTopUps: { serviceName: string; amount: number }[]; itemsSubtotal: number; pickupFee: number; deliveryFee: number; feesWaived: number; adjustments: { description: string; amount: number }[]; total: number }
export interface OrderSummary { id: string; bookingId: string; reference: string; status: string; paymentStatus: string; total: number; pickupSlot?: { startsAt: string; endsAt: string }; itemCount: number; customerName?: string; customerPhone?: string; areaName?: string; createdAt: string }
export interface OrderDetail {
  id: string; bookingId: string; reference: string; status: string; holdFromStatus: string | null; paymentStatus: string; estimatedTotal: number; agreedTotal: number; finalTotal: number | null;
  balance: { due: number; paid: number; pending: number; balance: number }; pricing: Pricing; inspectionRecorded: boolean;
  pickupSlot: { id: string; startsAt: string; endsAt: string }; pickupAddress: any; deliveryPreference: 'DELIVER_TO_ADDRESS' | 'COLLECT_AT_SHOP'; deliveryAddress: any; customerNotes: string; rescheduleCount: number; createdAt: string;
  customer?: { id: string; name: string; phone: string | null; email: string | null }; allowedNextStatuses?: string[];
  items: { id: string; name: string; kind: string; categoryCode: string; categoryName: string; color: string; careNotes: string; hasPhoto: boolean; serviceId: string; serviceName: string; pricingUnit: 'ITEM' | 'KG'; unitPrice: number; declaredQuantity: number; receivedQuantity: number | null; measuredWeightKg: number | null; conditionNotes: string; addedByStaff: boolean }[];
  adjustments: { id: string; description: string; amount: number; voided: boolean }[];
  events: { id: string; type: string; fromStatus: string | null; toStatus: string | null; note: string; actor: string | null; createdAt: string }[];
  pendingRevision: { id: string; previousTotal: number; proposedTotal: number; reason: string; pricing: Pricing } | null;
  revisions: { id: string; previousTotal: number; proposedTotal: number; reason: string; status: string; decisionChannel: string | null; createdAt: string }[];
  payments: Payment[];
  issues: { id: string; type: string; status: string; description: string; resolution: string; createdAt: string }[];
  riderTasks: { id: string; type: string; status: string; riderName: string; failureReason: string | null; createdAt: string }[];
}
export interface Plan { id: string; code: string; nameEn: string; nameRw: string; descriptionEn: string; descriptionRw: string; price: number; validityDays: number; allowanceUnit: 'ITEM' | 'KG'; allowanceQuantity: number; freeTrips: number; overageDiscountPercent: number; includedServiceIds: string[]; active: boolean }
export interface Paged<T> { items: T[]; page: number; pageSize: number; total: number }
