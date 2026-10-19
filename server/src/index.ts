import { config } from './config.js';
import { createApp } from './app.js';
import { pool } from './db.js';
import { log } from './log.js';
import { migrate } from './migrate.js';
import { bootstrapAdmin, seedCatalogueIfEmpty, topUpSlots } from './bootstrap.js';

async function main() {
  if (process.env.RUN_MIGRATIONS_ON_START === 'true') {
    const applied = await migrate();
    if (applied.length) log.info('migrations_applied', { applied });
  }
  if (process.env.SEED_CATALOGUE_IF_EMPTY === 'true') await seedCatalogueIfEmpty();
  await bootstrapAdmin();
  await topUpSlots(process.env, true);
  const app = createApp();
  const server = app.listen(config.PORT, () => log.info('server_started', { port: config.PORT, env: config.NODE_ENV }));
  const shutdown = () => {
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  log.error('startup_failed', { message: e.message });
  process.exit(1);
});
