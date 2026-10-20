import path from 'node:path';
import { expect, test } from '@playwright/test';

test('customer builds a virtual wardrobe with photo, colour and value, then books cleaning from it', async ({ page }) => {
  const phone = `079${String(Date.now()).slice(-7)}`;
  await page.goto('/register');
  await page.getByLabel('Your name').fill('Wardrobe Tester');
  await page.getByLabel('Phone number', { exact: true }).fill(phone);
  await page.getByLabel('Password', { exact: true }).fill('a-good-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Hello, Wardrobe' })).toBeVisible();

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Wardrobe' }).click();
  await page.getByRole('button', { name: 'Add item' }).click();

  // Photo is shrunk on the device before upload
  await page.getByLabel('Add a photo').setInputFiles(path.resolve(__dirname, '../fixtures/shirt.jpg'));
  await expect(page.locator('.photo-pick.has-photo img')).toBeVisible();
  await page.getByLabel('Description').fill('Green kitenge shirt');
  await page.getByLabel('Type', { exact: true }).selectOption({ label: 'Shirts' });
  await page.getByRole('radio', { name: 'Green' }).click();
  await expect(page.getByRole('radio', { name: 'Green' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'One more' }).click();
  await page.getByLabel(/Value per piece/).fill('15000');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved to your wardrobe')).toBeVisible();

  // Card shows photo, value; summary shows totals (2 pieces x 15,000)
  const card = page.locator('.wd-card', { hasText: 'Green kitenge shirt' });
  await expect(card.locator('img')).toBeVisible();
  await expect(card).toContainText('15,000 RWF');
  await expect(page.locator('.wd-summary')).toContainText('30,000');

  // The photo is served privately and really is a (shrunk) JPEG
  const src = await card.locator('img').getAttribute('src');
  const img = await page.request.get(src!);
  expect(img.headers()['content-type']).toContain('image/jpeg');
  expect((await img.body()).length).toBeLessThan(200_000);

  // Detail → Book cleaning preselects the item
  await card.click();
  await expect(page.getByText('Not cleaned with us yet')).toBeVisible();
  await page.getByRole('button', { name: 'Book cleaning' }).click();
  await expect(page.getByRole('heading', { name: 'Book a pickup' })).toBeVisible();
  await expect(page.getByLabel('From my wardrobe')).toHaveValue(/.+/);
  await page.getByLabel('Service').selectOption({ label: 'Wash & iron — 800 RWF' });
  await page.getByRole('button', { name: 'Add this item' }).click();
  await expect(page.locator('.draft')).toContainText('Green kitenge shirt');
});
