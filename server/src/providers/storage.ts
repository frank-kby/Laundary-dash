import fs from 'node:fs/promises';
import path from 'node:path';
import { AwsClient } from 'aws4fetch';
import { config } from '../config.js';
import { pool } from '../db.js';

/**
 * Private photo storage. Objects are never public: the API checks ownership and then either
 * redirects to a short-lived signed URL (S3/R2) or streams the bytes (local dev).
 */
export interface PhotoStorage {
  readonly kind: 'none' | 'local' | 's3' | 'db';
  readonly configured: boolean;
  put(key: string, body: Buffer, contentType: string, ownerId?: string): Promise<void>;
  /** Either a signed URL to redirect to, or the bytes to stream. */
  get(key: string): Promise<{ url: string } | { body: Buffer; contentType: string } | null>;
  delete(key: string): Promise<void>;
}

class NoStorage implements PhotoStorage {
  readonly kind = 'none' as const;
  readonly configured = false;
  async put() {
    throw new Error('Photo storage is not configured');
  }
  async get() {
    return null;
  }
  async delete() {}
}

class LocalStorage implements PhotoStorage {
  readonly kind = 'local' as const;
  readonly configured = true;
  constructor(private dir: string) {}
  private file(key: string) {
    if (!/^[a-zA-Z0-9/_\-.]+$/.test(key) || key.includes('..')) throw new Error('bad key');
    return path.join(this.dir, key);
  }
  async put(key: string, body: Buffer, contentType: string) {
    const f = this.file(key);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, body);
    await fs.writeFile(f + '.type', contentType);
  }
  async get(key: string) {
    try {
      const f = this.file(key);
      return { body: await fs.readFile(f), contentType: await fs.readFile(f + '.type', 'utf8') };
    } catch {
      return null;
    }
  }
  async delete(key: string) {
    const f = this.file(key);
    await fs.rm(f, { force: true });
    await fs.rm(f + '.type', { force: true });
  }
}

/** S3-compatible (Cloudflare R2). Bucket must be private (no public r2.dev access). */
class S3Storage implements PhotoStorage {
  readonly kind = 's3' as const;
  readonly configured = true;
  private client = new AwsClient({
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    service: 's3',
    region: config.S3_REGION,
  });
  private url(key: string) {
    return `${config.S3_ENDPOINT.replace(/\/$/, '')}/${config.S3_BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }
  async put(key: string, body: Buffer, contentType: string) {
    const r = await this.client.fetch(this.url(key), { method: 'PUT', body: new Uint8Array(body), headers: { 'Content-Type': contentType } });
    if (!r.ok) throw new Error(`Photo upload failed (${r.status})`);
  }
  async get(key: string) {
    const u = new URL(this.url(key));
    u.searchParams.set('X-Amz-Expires', '300'); // 5 minutes
    const signed = await this.client.sign(u.toString(), { method: 'GET', aws: { signQuery: true } });
    return { url: signed.url };
  }
  async delete(key: string) {
    await this.client.fetch(this.url(key), { method: 'DELETE' });
  }
}

/**
 * Photos stored in PostgreSQL. Works on free hosting with no extra account. Photos are compressed on the
 * device first (~60–100 KB each), so Neon's 1 GB free tier holds thousands. Move to S3/R2 when volume grows.
 */
class DbStorage implements PhotoStorage {
  readonly kind = 'db' as const;
  readonly configured = true;
  async put(key: string, body: Buffer, contentType: string, ownerId?: string) {
    await pool.query(
      `INSERT INTO stored_photos (key, user_id, content_type, bytes, size) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (key) DO UPDATE SET bytes = EXCLUDED.bytes, content_type = EXCLUDED.content_type, size = EXCLUDED.size`,
      [key, ownerId ?? null, contentType, body, body.length],
    );
  }
  async get(key: string) {
    const r = await pool.query('SELECT content_type, bytes FROM stored_photos WHERE key = $1', [key]);
    return r.rows[0] ? { body: r.rows[0].bytes as Buffer, contentType: r.rows[0].content_type as string } : null;
  }
  async delete(key: string) {
    await pool.query('DELETE FROM stored_photos WHERE key = $1', [key]);
  }
}

export const storage: PhotoStorage =
  config.PHOTO_STORAGE === 's3'
    ? new S3Storage()
    : config.PHOTO_STORAGE === 'db'
      ? new DbStorage()
      : config.PHOTO_STORAGE === 'local'
        ? new LocalStorage(config.LOCAL_UPLOAD_DIR)
        : new NoStorage();

/** Detects image type from magic bytes; never trust the client's Content-Type. */
export function sniffImage(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}
