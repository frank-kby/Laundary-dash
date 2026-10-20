import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  /** Public origin of the app, e.g. https://laundry-dash.onrender.com. Used for CSRF origin checks and email links. */
  APP_ORIGIN: z.string().url().default('http://localhost:5173'),
  /** Extra allowed origins (comma separated) — e.g. the Vite dev server. */
  EXTRA_ALLOWED_ORIGINS: z.string().default(''),
  TRUST_PROXY: z.coerce.number().default(0),
  DATABASE_SSL: bool.default(false),

  SESSION_IDLE_HOURS: z.coerce.number().default(12),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().default(24),
  SESSION_PERSISTENT_DAYS: z.coerce.number().default(30),

  // Email (password reset + transactional). none | console (dev only) | resend
  EMAIL_PROVIDER: z.enum(['none', 'console', 'resend']).default('none'),
  EMAIL_FROM: z.string().default(''),
  RESEND_API_KEY: z.string().default(''),

  // Photo storage. none | db (PostgreSQL, free-tier friendly) | local (dev only) | s3 (Cloudflare R2 / S3-compatible)
  PHOTO_STORAGE: z.enum(['none', 'db', 'local', 's3']).default('none'),
  LOCAL_UPLOAD_DIR: z.string().default('./data/uploads'),
  S3_ENDPOINT: z.string().default(''),
  S3_BUCKET: z.string().default(''),
  S3_REGION: z.string().default('auto'),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),

  // Mobile Money. none | simulator (TEST MODE, no real money) | mtn_momo
  PAYMENT_PROVIDER: z.enum(['none', 'simulator', 'mtn_momo']).default('none'),
  PAYMENT_WEBHOOK_SECRET: z.string().default(''),
  MTN_MOMO_BASE_URL: z.string().default('https://sandbox.momodeveloper.mtn.com'),
  MTN_MOMO_TARGET_ENV: z.string().default('sandbox'),
  MTN_MOMO_SUBSCRIPTION_KEY: z.string().default(''),
  MTN_MOMO_API_USER: z.string().default(''),
  MTN_MOMO_API_KEY: z.string().default(''),
  MTN_MOMO_CURRENCY: z.string().default('RWF'),

  SUPPORT_PHONE: z.string().default('+250780000000'),
  SUPPORT_WHATSAPP: z.string().default('250780000000'),
  BUSINESS_TIMEZONE: z.string().default('Africa/Kigali'),
});

export type Config = z.infer<typeof schema>;

function load(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Print only the variable names, never values.
    const names = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment configuration: ${names}`);
  }
  const c = parsed.data;
  if (c.NODE_ENV === 'production') {
    if (c.EMAIL_PROVIDER === 'console') throw new Error('EMAIL_PROVIDER=console is not allowed in production');
    if (c.PHOTO_STORAGE === 'local') throw new Error('PHOTO_STORAGE=local is not allowed in production (no persistent disk on free hosts)');
    if (!c.APP_ORIGIN.startsWith('https://')) throw new Error('APP_ORIGIN must be https in production');
  }
  if (c.PAYMENT_PROVIDER !== 'none' && c.PAYMENT_WEBHOOK_SECRET.length < 16) {
    throw new Error('PAYMENT_WEBHOOK_SECRET (>=16 chars) is required when a payment provider is enabled');
  }
  if (c.EMAIL_PROVIDER === 'resend' && (!c.RESEND_API_KEY || !c.EMAIL_FROM)) {
    throw new Error('RESEND_API_KEY and EMAIL_FROM are required for EMAIL_PROVIDER=resend');
  }
  if (c.PHOTO_STORAGE === 's3' && (!c.S3_ENDPOINT || !c.S3_BUCKET || !c.S3_ACCESS_KEY_ID || !c.S3_SECRET_ACCESS_KEY)) {
    throw new Error('S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY are required for PHOTO_STORAGE=s3');
  }
  return c;
}

export const config: Config = load();
export const isProd = config.NODE_ENV === 'production';
export const allowedOrigins = new Set(
  [config.APP_ORIGIN, ...config.EXTRA_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)].map((o) =>
    o.replace(/\/$/, ''),
  ),
);
