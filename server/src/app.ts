import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';
import { config, isProd } from './config.js';
import { pool } from './db.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { loadSession } from './auth/session.js';
import { apiLimiter, csrfProtection, noStore, webhookLimiter } from './security.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { bookingsRouter } from './routes/bookings.js';
import { catalogRouter } from './routes/catalog.js';
import { meRouter } from './routes/me.js';
import { ordersRouter } from './routes/orders.js';
import { paymentsRouter } from './routes/payments.js';
import { riderRouter } from './routes/rider.js';
import { expireSubscriptions, plansRouter, subscriptionsRouter } from './routes/subscriptions.js';
import { topUpSlots } from './bootstrap.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const openapiPath = path.resolve(here, '../openapi.yaml');
const webDist = path.resolve(here, '../../web/dist');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY) app.set('trust proxy', config.TRUST_PROXY);

  const s3Origin = config.PHOTO_STORAGE === 's3' && config.S3_ENDPOINT ? new URL(config.S3_ENDPOINT).origin : null;
  const strictHelmet = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:', ...(s3Origin ? [s3Origin] : [])],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(isProd ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    strictTransportSecurity: isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginEmbedderPolicy: false,
  });

  // Force HTTPS behind the host's proxy.
  if (isProd) {
    app.use((req, res, next) => (req.get('x-forwarded-proto') === 'http' ? res.redirect(301, `https://${req.get('host')}${req.originalUrl}`) : next()));
  }

  app.get('/healthz', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  // API docs (relaxed CSP only on this path because Swagger UI needs inline styles).
  if (fs.existsSync(openapiPath)) {
    const spec = YAML.parse(fs.readFileSync(openapiPath, 'utf8'));
    app.get('/api/v1/openapi.json', (_req, res) => res.json(spec));
    app.use('/api/docs', helmet({ contentSecurityPolicy: { directives: { 'script-src': ["'self'"], 'style-src': ["'self'", "'unsafe-inline'"], 'img-src': ["'self'", 'data:'] } } }), swaggerUi.serve, swaggerUi.setup(spec, { customSiteTitle: 'Laundry Dash API' }));
  }

  app.use(strictHelmet);

  // Webhooks need the raw body for signature verification — mount before the JSON parser.
  app.use('/api/v1/payments/webhooks', webhookLimiter, express.raw({ type: '*/*', limit: '64kb' }));

  app.use('/api', noStore, express.json({ limit: '100kb' }), cookieParser(), apiLimiter, csrfProtection, loadSession);

  // Opportunistic housekeeping (free hosts have no cron).
  let lastHousekeeping = 0;
  app.use('/api', (_req, _res, next) => {
    if (Date.now() - lastHousekeeping > 10 * 60_000) {
      lastHousekeeping = Date.now();
      expireSubscriptions().catch(() => {});
      topUpSlots().catch(() => {}); // at most twice a day; no-op unless AUTO_SLOT_DAYS > 0
    }
    next();
  });

  const v1 = express.Router();
  v1.use('/auth', authRouter);
  v1.use('/me', meRouter);
  v1.use('/', catalogRouter); // /config, /services, /service-areas, /pickup-slots
  v1.use('/bookings', bookingsRouter);
  v1.use('/orders', ordersRouter);
  v1.use('/subscription-plans', plansRouter);
  v1.use('/subscriptions', subscriptionsRouter);
  v1.use('/payments', paymentsRouter);
  v1.use('/admin', adminRouter);
  v1.use('/rider', riderRouter);
  app.use('/api/v1', v1);
  app.use('/api', notFoundHandler);

  // Static PWA (production build). index.html and the service worker must always revalidate.
  if (fs.existsSync(webDist)) {
    app.use(
      express.static(webDist, {
        index: false,
        setHeaders: (res, file) => {
          if (/[\\/]assets[\\/]/.test(file)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          else res.setHeader('Cache-Control', 'no-cache');
        },
      }),
    );
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}
