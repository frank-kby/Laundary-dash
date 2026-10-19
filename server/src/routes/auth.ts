import { hash, verify } from '@node-rs/argon2';
import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { one, pool, tx } from '../db.js';
import { AppError, badRequest, conflict, unauthorized } from '../errors.js';
import { normalizeEmail, normalizePhone, parseIdentifier } from '../identifiers.js';
import { log } from '../log.js';
import { email } from '../providers/email.js';
import { authIpLimiter, loginLimiter, randomToken, resetLimiter, sha256 } from '../security.js';
import { createSession, destroyAllSessionsForUser, destroySession, purgeExpired } from '../auth/session.js';

// Argon2id, OWASP-recommended baseline parameters (19 MiB, t=2, p=1).
const HASH_OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
export const hashPassword = (pw: string) => hash(pw, HASH_OPTS);
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPassword('dummy-password-for-timing-equalisation'));

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters.')
  .max(128, 'Password must be at most 128 characters.')
  .refine((p) => !/^(.)\1+$/.test(p), 'Password is too simple.');

const RESET_TTL_MIN = 30;

export function userDto(u: any) {
  return {
    id: u.id,
    fullName: u.full_name,
    email: u.email,
    phone: u.phone,
    role: u.role,
    preferredLanguage: u.preferred_language,
    isDemo: u.is_demo,
    createdAt: u.created_at,
  };
}

export const authRouter = Router();
authRouter.use(authIpLimiter);

const registerSchema = z.object({
  fullName: z.string().trim().min(2, 'Please enter your name.').max(100),
  email: z.string().trim().max(254).optional().or(z.literal('')),
  phone: z.string().trim().max(20).optional().or(z.literal('')),
  password: passwordSchema,
  preferredLanguage: z.enum(['en', 'rw']).default('en'),
  keepMeLoggedIn: z.boolean().default(false),
});

