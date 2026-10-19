import type { Db } from './db.js';

export async function audit(
  db: Db,
  entry: {
    actorId: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    before?: unknown;
    after?: unknown;
    ip?: string | null;
  },
) {
  await db.query(
    `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, before_data, after_data, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      entry.actorId,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.ip ?? null,
    ],
  );
}
