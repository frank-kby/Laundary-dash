import { expect, test, type Page } from '@playwright/test';

async function assertMobileFriendly(page: Page) {
  // No sideways scrolling on a phone
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'horizontal overflow (px)').toBeLessThanOrEqual(0);
  // Every visible button / form control is big enough to tap (WCAG 2.5.8 minimum 24px; we target 44px)
  const small = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('main button, main .btn, main input:not([type=checkbox]):not([type=radio]), main select, nav.tabbar a')]
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({ text: (el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 30), h: el.getBoundingClientRect().height }))
      .filter((x) => x.h < 44),
  );
  expect(small, 'controls shorter than 44px').toEqual([]);
}

test('auth screens fit small phones and switch to Kinyarwanda', async ({ page }) => {
  await page.goto('/login');
  await assertMobileFriendly(page);
  await page.getByRole('button', { name: /RW/ }).click();
  await expect(page.getByRole('heading', { name: 'Injira' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'rw');
  await page.getByRole('link', { name: 'Fungura konti' }).click();
  await assertMobileFriendly(page);
  await page.getByRole('button', { name: /EN/ }).click();
  await expect(page.getByRole('heading', { name: 'Create account' })).toBeVisible();
});

test('customer screens fit small phones and load quickly', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email or phone number').fill('demo.customer@example.com');
  await page.getByLabel('Password', { exact: true }).fill('LaundryDemo2026!');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: /Book a pickup/ })).toBeVisible();

  for (const path of ['/', '/book', '/wardrobe', '/bookings', '/account', '/subscription']) {
    const start = Date.now();
    await page.goto(path);
    await page.locator('main h1').first().waitFor();
    await page.waitForLoadState('networkidle');
    const ms = Date.now() - start;
    test.info().annotations.push({ type: 'load', description: `${path}: ${ms} ms (localhost, no throttling)` });
    expect(ms).toBeLessThan(3000);
    await assertMobileFriendly(page);
  }
  // Tab bar is always reachable
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link')).toHaveCount(4);
});

test('offline is shown honestly and nothing is reported as sent', async ({ page, context }) => {
  await page.goto('/login');
  await page.getByLabel('Email or phone number').fill('demo.customer@example.com');
  await page.getByLabel('Password', { exact: true }).fill('LaundryDemo2026!');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: /Book a pickup/ })).toBeVisible();
  await page.goto('/wardrobe');
  await expect(page.getByRole('heading', { name: 'Wardrobe' })).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByText(/Offline\. You can look around/)).toBeVisible();
  await page.getByRole('button', { name: 'Add item' }).click();
  await page.getByLabel('Description').fill('Offline jacket');
  await page.getByLabel('Type', { exact: true }).selectOption({ label: 'Jackets & suits' });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/You seem to be offline\. Nothing was sent/)).toBeVisible();
  await context.setOffline(false);
});

test('API responses are never cached and security headers are present', async ({ request }) => {
  const r = await request.get('/api/v1/config');
  expect(r.headers()['cache-control']).toContain('no-store');
  const html = await request.get('/');
  const csp = html.headers()['content-security-policy'];
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
});
