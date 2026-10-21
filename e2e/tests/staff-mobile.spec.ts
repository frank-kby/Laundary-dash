import { expect, test } from '@playwright/test';

const pages = ['/staff', '/staff/payments', '/staff/subscriptions', '/staff/settings', '/staff/people', '/staff/reports', '/staff/audit'];

async function signInAdmin(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByLabel('Email or phone number').fill('demo.admin@example.com');
  await page.getByLabel('Password', { exact: true }).fill('LaundryDemo2026!');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible();
}

test.describe('staff portal on a phone', () => {
  test.use({ viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true });

  test('every staff screen fits the phone and tables read as cards', async ({ page }) => {
    await signInAdmin(page);
    const header = await page.locator('header.topbar').boundingBox();
    expect(header!.height).toBeLessThan(140); // compact header, not a third of the screen
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

    for (const path of pages) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const [scrollW, innerW] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      expect(scrollW, `${path} scrolls sideways`).toBeLessThanOrEqual(innerW);
    }

    // Orders table: header row hidden, each cell labelled with its column name
    await page.goto('/staff');
    const row = page.locator('table.data tbody tr').first();
    await expect(row).toBeVisible();
    await expect(page.locator('table.data thead')).toBeHidden();
    await expect(row.locator('td[data-label="Total"]')).toContainText('RWF');

    // The menu scrolls sideways and still reaches the last section
    await page.getByRole('navigation', { name: 'Staff' }).getByRole('link', { name: 'Audit log' }).click();
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  });

  test('pickup slots are shown one day at a time', async ({ page }) => {
    await signInAdmin(page);
    await page.goto('/staff/settings');
    await page.getByRole('button', { name: 'Pickup slots' }).click();
    const days = page.getByRole('group', { name: 'Day' }).getByRole('button');
    expect(await days.count()).toBeGreaterThan(1);
    await days.nth(1).click();
    await expect(days.nth(1)).toHaveAttribute('aria-pressed', 'true');
    const rows = page.locator('table.data tbody tr');
    expect(await rows.count()).toBeLessThanOrEqual(8);
    await expect(rows.first().locator('td').first()).toHaveText(/^\d\d:\d\d–\d\d:\d\d$/);
  });
});

test('the staff portal keeps full tables on a computer', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await signInAdmin(page);
  await expect(page.locator('table.data thead')).toBeVisible();
  await expect(page.getByText('DEMO Admin (ADMIN)')).toBeVisible();
});
