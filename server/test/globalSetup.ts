// Runs once: recreate the test schema and apply migrations against the dedicated test database.
export default async function setup() {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/laundry_dash_test';
  process.env.PAYMENT_WEBHOOK_SECRET ??= 'test-webhook-secret-0123456789';
  const { pool } = await import('../src/db.js');
  if (!/_test\b/.test(process.env.DATABASE_URL)) throw new Error('Refusing to run tests against a non-test database');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const { migrate } = await import('../src/migrate.js');
  await migrate();
  await pool.end();
}
