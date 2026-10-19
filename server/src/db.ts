import pg from 'pg';
import { config } from './config.js';

// Return numeric columns as JS numbers (amounts are integers in RWF; kg values are small).
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  ssl: config.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
  max: 5, // free-tier friendly
  idleTimeoutMillis: 30_000,
});

export type Db = pg.Pool | pg.PoolClient;

export async function q<T extends pg.QueryResultRow = any>(db: Db, text: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.query<T>(text, params);
  return r.rows;
}

export async function one<T extends pg.QueryResultRow = any>(db: Db, text: string, params: unknown[] = []): Promise<T | undefined> {
  const r = await db.query<T>(text, params);
  return r.rows[0];
}

/** Run fn inside a transaction. Retries once on serialization failure / deadlock. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      if (attempt === 0 && (err?.code === '40001' || err?.code === '40P01')) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}
