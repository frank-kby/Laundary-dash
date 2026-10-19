import crypto from 'node:crypto';
import type { RequestHandler } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { allowedOrigins, config } from './config.js';
import { AppError } from './errors.js';

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * CSRF defence for cookie-authenticated, state-changing requests:
 *  1. Session cookie is SameSite=Lax (set in auth/session.ts).
 *  2. A custom header is required. Browsers cannot attach custom headers cross-origin without a
 *     CORS preflight, and this API never grants cross-origin CORS.
 *  3. If an Origin header is present it must be one of ours.
 * Provider webhooks are exempt (they authenticate with a signature/secret instead).
 */
export const csrfProtection: RequestHandler = (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // originalUrl, not path: this middleware is mounted under /api, where req.path is mount-relative.
  if (req.originalUrl.startsWith('/api/v1/payments/webhooks/')) return next();
  if (req.get('X-Requested-With') !== 'LaundryDash') {
    return next(new AppError(403, 'CSRF_REJECTED', 'Request blocked for security reasons. Please reload the page.'));
  }
  const origin = req.get('Origin');
  if (origin && !allowedOrigins.has(origin.replace(/\/$/, ''))) {
    return next(new AppError(403, 'CSRF_REJECTED', 'Request origin not allowed.'));
  }
  next();
};

/** Private API responses must never be stored by shared caches, the service worker, or the browser. */
export const noStore: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'no-store, private');
  res.set('Pragma', 'no-cache');
  next();
};

const limiterBase = {
  standardHeaders: 'draft-8' as const,
  legacyHeaders: false,
  skip: () => config.NODE_ENV === 'test' && process.env.ENABLE_RATE_LIMIT_IN_TEST !== 'true',
  handler: (_req: any, res: any) =>
    res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a few minutes and try again.' } }),
};

/** Per IP+identifier, so one attacker can't lock everyone out and one account can't be brute-forced. */
export const loginLimiter = rateLimit({
  ...limiterBase,
  windowMs: 15 * 60_000,
  limit: 10,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? '')}|${String(req.body?.identifier ?? '').trim().toLowerCase()}`,
});
export const authIpLimiter = rateLimit({ ...limiterBase, windowMs: 15 * 60_000, limit: 50 });
export const resetLimiter = rateLimit({ ...limiterBase, windowMs: 60 * 60_000, limit: 5 });
export const apiLimiter = rateLimit({ ...limiterBase, windowMs: 60_000, limit: 300 });
export const webhookLimiter = rateLimit({ ...limiterBase, windowMs: 60_000, limit: 120 });
