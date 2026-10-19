import type { Db } from '../db.js';
import { one } from '../db.js';
import { email } from '../providers/email.js';

const STATUS_TEXT: Record<string, { en: string; rw: string }> = {
  PENDING_CONFIRMATION: { en: 'Waiting for confirmation', rw: 'Bitegereje kwemezwa' },
  CONFIRMED: { en: 'Confirmed', rw: 'Byemejwe' },
  PICKUP_SCHEDULED: { en: 'Pickup scheduled', rw: 'Igihe cyo kuza gufata cyateganyijwe' },
  PICKED_UP: { en: 'Picked up', rw: 'Imyenda yafashwe' },
  RECEIVED: { en: 'Received at our shop', rw: 'Yageze ku iduka' },
  INSPECTION_REQUIRED: { en: 'Being inspected', rw: 'Iri gusuzumwa' },
  AWAITING_APPROVAL: { en: 'Waiting for your approval', rw: 'Bitegereje ko ubyemeza' },
  PROCESSING: { en: 'Being cleaned', rw: 'Iri gusukurwa' },
  READY_FOR_DELIVERY: { en: 'Ready', rw: 'Biteguye' },
  OUT_FOR_DELIVERY: { en: 'Out for delivery', rw: 'Biri mu nzira bikuzanira' },
  DELIVERED: { en: 'Delivered', rw: 'Byagejejwe' },
  CANCELLED: { en: 'Cancelled', rw: 'Byahagaritswe' },
  ON_HOLD: { en: 'On hold — we will contact you', rw: 'Byahagaze by’agateganyo — tuzakuvugisha' },
};

export async function notifyOrderStatus(db: Db, userId: string, orderId: string, reference: string, status: string) {
  const u = await one(db, 'SELECT preferred_language FROM users WHERE id = $1', [userId]);
  const lang: 'en' | 'rw' = u?.preferred_language === 'rw' ? 'rw' : 'en';
  const s = STATUS_TEXT[status]?.[lang] ?? status;
  await notify(db, userId, {
    type: 'ORDER_STATUS',
    orderId,
    title: lang === 'rw' ? `Komande ${reference}` : `Order ${reference}`,
    body: s,
    emailToo: ['AWAITING_APPROVAL', 'READY_FOR_DELIVERY', 'ON_HOLD'].includes(status),
  });
}

/** Always creates an in-app notification; also emails when a provider is configured and the user has an email. */
export async function notify(
  db: Db,
  userId: string,
  n: { type: string; title: string; body: string; orderId?: string | null; emailToo?: boolean },
) {
  await db.query(
    `INSERT INTO notifications (user_id, channel, type, title, body, order_id, status) VALUES ($1,'IN_APP',$2,$3,$4,$5,'SENT')`,
    [userId, n.type, n.title, n.body, n.orderId ?? null],
  );
  if (!n.emailToo || !email.configured) return;
  const u = await one(db, 'SELECT email FROM users WHERE id = $1', [userId]);
  if (!u?.email) return;
  // Email is best-effort and must never block or fail the business transaction.
  email.send({ to: u.email, subject: `Laundry Dash — ${n.title}`, text: n.body }).catch(() => {});
}
