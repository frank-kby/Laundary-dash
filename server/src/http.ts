import type { Request, Response } from 'express';
import { z } from 'zod';
import { one, pool } from './db.js';
import { AppError, badRequest, conflict } from './errors.js';
import { sha256 } from './security.js';

export const uuid = z.uuid();
export function idParam(req: Request, name = 'id'): string {
  const r = uuid.safeParse(req.params[name]);
  if (!r.success) throw new AppError(404, 'NOT_FOUND', 'Not found.');
  return r.data;
}

const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export function pagination(req: Request) {
  const { page, pageSize } = pageSchema.parse(req.query);
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}
export const paged = <T>(items: T[], total: number, page: number, pageSize: number) => ({ items, page, pageSize, total });

/**
 * Idempotency-Key handling for "create" endpoints (bookings, payments). A retried submission with the
 * same key returns the original response instead of creating a duplicate. Same key + different body = 422.
 */
export async function idempotent(
  req: Request,
  res: Response,
  endpoint: string,
  handler: () => Promise<{ status: number; body: unknown }>,
) {
  const key = req.get('Idempotency-Key');
  if (!key || key.length < 8 || key.length > 100) throw badRequest('Idempotency-Key header (8–100 chars) is required.');
  const userId = req.user!.id;
  const hash = sha256(JSON.stringify(req.body ?? {}));
  const ins = await pool.query(
    `INSERT INTO idempotency_records (key, user_id, endpoint, request_hash) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [key, userId, endpoint, hash],
  );
  if (ins.rowCount === 0) {
    const rec = await one(pool, 'SELECT * FROM idempotency_records WHERE key = $1 AND user_id = $2 AND endpoint = $3', [key, userId, endpoint]);
    if (rec.request_hash !== hash) throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different request.');
    if (rec.status_code === null) throw conflict('REQUEST_IN_PROGRESS', 'Your previous attempt is still being processed. Please wait a moment.');
    res.set('Idempotent-Replayed', 'true');
    res.status(rec.status_code).json(rec.response_body);
    return;
  }
  try {
    const out = await handler();
    await pool.query('UPDATE idempotency_records SET status_code = $4, response_body = $5 WHERE key = $1 AND user_id = $2 AND endpoint = $3', [
      key, userId, endpoint, out.status, JSON.stringify(out.body),
    ]);
    res.status(out.status).json(out.body);
  } catch (e) {
    // Failed attempts don't occupy the key, so the user can correct the form and retry.
    await pool.query('DELETE FROM idempotency_records WHERE key = $1 AND user_id = $2 AND endpoint = $3', [key, userId, endpoint]);
    throw e;
  }
}
