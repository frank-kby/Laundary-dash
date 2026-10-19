import type { Request, RequestHandler, Response } from 'express';
import { config, isProd } from '../config.js';
import { one, pool, type Db } from '../db.js';
import { forbidden, unauthorized } from '../errors.js';
import { randomToken, sha256 } from '../security.js';

export const SESSION_COOKIE = isProd ? '__Host-ld_sid' : 'ld_sid'; // __Host- prefix forces Secure, Path=/, no Domain

export type Role = 'CUSTOMER' | 'RIDER' | 'STAFF' | 'ADMIN';
export interface AuthUser {
  id: string;
  role: Role;
  fullName: string;
  email: string | null;
  phone: string | null;
  preferredLanguage: 'en' | 'rw';
  sessionId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const HOUR = 3600_000;

function cookieOptions(persistent: boolean) {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax' as const,
    path: '/',
    ...(persistent ? { maxAge: config.SESSION_PERSISTENT_DAYS * 24 * HOUR } : {}), // otherwise a browser-session cookie
  };
}

/** Creates a server-side session and sets the cookie. The raw token exists only in the cookie. */
export async function createSession(db: Db, res: Response, userId: string, persistent: boolean, userAgent?: string) {
  const token = randomToken(32);
  const now = Date.now();
  const idle = persistent ? config.SESSION_PERSISTENT_DAYS * 24 * HOUR : config.SESSION_IDLE_HOURS * HOUR;
  const absolute = persistent ? config.SESSION_PERSISTENT_DAYS * 24 * HOUR : config.SESSION_ABSOLUTE_HOURS * HOUR;
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, persistent, idle_expires_at, absolute_expires_at, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [sha256(token), userId, persistent, new Date(now + idle), new Date(now + absolute), (userAgent ?? '').slice(0, 200)],
  );
  res.cookie(SESSION_COOKIE, token, cookieOptions(persistent));
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: isProd, sameSite: 'lax', path: '/' });
}

export async function destroySession(db: Db, req: Request, res: Response) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  clearSessionCookie(res);
}

export async function destroyAllSessionsForUser(db: Db, userId: string) {
  await db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

/** Resolves the session cookie on every request; slides idle expiry (throttled to once a minute). */
export const loadSession: RequestHandler = async (req, res, next) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token || typeof token !== 'string' || token.length > 100) return next();
  const row = await one(
    pool,
    `SELECT s.id AS session_id, s.persistent, s.last_seen_at, s.idle_expires_at, s.absolute_expires_at,
            u.id, u.role, u.full_name, u.email, u.phone, u.preferred_language, u.status
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1`,
    [sha256(token)],
  );
  const now = new Date();
  if (!row || row.status !== 'ACTIVE' || row.idle_expires_at < now || row.absolute_expires_at < now) {
    if (row) await pool.query('DELETE FROM sessions WHERE id = $1', [row.session_id]);
    clearSessionCookie(res);
    return next();
  }
  if (now.getTime() - new Date(row.last_seen_at).getTime() > 60_000) {
    const idle = row.persistent ? config.SESSION_PERSISTENT_DAYS * 24 * HOUR : config.SESSION_IDLE_HOURS * HOUR;
    const newIdle = new Date(Math.min(now.getTime() + idle, new Date(row.absolute_expires_at).getTime()));
    await pool.query('UPDATE sessions SET last_seen_at = now(), idle_expires_at = $2 WHERE id = $1', [row.session_id, newIdle]);
  }
  req.user = {
    id: row.id,
    role: row.role,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    preferredLanguage: row.preferred_language,
    sessionId: row.session_id,
  };
  next();
};

export const requireAuth: RequestHandler = (req, _res, next) => (req.user ? next() : next(unauthorized()));

export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}

/** Removes expired sessions/reset tokens. Called opportunistically (free hosts have no cron). */
export async function purgeExpired(db: Db) {
  await db.query('DELETE FROM sessions WHERE idle_expires_at < now() OR absolute_expires_at < now()');
  await db.query(`DELETE FROM password_reset_tokens WHERE expires_at < now() - interval '7 days'`);
}
