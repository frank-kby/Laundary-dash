import { devices, expect, test } from '@playwright/test';

test('a guest browses, builds a booking, and signs up only when confirming', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to Laundry Dash' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Prices' })).toBeVisible();
  await expect(page.locator('.price-list')).toContainText('Wash & iron');

  // Members-only areas invite sign-up instead of redirecting
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Wardrobe' }).click();
  await expect(page.getByRole('heading', { name: 'Your wardrobe, organised' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create free account' })).toBeVisible();

  // Build a booking as a guest and see the price
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Home' }).click();
  await page.getByRole('link', { name: /Book a pickup/ }).click();
  await page.getByLabel('Description').fill('Guest shirt');
  await page.getByLabel('Type', { exact: true }).selectOption({ label: 'Shirts' });
  await page.getByLabel('Service').selectOption({ label: 'Wash & iron — 800 RWF' });
  await page.getByRole('button', { name: 'Add this item' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Area').selectOption({ label: 'Remera' });
  await page.getByLabel('Landmark').fill('Near Amahoro Stadium');
  await page.locator('.slot:not(.slot-full) input').first().check();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('.price tfoot')).toContainText('2,800 RWF'); // 800 + 1,000 + 1,000

  // Confirm → sign-up sheet; the draft is kept and the booking goes through right after
  await page.getByRole('button', { name: /Confirm booking/ }).click();
  const sheet = page.locator('dialog.sheet');
  await expect(sheet.getByRole('heading', { name: 'Almost done!' })).toBeVisible();
  await sheet.getByLabel('Your name').fill('Guest Person');
  await sheet.getByLabel('Phone number', { exact: true }).fill(`072${String(Date.now()).slice(-7)}`);
  await sheet.getByLabel('Password', { exact: true }).fill('a-good-password');
  await sheet.getByRole('button', { name: 'Create account' }).click();
  await expect(sheet).toBeHidden();
  await page.getByRole('button', { name: /Confirm booking/ }).click();
  await expect(page.getByRole('heading', { name: 'You’re all set!' })).toBeVisible();
});

test('a business account tracks linens per property with depreciation', async ({ page }) => {
  await page.goto('/register');
  await page.locator('.type-card', { hasText: 'Business' }).click();
  await page.getByLabel('Your name').fill('Ange Manager');
  await page.getByLabel('Business name').fill('Kacyiru Suites');
  await page.getByLabel(/Type of business/).selectOption({ label: 'Apartments & short stays' });
  await page.getByLabel('Phone number', { exact: true }).fill(`073${String(Date.now()).slice(-7)}`);
  await page.getByLabel('Password', { exact: true }).fill('a-good-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Hello, Ange' })).toBeVisible();

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Wardrobe' }).click();
  await expect(page.getByRole('heading', { name: 'Inventory' })).toBeVisible();
  await page.getByRole('button', { name: 'Add item' }).click();
  await page.getByLabel('Description').fill('White queen sheets');
  // Business types come first in the list
  await page.getByLabel('Type', { exact: true }).selectOption({ label: 'Bed sheets' });
  await page.getByLabel(/Location or unit/).fill('Apartment 2B');
  await page.getByLabel(/Value per piece/).fill('20000');
  const yearAgo = new Date(Date.now() - 365.25 * 86_400_000).toISOString().slice(0, 10);
  await page.getByLabel(/Purchase date/).fill(yearAgo);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved to your wardrobe')).toBeVisible();

  const card = page.locator('.wd-card', { hasText: 'White queen sheets' });
  await expect(card).toContainText('Apartment 2B');
  await expect(card).toContainText('Now 10,000 RWF'); // bed sheets: 24-month life, 12 months old
  await expect(page.getByRole('button', { name: 'Apartment 2B' })).toBeVisible(); // location filter chip
  await card.click();
  await expect(page.getByText('50% of its value left')).toBeVisible();
  await expect(page.getByText(/About 12 month/)).toBeVisible();
});

test('a personal account sees clothing types for the chosen gender', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Your name').fill('Aline');
  await page.getByLabel('Phone number', { exact: true }).fill(`078${String(Date.now()).slice(-7)}`);
  await page.getByLabel('Password', { exact: true }).fill('a-good-password');
  await page.getByRole('radio', { name: 'Men', exact: true }).click();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Hello, Aline' })).toBeVisible();
  await page.goto('/wardrobe');
  await page.getByRole('button', { name: 'Add item' }).click();
  const types = page.getByLabel('Type', { exact: true });
  await expect(types.locator('option', { hasText: 'Ties' })).toHaveCount(1);
  await expect(types.locator('option', { hasText: 'Skirts' })).toHaveCount(0);
  await expect(types.locator('option', { hasText: 'Bed sheets' })).toHaveCount(0);
});

test('an admin changes the WhatsApp and phone numbers customers see', async ({ browser }) => {
  const admin = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await admin.goto('/login');
  await admin.getByLabel('Email or phone number').fill('demo.admin@example.com');
  await admin.getByLabel('Password', { exact: true }).fill('LaundryDemo2026!');
  await admin.getByRole('button', { name: 'Sign in' }).click();
  await admin.getByRole('link', { name: 'Settings' }).click();
  await expect(admin.getByRole('heading', { name: 'Customer contact numbers' })).toBeVisible();
  await admin.getByLabel('WhatsApp number').fill('0788 222 333');
  await admin.getByLabel('Phone number for calls').fill('0788 444 555');
  await admin.getByRole('button', { name: 'Save contact numbers' }).click();
  await expect(admin.getByText('Contact numbers saved')).toBeVisible();

  const guest = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
  await guest.goto('/');
  await expect(guest.getByRole('link', { name: 'WhatsApp us' })).toHaveAttribute('href', 'https://wa.me/250788222333');
  await expect(guest.getByRole('link', { name: 'Call us' })).toHaveAttribute('href', 'tel:+250788444555');
});
