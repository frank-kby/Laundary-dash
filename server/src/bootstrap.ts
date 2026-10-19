/**
 * Self-setup for hosts without a shell (Render free tier has no shell or one-off jobs).
 * All steps are idempotent and safe to run on every start.
 */
import { one, pool } from './db.js';
import { normalizeEmail, normalizePhone } from './identifiers.js';
import { log } from './log.js';
import { generateSlots } from './routes/admin.js';
import { hashPassword } from './routes/auth.js';
import { seedCatalogue } from './seed.js';

/** Seeds the starter catalogue only on an empty database, so later admin edits are never overwritten. */
export async function seedCatalogueIfEmpty() {
  const has = await one(pool, 'SELECT 1 FROM services LIMIT 1');
  if (has) return false;
  await seedCatalogue();
  log.info('catalogue_seeded', { note: 'SAMPLE prices — review in Staff > Settings' });
  return true;
}

/**
 * Creates the first ADMIN from env vars, only if no admin exists yet. It never changes an existing account,
 * so leaving the variables set cannot reset anyone's password. Remove BOOTSTRAP_ADMIN_PASSWORD after first sign-in.
 */
export async function bootstrapAdmin(env = process.env) {
  const pw = env.BOOTSTRAP_ADMIN_PASSWORD ?? '';
  const email = env.BOOTSTRAP_ADMIN_EMAIL ? normalizeEmail(env.BOOTSTRAP_ADMIN_EMAIL) : null;
  const phone = env.BOOTSTRAP_ADMIN_PHONE ? normalizePhone(env.BOOTSTRAP_ADMIN_PHONE) : null;
  if (!pw && !email && !phone) return 'skipped';
  const admin = await one(pool, `SELECT 1 FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE' LIMIT 1`);
  if (admin) return 'exists';
  if ((!email && !phone) || pw.length < 12) {
    log.warn('bootstrap_admin_invalid', { reason: 'Need BOOTSTRAP_ADMIN_EMAIL or _PHONE and a BOOTSTRAP_ADMIN_PASSWORD of 12+ chars' });
    return 'invalid';
  }
  const taken = await one(pool, 'SELECT id FROM users WHERE email = $1 OR phone = $2', [email, phone]);
  if (taken) {
    log.warn('bootstrap_admin_conflict', { reason: 'That email/phone already belongs to an account; not changed' });
    return 'conflict';
  }
  const u = await one(
    pool,
    `INSERT INTO users (full_name, email, phone, password_hash, role) VALUES ($1,$2,$3,$4,'ADMIN') RETURNING id`,
    [env.BOOTSTRAP_ADMIN_NAME || 'Administrator', email, phone, await hashPassword(pw)],
  );
  await pool.query(`INSERT INTO audit_logs (action, entity_type, entity_id, after_data) VALUES ('user.bootstrap_admin','user',$1,$2)`, [
    u.id, JSON.stringify({ email, phone }),
  ]);
  log.info('bootstrap_admin_created', {});
  return 'created';
}

let lastSlotTopUp = 0;
/**
 * Keeps pickup slots available N days ahead using default hours (AUTO_SLOT_DAYS, 0 = off).
 * Existing slots — including ones staff closed or resized — are never touched.
 */
export async function topUpSlots(env = process.env, force = false) {
  const days = Number(env.AUTO_SLOT_DAYS ?? 0);
  if (!(days > 0)) return 0;
  if (!force && Date.now() - lastSlotTopUp < 12 * 3600_000) return 0;
  lastSlotTopUp = Date.now();
  const created = await generateSlots({
    days: Math.min(days, 31),
    startHour: Number(env.AUTO_SLOT_START_HOUR ?? 8),
    endHour: Number(env.AUTO_SLOT_END_HOUR ?? 18),
    slotMinutes: Number(env.AUTO_SLOT_MINUTES ?? 120),
    capacity: Number(env.AUTO_SLOT_CAPACITY ?? 4),
    weekdays: (env.AUTO_SLOT_WEEKDAYS ?? '1,2,3,4,5,6').split(',').map(Number),
  });
  if (created) log.info('slots_topped_up', { created });
  return created;
}
