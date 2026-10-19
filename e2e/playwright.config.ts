import { defineConfig, devices } from '@playwright/test';

// Uses a system/npm-provided Chromium when CHROMIUM_PATH is set (the Playwright CDN may be blocked).
const executablePath = process.env.CHROMIUM_PATH || undefined;
const port = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath, args: executablePath ? ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] : [] },
  },
  projects: [
    { name: 'mobile-android', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-small', use: { ...devices['Pixel 7'], viewport: { width: 360, height: 740 } }, testMatch: /layout/ },
  ],
  webServer: {
    command: './start-server.sh',
    url: `http://localhost:${port}/healthz`,
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: 'ignore',
  },
});
