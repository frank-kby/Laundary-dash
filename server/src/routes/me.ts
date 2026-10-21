import crypto from 'node:crypto';
import { verify } from '@node-rs/argon2';
import express, { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { audit } from '../audit.js';
import { one, pool, q, tx } from '../db.js';
import { badRequest, conflict, notFound, unauthorized, AppError } from '../errors.js';
import { idParam, paged, pagination } from '../http.js';
import { normalizeEmail, normalizePhone } from '../identifiers.js';
import { sniffImage, storage } from '../providers/storage.js';
import { depreciate, REMAINING_SHARE_SQL, REPLACE_THRESHOLD } from '../domain/depreciation.js';
import { requireAuth, destroyAllSessionsForUser, createSession } from '../auth/session.js';
import { hashPassword, passwordSchema, profileFields, resolveProfile, userDto } from './auth.js';

export const meRouter = Router();
meRouter.use(requireAuth);

meRouter.get('/', async (req, res) => {
  const u = await one(pool, 'SELECT * FROM users WHERE id = $1', [req.user!.id]);
  res.json({ user: userDto(u) });
});

const patchMe = z.object({
  fullName: z.string().trim().min(2).max(100).optional(),
  preferredLanguage: z.enum(['en', 'rw']).optional(),
  email: z.string().trim().max(254).nullable().optional(),
  phone: z.string().trim().max(20).nullable().optional(),
  currentPassword: z.string().max(128).optional(),
  newPassword: passwordSchema.optional(),
  ...profileFields,
});

meRouter.patch('/', async (req, res) => {
  const b = patchMe.parse(req.body);
  const cur = await one(pool, 'SELECT * FROM users WHERE id = $1', [req.user!.id]);
  const sensitive = b.email !== undefined || b.phone !== undefined || b.newPassword !== undefined;
  if (sensitive) {
    if (!b.currentPassword || !(await verify(cur.password_hash, b.currentPassword).catch(() => false))) {
      throw unauthorized('Your current password is required to change sign-in details.');
    }
  }
  const email = b.email === undefined ? cur.email : b.email ? normalizeEmail(b.email) : null;
  const phone = b.phone === undefined ? cur.phone : b.phone ? normalizePhone(b.phone) : null;
  if (b.email && !email) throw badRequest('Please enter a valid email address.');
  if (b.phone && !phone) throw badRequest('Please enter a valid phone number.');
  if (!email && !phone) throw badRequest('Keep at least an email address or a phone number.');
  const pwHash = b.newPassword ? await hashPassword(b.newPassword) : cur.password_hash;
  const profile = resolveProfile(b, cur);
  try {
    const u = await tx(async (c) => {
      const u = await one(
        c,
        `UPDATE users SET full_name = $2, preferred_language = $3, email = $4, phone = $5, password_hash = $6,
                account_type = $7, gender = $8, business_name = $9, business_type = $10, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [cur.id, b.fullName ?? cur.full_name, b.preferredLanguage ?? cur.preferred_language, email, phone, pwHash,
         profile.accountType, profile.gender, profile.businessName, profile.businessType],
      );
      if (b.newPassword) {
        // Changing the password signs out every other device; this device gets a fresh session.
        await destroyAllSessionsForUser(c, cur.id);
        await createSession(c, res, cur.id, false, req.get('user-agent'));
      }
      if (sensitive) await audit(c, { actorId: cur.id, action: 'user.update_credentials', entityType: 'user', entityId: cur.id, after: { emailChanged: email !== cur.email, phoneChanged: phone !== cur.phone, passwordChanged: !!b.newPassword }, ip: req.ip });
      return u;
    });
    res.json({ user: userDto(u) });
  } catch (e: any) {
    if (e?.code === '23505') throw conflict('ACCOUNT_EXISTS', 'That email or phone is already used by another account.');
    throw e;
  }
});

// ---------- Addresses ----------
const addressSchema = z.object({
  label: z.string().trim().min(1).max(40),
  serviceAreaId: z.uuid(),
  street: z.string().trim().max(120).default(''),
  landmark: z.string().trim().max(160).default(''),
  details: z.string().trim().max(300).default(''),
  contactPhone: z.string().trim().max(20).nullable().optional(),
  latitude: z.number().min(-2.2).max(-1.7).nullable().optional(), // Kigali-ish bounding box, optional
  longitude: z.number().min(29.8).max(30.4).nullable().optional(),
});

export const addressDto = (a: any) => ({
  id: a.id,
  label: a.label,
  serviceAreaId: a.service_area_id,
  serviceAreaName: a.area_name,
  street: a.street,
  landmark: a.landmark,
  details: a.details,
  contactPhone: a.contact_phone,
  latitude: a.latitude,
  longitude: a.longitude,
});

async function validArea(id: string) {
  const a = await one(pool, 'SELECT id FROM service_areas WHERE id = $1 AND active', [id]);
  if (!a) throw badRequest('Please choose an area we serve.');
}
function normContact(p?: string | null) {
  if (!p) return null;
  const n = normalizePhone(p);
  if (!n) throw badRequest('Contact phone is not valid.');
  return n;
}

meRouter.get('/addresses', async (req, res) => {
  const rows = await q(
    pool,
    `SELECT a.*, s.name AS area_name FROM addresses a JOIN service_areas s ON s.id = a.service_area_id
      WHERE a.user_id = $1 AND a.deleted_at IS NULL ORDER BY a.created_at`,
    [req.user!.id],
  );
  res.json({ items: rows.map(addressDto) });
});

meRouter.post('/addresses', async (req, res) => {
  const b = addressSchema.parse(req.body);
  await validArea(b.serviceAreaId);
  const count = await one(pool, 'SELECT count(*)::int AS n FROM addresses WHERE user_id = $1 AND deleted_at IS NULL', [req.user!.id]);
  if (count.n >= 10) throw conflict('LIMIT_REACHED', 'You can save up to 10 addresses.');
  const a = await one(
    pool,
    `INSERT INTO addresses (user_id, label, service_area_id, street, landmark, details, contact_phone, latitude, longitude)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *, (SELECT name FROM service_areas WHERE id = $3) AS area_name`,
    [req.user!.id, b.label, b.serviceAreaId, b.street, b.landmark, b.details, normContact(b.contactPhone), b.latitude ?? null, b.longitude ?? null],
  );
  res.status(201).json({ address: addressDto(a) });
});

meRouter.get('/addresses/:id', async (req, res) => {
  const a = await one(
    pool,
    `SELECT a.*, s.name AS area_name FROM addresses a JOIN service_areas s ON s.id = a.service_area_id
      WHERE a.id = $1 AND a.user_id = $2 AND a.deleted_at IS NULL`,
    [idParam(req), req.user!.id],
  );
  if (!a) throw notFound('Address not found.');
  res.json({ address: addressDto(a) });
});

meRouter.patch('/addresses/:id', async (req, res) => {
  const b = addressSchema.partial().parse(req.body);
  const id = idParam(req);
  const cur = await one(pool, 'SELECT * FROM addresses WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [id, req.user!.id]);
  if (!cur) throw notFound('Address not found.');
  if (b.serviceAreaId) await validArea(b.serviceAreaId);
  const a = await one(
    pool,
    `UPDATE addresses SET label=$2, service_area_id=$3, street=$4, landmark=$5, details=$6, contact_phone=$7, latitude=$8, longitude=$9
      WHERE id = $1 RETURNING *, (SELECT name FROM service_areas WHERE id = $3) AS area_name`,
    [id, b.label ?? cur.label, b.serviceAreaId ?? cur.service_area_id, b.street ?? cur.street, b.landmark ?? cur.landmark, b.details ?? cur.details,
     b.contactPhone === undefined ? cur.contact_phone : normContact(b.contactPhone), b.latitude === undefined ? cur.latitude : b.latitude,
     b.longitude === undefined ? cur.longitude : b.longitude],
  );
  res.json({ address: addressDto(a) });
});

meRouter.delete('/addresses/:id', async (req, res) => {
  // Soft delete: bookings keep their own address snapshot.
  const r = await pool.query('UPDATE addresses SET deleted_at = now() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [idParam(req), req.user!.id]);
  if (!r.rowCount) throw notFound('Address not found.');
  res.status(204).end();
});

// ---------- Wardrobe ----------
const todayIso = () => new Date().toISOString().slice(0, 10);
const hex = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Colour must look like #1F5FA8.');
// Note: no .default() here so that .partial() on PATCH leaves unspecified fields untouched.
const wardrobeFields = {
  categoryId: z.uuid(),
  name: z.string().trim().min(1, 'Please describe the item.').max(80),
  color: z.string().trim().max(40),
  colorHex: hex.nullable(),
  quantity: z.coerce.number().int().min(1).max(100),
  purchaseValue: z.coerce.number().int('Enter a whole number of RWF.').min(0).max(100_000_000).nullable(),
  careNotes: z.string().trim().max(300),
  acquiredOn: z.iso.date('Use a date like 2025-06-30.').nullable().refine((d) => !d || (d >= '1950-01-01' && d <= todayIso()), 'The purchase date cannot be in the future.'),
  location: z.string().trim().max(60),
};
const wardrobeCreateSchema = z.object(wardrobeFields).partial().required({ categoryId: true, name: true });
const wardrobePatchSchema = z.object(wardrobeFields).partial();

export const wardrobeDto = (w: any) => {
  const acquired = w.acquired_on ? new Date(w.acquired_on) : new Date(w.created_at);
  const dep = depreciate({ value: w.purchase_value ?? null, quantity: w.quantity, acquiredOn: acquired, lifespanMonths: w.lifespan_months ?? 36 });
  return {
  id: w.id,
  kind: w.kind,
  categoryId: w.category_id,
  categoryCode: w.category_code,
  name: w.name,
  color: w.color,
  colorHex: w.color_hex ?? null,
  quantity: w.quantity,
  purchaseValue: w.purchase_value ?? null,
  careNotes: w.care_notes,
  hasPhoto: !!w.photo_key,
  photoUrl: w.photo_key ? `/api/v1/me/wardrobe/${w.id}/photo?v=${encodeURIComponent(w.photo_key.slice(-8))}` : null,
  timesCleaned: w.times_cleaned ?? 0,
  lastCleanedAt: w.last_cleaned_at ?? null,
  inCleaning: !!w.in_cleaning,
  acquiredOn: w.acquired_on ? toIsoDate(w.acquired_on) : null,
  location: w.location ?? '',
  depreciation: dep,
  createdAt: w.created_at,
  updatedAt: w.updated_at,
  };
};
const toIsoDate = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);

async function category(id: string) {
  const c = await one(pool, 'SELECT * FROM garment_categories WHERE id = $1 AND active', [id]);
  if (!c) throw badRequest('Please choose a category.');
  return c;
}

/** Cleaning history comes from delivered orders that used this wardrobe item. */
const CLEAN_STATS = `
  LEFT JOIN LATERAL (
    SELECT count(DISTINCT oi.order_id)::int AS times_cleaned, max(o.updated_at) AS last_cleaned_at
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE oi.wardrobe_item_id = w.id AND o.status = 'DELIVERED'
  ) cs ON true
  LEFT JOIN LATERAL (
    SELECT true AS in_cleaning FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE oi.wardrobe_item_id = w.id AND o.status NOT IN ('DELIVERED','CANCELLED') LIMIT 1
  ) ac ON true`;

const listSchema = z.object({
  kind: z.enum(['CLOTHES', 'SHOES']).optional(),
  categoryId: z.uuid().optional(),
  q: z.string().trim().max(60).optional(),
  location: z.string().trim().max(60).optional(),
  replace: z.enum(['true']).optional(),
  sort: z.enum(['recent', 'name', 'value', 'worn']).default('recent'),
});

meRouter.get('/wardrobe', async (req, res) => {
  const { page, pageSize, limit, offset } = pagination(req);
  const f = listSchema.parse(Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== '')));
  const params: unknown[] = [req.user!.id];
  const where = ['w.user_id = $1', 'w.deleted_at IS NULL'];
  if (f.kind) { params.push(f.kind); where.push(`w.kind = $${params.length}`); }
  if (f.categoryId) { params.push(f.categoryId); where.push(`w.category_id = $${params.length}`); }
  if (f.q) { params.push(`%${f.q.replace(/[%_\\]/g, (m) => '\\' + m)}%`); where.push(`(w.name ILIKE $${params.length} OR w.color ILIKE $${params.length})`); }
  if (f.location) { params.push(f.location); where.push(`w.location = $${params.length}`); }
  if (f.replace) where.push(`${REMAINING_SHARE_SQL} <= ${REPLACE_THRESHOLD}`);
  const order =
    f.sort === 'name' ? 'w.name ASC'
    : f.sort === 'value' ? 'w.purchase_value DESC NULLS LAST, w.name'
    : f.sort === 'worn' ? `${REMAINING_SHARE_SQL} ASC, w.name`
    : 'w.updated_at DESC';
  params.push(limit, offset);
  const rows = await q(
    pool,
    `SELECT w.*, c.code AS category_code, c.lifespan_months, cs.times_cleaned, cs.last_cleaned_at, ac.in_cleaning, count(*) OVER()::int AS total
       FROM wardrobe_items w JOIN garment_categories c ON c.id = w.category_id ${CLEAN_STATS}
      WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  // Whole-wardrobe totals (independent of filters) for the summary header, incl. depreciated value.
  const all = await q(
    pool,
    `SELECT w.kind, w.quantity, w.purchase_value, w.acquired_on, w.created_at, w.photo_key, w.location, c.lifespan_months
       FROM wardrobe_items w JOIN garment_categories c ON c.id = w.category_id WHERE w.user_id = $1 AND w.deleted_at IS NULL`,
    [req.user!.id],
  );
  const stats = { items: all.length, pieces: 0, totalValue: 0, currentValue: 0, clothes: 0, shoes: 0, withPhotos: 0, toReplace: 0, locations: [] as string[] };
  const locs = new Set<string>();
  for (const r of all) {
    const d = depreciate({ value: r.purchase_value, quantity: r.quantity, acquiredOn: new Date(r.acquired_on ?? r.created_at), lifespanMonths: r.lifespan_months });
    stats.pieces += r.quantity;
    stats.totalValue += d.totalOriginal ?? 0;
    stats.currentValue += d.totalCurrent ?? 0;
    if (r.kind === 'CLOTHES') stats.clothes++; else stats.shoes++;
    if (r.photo_key) stats.withPhotos++;
    if (d.replaceSuggested) stats.toReplace++;
    if (r.location) locs.add(r.location);
  }
  stats.locations = [...locs].sort((a, b) => a.localeCompare(b));
  res.json({ ...paged(rows.map(wardrobeDto), rows[0]?.total ?? 0, page, pageSize), stats });
});

meRouter.post('/wardrobe', async (req, res) => {
  const b = wardrobeCreateSchema.parse(req.body);
  const c = await category(b.categoryId);
  const count = await one(pool, 'SELECT count(*)::int AS n FROM wardrobe_items WHERE user_id = $1 AND deleted_at IS NULL', [req.user!.id]);
  if (count.n >= 500) throw conflict('LIMIT_REACHED', 'Your wardrobe is full (500 items).');
  const w = await one(
    pool,
    `INSERT INTO wardrobe_items (user_id, kind, category_id, name, color, color_hex, quantity, purchase_value, care_notes, acquired_on, location)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *, $12::text AS category_code, $13::int AS lifespan_months`,
    [req.user!.id, c.kind, c.id, b.name, b.color ?? '', b.colorHex ?? null, b.quantity ?? 1, b.purchaseValue ?? null, b.careNotes ?? '', b.acquiredOn ?? null, b.location ?? '', c.code, c.lifespan_months],
  );
  res.status(201).json({ item: wardrobeDto(w) });
});

async function ownWardrobe(req: express.Request) {
  const w = await one(
    pool,
    `SELECT w.*, c.code AS category_code, c.lifespan_months, cs.times_cleaned, cs.last_cleaned_at, ac.in_cleaning
       FROM wardrobe_items w JOIN garment_categories c ON c.id = w.category_id ${CLEAN_STATS}
      WHERE w.id = $1 AND w.user_id = $2 AND w.deleted_at IS NULL`,
    [idParam(req), req.user!.id],
  );
  if (!w) throw notFound('Wardrobe item not found.');
  return w;
}

meRouter.get('/wardrobe/:id', async (req, res) => {
  res.json({ item: wardrobeDto(await ownWardrobe(req)) });
});

meRouter.patch('/wardrobe/:id', async (req, res) => {
  const cur = await ownWardrobe(req);
  const b = wardrobePatchSchema.parse(req.body);
  const c = b.categoryId ? await category(b.categoryId) : null;
  const pick = <T,>(v: T | undefined, old: T) => (v === undefined ? old : v);
  // Editing never touches order_items: orders hold their own snapshot.
  const w = await one(
    pool,
    `UPDATE wardrobe_items SET kind=$2, category_id=$3, name=$4, color=$5, color_hex=$6, quantity=$7, purchase_value=$8, care_notes=$9,
            acquired_on=$10, location=$11, updated_at=now()
      WHERE id = $1 RETURNING *, $12::text AS category_code, $13::int AS lifespan_months`,
    [cur.id, c?.kind ?? cur.kind, c?.id ?? cur.category_id, pick(b.name, cur.name), pick(b.color, cur.color), pick(b.colorHex, cur.color_hex),
     pick(b.quantity, cur.quantity), pick(b.purchaseValue, cur.purchase_value), pick(b.careNotes, cur.care_notes),
     b.acquiredOn === undefined ? cur.acquired_on : b.acquiredOn, pick(b.location, cur.location), c?.code ?? cur.category_code, c?.lifespan_months ?? cur.lifespan_months],
  );
  res.json({ item: wardrobeDto({ ...w, times_cleaned: cur.times_cleaned, last_cleaned_at: cur.last_cleaned_at, in_cleaning: cur.in_cleaning }) });
});

meRouter.delete('/wardrobe/:id', async (req, res) => {
  const cur = await ownWardrobe(req);
  await pool.query('UPDATE wardrobe_items SET deleted_at = now() WHERE id = $1', [cur.id]);
  await maybeDeletePhoto(cur.photo_key);
  res.status(204).end();
});

/** Delete an object only if no order snapshot references it. */
async function maybeDeletePhoto(key: string | null) {
  if (!key) return;
  const used = await one(pool, 'SELECT 1 FROM order_items WHERE photo_key = $1 LIMIT 1', [key]);
  if (!used) await storage.delete(key).catch(() => {});
}

const PHOTO_QUOTA = 300;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024, files: 1 } });

meRouter.put('/wardrobe/:id/photo', (req, res, next) => {
  if (!storage.configured) return next(new AppError(503, 'PHOTOS_NOT_CONFIGURED', 'Photo upload is not available yet. You can still save the item without a photo.'));
  next();
}, upload.single('photo'), async (req, res) => {
  const cur = await ownWardrobe(req);
  if (!req.file) throw badRequest('Choose a photo to upload.');
  const type = sniffImage(req.file.buffer);
  if (!type) throw badRequest('Photo must be a JPEG, PNG or WebP image.');
  if (!cur.photo_key) {
    const n = await one(pool, 'SELECT count(*)::int AS n FROM wardrobe_items WHERE user_id = $1 AND deleted_at IS NULL AND photo_key IS NOT NULL', [req.user!.id]);
    if (n.n >= PHOTO_QUOTA) throw conflict('PHOTO_LIMIT', `You can keep up to ${PHOTO_QUOTA} photos. Remove one to add another.`);
  }
  const key = `wardrobe/${req.user!.id}/${cur.id}-${crypto.randomBytes(6).toString('hex')}`;
  await storage.put(key, req.file.buffer, type, req.user!.id);
  await pool.query('UPDATE wardrobe_items SET photo_key = $2, updated_at = now() WHERE id = $1', [cur.id, key]);
  await maybeDeletePhoto(cur.photo_key);
  res.json({ item: wardrobeDto({ ...cur, photo_key: key }) });
});

meRouter.delete('/wardrobe/:id/photo', async (req, res) => {
  const cur = await ownWardrobe(req);
  await pool.query('UPDATE wardrobe_items SET photo_key = NULL, updated_at = now() WHERE id = $1', [cur.id]);
  await maybeDeletePhoto(cur.photo_key);
  res.status(204).end();
});

meRouter.get('/wardrobe/:id/photo', async (req, res) => {
  const cur = await ownWardrobe(req); // ownership check before any access
  if (!cur.photo_key) throw notFound('No photo.');
  await sendPhoto(res, cur.photo_key);
});

export async function sendPhoto(res: express.Response, key: string) {
  const obj = await storage.get(key);
  if (!obj) throw notFound('Photo unavailable.');
  res.set('Cache-Control', 'private, max-age=86400');
  if ('url' in obj) return res.redirect(302, obj.url);
  res.type(obj.contentType).send(obj.body);
}

// ---------- Notifications ----------
meRouter.get('/notifications', async (req, res) => {
  const { page, pageSize, limit, offset } = pagination(req);
  const rows = await q(
    pool,
    `SELECT id, type, title, body, order_id, read_at, created_at, count(*) OVER()::int AS total
       FROM notifications WHERE user_id = $1 AND channel = 'IN_APP' ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [req.user!.id, limit, offset],
  );
  const unread = await one(pool, `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND channel='IN_APP' AND read_at IS NULL`, [req.user!.id]);
  res.json({
    ...paged(rows.map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, orderId: n.order_id, readAt: n.read_at, createdAt: n.created_at })), rows[0]?.total ?? 0, page, pageSize),
    unread: unread.n,
  });
});

meRouter.post('/notifications/read-all', async (req, res) => {
  await pool.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user!.id]);
  res.status(204).end();
});
