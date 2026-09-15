import { chromium, expect } from '@playwright/test';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await page.goto('http://localhost:5197/?service=firestore');
  await expect(page.locator('[data-component=MessageBubble]')).toHaveCount(3);
  await page.waitForTimeout(3100);
  await page.getByRole('button', { name: 'Refresh data', exact: true }).click();
  await page.waitForTimeout(3100);
  await page.getByRole('tab', { name: 'Traffic', exact: true }).click();
  await page.getByRole('button', { name: 'Rates', exact: true }).click();
  await page.getByRole('button', { name: 'Firestore', exact: true }).click();
  await expect(page.locator('[data-history-mode=pause]')).toHaveAttribute('aria-pressed', 'true');
  const summary = page.locator('[data-history-summary]');
  await expect(summary.locator('[data-history-total=reads]')).toHaveText('3');
  await expect(summary.locator('[data-history-total=deletes]')).toHaveText('0');
  await expect(page.locator('[data-rate-method=getDocs] [data-period-calls]')).toHaveText('1');
  await expect(page.locator('[data-rate-notes]')).not.toHaveAttribute('open');
  const before = await summary.innerText();
  await page.getByRole('button', { name: 'New message', exact: true }).click();
  await page.waitForTimeout(1200);
  expect(await summary.innerText()).toBe(before);
  await page.locator('[data-history-chart]').focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(summary.locator('.history-duration')).toHaveText('2s');
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await expect(summary).toContainText('Live period');
  await page.screenshot({ path: '/tmp/firestore-history-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/firestore-history-mobile.png' });
  const overflow = await page.locator('[data-rate-detail]').evaluate(el => el.scrollWidth > el.clientWidth);
  expect(overflow).toBe(false);
  console.log('PASS: Firestore document totals, SDK counts, idle recall, frozen selection, keyboard, Live, and narrow layout.');
} finally {
  await browser.close();
}
