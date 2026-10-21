import { chromium as pw, devices } from '@playwright/test';
const out = process.argv[2] || '/tmp/claude-0/staffm';
const b = await pw.launch({ executablePath: '/tmp/chromium', args: ['--no-sandbox','--disable-gpu'] });
const ctx = await b.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } });
const p = await ctx.newPage();
const base = 'http://localhost:3000';
await p.goto(base + '/login');
await p.getByLabel('Email or phone number').fill('demo.admin@example.com');
await p.getByLabel('Password', { exact: true }).fill('LaundryDemo2026!');
await p.getByRole('button', { name: 'Sign in' }).click();
await p.waitForURL(/\/staff/); await p.waitForTimeout(1500);
const overflow = async (name) => {
  const w = await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  console.log(name.padEnd(22), w[0] > w[1] ? `OVERFLOW ${w[0]}>${w[1]}` : 'ok');
};
const shot = async (name) => { await p.waitForTimeout(900); await overflow(name); await p.screenshot({ path: `${out}/${name}.png`, fullPage: true }); };
await shot('01-orders');
const first = p.locator('a[href^="/staff/orders/"]').first();
if (await first.count()) { await first.click(); await shot('02-order-detail'); await p.goBack(); }
for (const [path, name] of [['payments','03-payments'],['subscriptions','04-subscriptions'],['settings','05-settings-contact'],['people','07-people'],['reports','08-reports'],['audit','09-audit']]) {
  await p.goto(`${base}/staff/${path}`); await shot(name);
}
await p.goto(`${base}/staff/settings`); await p.waitForTimeout(600);
for (const tab of ['Services & prices','Garment types','Pickup slots']) {
  await p.getByRole('tab', { name: tab }).or(p.getByRole('button', { name: tab })).first().click().catch(e=>console.log('tab?',tab));
  await shot('06-settings-' + tab.split(' ')[0].toLowerCase());
}
await b.close();