authRouter.post('/register', async (req, res) => {
  const body = registerSchema.parse(req.body);
  const emailN = body.email ? normalizeEmail(body.email) : null;
  const phoneN = body.phone ? normalizePhone(body.phone) : null;
  if (body.email && !emailN) throw badRequest('Please enter a valid email address.', [{ path: 'email', message: 'invalid' }]);
  if (body.phone && !phoneN) throw badRequest('Please enter a valid phone number, e.g. 078 123 4567.', [{ path: 'phone', message: 'invalid' }]);
  if (!emailN && !phoneN) throw badRequest('Enter an email address or a phone number.');

  const passwordHash = await hashPassword(body.password);
  try {
    const user = await tx(async (c) => {
      const u = await one(
        c,
        `INSERT INTO users (email, phone, password_hash, full_name, preferred_language)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [emailN, phoneN, passwordHash, body.fullName, body.preferredLanguage],
      );
      await createSession(c, res, u.id, body.keepMeLoggedIn, req.get('user-agent'));
      await audit(c, { actorId: u.id, action: 'user.register', entityType: 'user', entityId: u.id, ip: req.ip });
      return u;
    });
    res.status(201).json({ user: userDto(user) });
  } catch (e: any) {
    if (e?.code === '23505') {
      // Unavoidable for sign-up UX, but phrased neutrally and rate limited.
      throw conflict('ACCOUNT_EXISTS', 'An account with this email or phone may already exist. Try signing in or resetting your password.');
    }
    throw e;
  }
});

const loginSchema = z.object({
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(128),
  keepMeLoggedIn: z.boolean().default(false),
});

authRouter.post('/login', loginLimiter, async (req, res) => {
  const body = loginSchema.parse(req.body);
  const id = parseIdentifier(body.identifier);
  const user = id
    ? await one(pool, `SELECT * FROM users WHERE ${id.type === 'email' ? 'email' : 'phone'} = $1`, [id.value])
    : undefined;
  // Always verify against *something* so response time doesn't reveal whether the account exists.
  const ok = await verify(user?.password_hash ?? (await getDummyHash()), body.password).catch(() => false);
  if (!user || !ok || user.status !== 'ACTIVE') {
    log.info('login_failed', { identifierType: id?.type ?? 'invalid' });
    throw unauthorized('Incorrect email/phone or password.');
  }
  await createSession(pool, res, user.id, body.keepMeLoggedIn, req.get('user-agent'));
  if (Math.random() < 0.05) purgeExpired(pool).catch(() => {});
  res.json({ user: userDto(user) });
});

authRouter.post('/logout', async (req, res) => {
  await destroySession(pool, req, res);
  res.status(204).end();
});

const resetRequestSchema = z.object({ email: z.string().trim().max(254) });

authRouter.post('/password-reset/request', resetLimiter, async (req, res) => {
  const { email: raw } = resetRequestSchema.parse(req.body);
  const generic = {
    message: 'If an account with that email exists, we have sent a reset link. It expires in 30 minutes.',
    emailConfigured: email.configured,
  };
  if (!email.configured) {
    // Be honest that email isn't set up, without revealing anything about accounts.
    res.status(202).json({ ...generic, message: 'Email password reset is not available yet. Please contact support on WhatsApp or phone.' });
    return;
  }
  const e = normalizeEmail(raw);
  const user = e ? await one(pool, `SELECT id, preferred_language FROM users WHERE email = $1 AND status = 'ACTIVE'`, [e]) : undefined;
  if (user) {
    const link = await issueResetToken(user.id, null);
    const rw = user.preferred_language === 'rw';
    // Fire and forget so response timing is similar for existing and missing accounts.
    email
      .send({
        to: e!,
        subject: rw ? 'Laundry Dash: Hindura ijambo ry’ibanga' : 'Laundry Dash: reset your password',
        text: rw
          ? `Kanda kuri iyi link uhindure ijambo ry’ibanga (irangira mu minota ${RESET_TTL_MIN}, ikoreshwa rimwe):\n${link}\n\nNiba atari wowe wabisabye, wirengagize ubu butumwa.`
          : `Use this link to choose a new password (expires in ${RESET_TTL_MIN} minutes, single use):\n${link}\n\nIf you did not ask for this, you can ignore this email.`,
      })
      .catch(() => {});
  }
  res.status(202).json(generic);
});

/** Creates a single-use token (stored hashed) and returns the link. Invalidates older unused tokens. */
export async function issueResetToken(userId: string, issuedBy: string | null): Promise<string> {
  const token = randomToken(32);
  await pool.query('UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId]);
  await pool.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_by) VALUES ($1,$2, now() + ($3 || ' minutes')::interval, $4)`,
    [userId, sha256(token), String(RESET_TTL_MIN), issuedBy],
  );
  return `${config.APP_ORIGIN}/reset-password#token=${token}`; // fragment: not sent to servers/logs/referrers
}

const resetConfirmSchema = z.object({ token: z.string().min(20).max(100), password: passwordSchema });

authRouter.post('/password-reset/confirm', resetLimiter, async (req, res) => {
  const body = resetConfirmSchema.parse(req.body);
  const newHash = await hashPassword(body.password);
  await tx(async (c) => {
    // Atomic claim: only one request can mark an unexpired token as used.
    const t = await one(
      c,
      `UPDATE password_reset_tokens SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING user_id`,
      [sha256(body.token)],
    );
    if (!t) throw new AppError(400, 'RESET_TOKEN_INVALID', 'This reset link is invalid or has expired. Please request a new one.');
    await c.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [t.user_id, newHash]);
    await destroyAllSessionsForUser(c, t.user_id); // sign out everywhere
    await audit(c, { actorId: t.user_id, action: 'user.password_reset', entityType: 'user', entityId: t.user_id, ip: req.ip });
  });
  res.json({ message: 'Password updated. Please sign in with your new password.' });
});
