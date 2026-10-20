import { devices, expect, test, type Browser, type Page } from '@playwright/test';

const DEMO_PW = 'LaundryDemo2026!';

async function signIn(browser: Browser, identifier: string) {
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel('Email or phone number').fill(identifier);
  await page.getByLabel('Password', { exact: true }).fill(DEMO_PW);
  await page.getByRole('button', { name: 'Sign in' }).click();
  return page;
}

async function staffMoveTo(staff: Page, status: string) {
  await staff.getByLabel('Move to', { exact: true }).selectOption({ label: status });
  await staff.getByRole('button', { name: 'Apply' }).click();
  await expect(staff.locator('.row-between .badge').first()).toHaveText(status);
}

test('customer books a pickup and follows it through to delivery and payment', async ({ page, browser }) => {
  const phone = `078${String(Date.now()).slice(-7)}`;

  // --- Register with phone + password, no OTP, keep me logged in
  await page.goto('/register');
  await page.getByLabel('Your name').fill('Uwase Test');
  await page.getByLabel('Phone number', { exact: true }).fill(phone);
  await page.getByLabel('Password', { exact: true }).fill('a-good-password');
  await page.getByLabel(/Keep me logged in/).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Hello, Uwase' })).toBeVisible();
  const cookie = (await page.context().cookies()).find((c) => c.name === 'ld_sid')!;
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe('Lax');
  expect(cookie.expires).toBeGreaterThan(Date.now() / 1000 + 25 * 86400);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(cookie.value);

  // --- Book without a wardrobe
  await page.getByRole('link', { name: /Book a pickup/ }).click();
  await page.getByLabel('Description').fill('Blue shirt');
  await page.getByLabel('Type').selectOption({ label: 'Shirts' });
  await page.getByLabel('Service').selectOption({ label: 'Wash & iron — 800 RWF' });
  await page.getByLabel('How many').fill('2');
  await page.getByRole('button', { name: 'Add this item' }).click();
  await expect(page.locator('.draft')).toContainText('Blue shirt');
  await page.getByRole('button', { name: 'Next' }).click();

  await page.getByLabel('Area').selectOption({ label: 'Kimihurura' });
  await page.getByLabel('Landmark').fill('Opposite the Kimihurura roundabout');
  await page.locator('.slot:not(.slot-full) input').first().check();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Deliver to the pickup address')).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();

  // Estimate shown before confirming: 2 x 800 + 1000 pickup + 1000 delivery
  await expect(page.locator('.price tfoot')).toContainText('3,600 RWF');
  const confirm = page.getByRole('button', { name: /Confirm booking/ });
  await confirm.dblclick(); // a double tap must not create two bookings
  await expect(page.getByRole('heading', { name: 'You’re all set!' })).toBeVisible();
  const ref = (await page.getByText(/Reference LD-/).textContent())!.match(/LD-\d{6}-\w{5}/)![0];
  await page.getByRole('link', { name: 'View order' }).click();
  await expect(page.locator('.line-status')).toHaveText('Waiting for confirmation');
  const orderUrl = page.url();
  await page.goto('/bookings');
  await expect(page.locator('.list-row', { hasText: ref })).toHaveCount(1);

  // --- Staff confirms and assigns a rider
  const staff = await signIn(browser, 'demo.staff@example.com');
  await expect(staff.getByRole('heading', { name: 'Orders' })).toBeVisible();
  await staff.getByLabel(/Search reference/).fill(ref);
  await staff.getByRole('button', { name: 'Apply' }).click();
  await staff.getByRole('link', { name: ref }).click();
  await staffMoveTo(staff, 'Confirmed');
  const riderSelect = staff.getByLabel('Rider (Pickup)');
  await riderSelect.selectOption({ index: 1 });
  await staff.getByRole('button', { name: 'Assign rider' }).click();
  await expect(staff.locator('.row-between .badge').first()).toHaveText('Rider assigned');

  // --- Rider collects
  const rider = await signIn(browser, '+250780000101');
  const task = rider.locator('.task', { hasText: ref });
  await expect(task).toBeVisible();
  await expect(task).not.toContainText('RWF'); // riders never see prices
  await task.getByRole('button', { name: /Start/ }).click();
  await task.getByRole('button', { name: 'Collected the items' }).click();
  await expect(rider.locator('.task', { hasText: ref })).toHaveCount(0);

  // --- Staff inspects: 3 shirts arrived, not 2 → needs customer approval
  await staff.reload();
  await expect(staff.locator('.row-between .badge').first()).toHaveText('Picked up');
  await staff.getByLabel('Received Blue shirt').fill('3');
  await staff.getByLabel('Reason shown to customer').fill('We received 3 shirts');
  await staff.getByRole('button', { name: 'Save inspection' }).click();
  await expect(staff.locator('.row-between .badge').first()).toHaveText('Needs your approval');
  // Work cannot proceed
  await expect(staff.getByLabel('Move to', { exact: true }).locator('option', { hasText: 'Being cleaned' })).toHaveCount(0);

  // --- Customer approves the revised price
  await page.goto(orderUrl);
  await expect(page.getByRole('heading', { name: 'Approve the new price?' })).toBeVisible();
  await page.getByRole('button', { name: 'Approve 4,400 RWF' }).click();
  await expect(page.locator('.line-status')).toHaveText('At our shop');

  // --- Staff processes, readies and sends out
  await staff.reload();
  await staffMoveTo(staff, 'Being cleaned');
  await staffMoveTo(staff, 'Ready');
  await staff.getByLabel('Rider (Delivery)').selectOption({ index: 1 });
  await staff.getByRole('button', { name: 'Assign rider' }).click();
  await expect(staff.getByText(/Delivery · DEMO Rider/)).toBeVisible();

  // --- Rider delivers
  await rider.reload();
  const delivery = rider.locator('.task', { hasText: ref });
  await delivery.getByRole('button', { name: /Start/ }).click();
  await page.goto(orderUrl);
  await expect(page.locator('.line-status')).toHaveText('On the way to you');
  await delivery.getByRole('button', { name: 'Delivered to customer' }).click();

  // --- Customer sees it delivered and pays in TEST MODE
  await page.reload();
  await expect(page.locator('.line-status')).toHaveText('Delivered');
  await expect(page.getByText('TEST MODE — no real money moves')).toBeVisible();
  await page.getByRole('button', { name: /Send payment request · 4,400 RWF/ }).click();
  await expect(page.getByText(/approve with your PIN/)).toBeVisible();
  await page.getByRole('button', { name: 'Approve (test)' }).click();
  await expect(page.locator('.row-between .badge')).toHaveText('Paid');
});

