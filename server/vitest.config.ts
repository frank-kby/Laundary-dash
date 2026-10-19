import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/globalSetup.ts'],
    fileParallelism: false, // integration tests share one database
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/laundry_dash_test',
      APP_ORIGIN: 'http://localhost:5173',
      EMAIL_PROVIDER: 'console',
      PHOTO_STORAGE: 'local',
      LOCAL_UPLOAD_DIR: './data/test-uploads',
      PAYMENT_PROVIDER: 'simulator',
      PAYMENT_WEBHOOK_SECRET: 'test-webhook-secret-0123456789',
    },
  },
});
