/**
 * Creates (or promotes) the first real ADMIN account. Credentials come from environment variables so the
 * password never appears in shell history arguments:
 *   ADMIN_NAME="Jane" ADMIN_EMAIL=jane@example.com ADMIN_PASSWORD='...' npm run create-admin
 */
import { pool, one } from './db.js';
import { normalizeEmail, normalizePhone } from './identifiers.js';
import { hashPassword, passwordSchema } from './routes/auth.js';

const name = process.env.ADMIN_NAME ?? 'Administrator';
const email = process.env.ADMIN_EMAIL ? normalizeEmail(process.env.ADMIN_EMAIL) : null;
const phone = process.env.ADMIN_PHONE ? normalizePhone(process.env.ADMIN_PHONE) : null;
const pw = passwordSchema.safeParse(process.env.ADMIN_PASSWORD ?? '');

(async () => {
  if (!email && !phone) throw new Error('Set ADMIN_EMAIL or ADMIN_PHONE');
  if (!pw.success || pw.data.length < 12) throw new Error('Set ADMIN_PASSWORD (at least 12 characters)');
  const hash = await hashPassword(pw.data);
  const existing = await one(pool, 'SELECT id FROM users WHERE email = $1 OR phone = $2', [email, phone]);
  if (existing) {
    await pool.query(`UPDATE users SET role = 'ADMIN', password_hash = $2, status = 'ACTIVE' WHERE id = $1`, [existing.id, hash]);
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [existing.id]);
    console.log('Existing account promoted to ADMIN and password updated.');
  } else {
    await pool.query(`INSERT INTO users (full_name, email, phone, password_hash, role) VALUES ($1,$2,$3,$4,'ADMIN')`, [name, email, phone, hash]);
    console.log('ADMIN account created.');
  }
  await pool.query(`INSERT INTO audit_logs (action, entity_type, after_data) VALUES ('user.bootstrap_admin','user',$1)`, [JSON.stringify({ email, phone })]);
  await pool.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