test('price rejection keeps the original price', async ({ page, browser }) => {
  // Uses the seeded DEMO booking (LD-DEMO-0001) to exercise rejection from the customer side.
  const staff = await signIn(browser, 'demo.staff@example.com');
  await staff.getByLabel(/Search reference/).fill('LD-DEMO-0001');
  await staff.getByRole('button', { name: 'Apply' }).click();
  await staff.getByRole('link', { name: 'LD-DEMO-0001' }).click();
  await staffMoveTo(staff, 'Confirmed');
  await staffMoveTo(staff, 'Picked up');
  await staff.getByLabel(/Extra charge: Description/).fill('Stain removal');
  await staff.getByLabel('Amount (RWF)').first().fill('1500');
  await staff.getByLabel('Reason shown to customer').fill('Coffee stain on collar');
  await staff.getByRole('button', { name: 'Save inspection' }).click();
  await expect(staff.locator('.row-between .badge').first()).toHaveText('Needs your approval');

  await page.goto('/login');
  await page.getByLabel('Email or phone number').fill('demo.customer@example.com');
  await page.getByLabel('Password', { exact: true }).fill(DEMO_PW);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Your approval is needed for a price change')).toBeVisible();
  await page.locator('.order-card', { hasText: 'LD-DEMO-0001' }).click();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Decline extra work' }).click();
  await expect(page.locator('.line-status')).toHaveText('Being checked');
  await expect(page.locator('.price tfoot').first()).toContainText('4,400 RWF');
});
