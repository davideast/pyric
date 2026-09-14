import { chromium, expect } from '@playwright/test';
const browser = await chromium.launch({ headless: true });
try {
  for (const service of ['rtdb', 'firestore']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    await page.goto('http://localhost:5197/?service=' + service);
    await expect(page.locator('#treatment option')).toHaveCount(15);
    await page.getByRole('tab', { name: 'Data', exact: true }).click();
    await expect(page.getByText('Recorded history', { exact: true })).toHaveCount(0);
    await page.locator('[data-flow-treatment]').selectOption('scan');
    await page.getByRole('button', { name: 'Inspect /presence', exact: true }).click();
    await page.locator('[data-deliver=messages]').click();
    await expect(page.locator('[data-component=UnreadBadge]')).toHaveAttribute('data-pyric-flow-listener');
    await page.locator('[data-deliver=typing]').click();
    await expect(page.locator('[data-component=TypingIndicator]')).toHaveAttribute('data-pyric-flow-listener');
    await page.locator('[data-sources-back]').click();
    const eye = page.getByRole('button', { name: 'Highlight /presence', exact: true });
    await eye.click();
    await expect(eye).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-sources-back]')).toHaveCount(0);
    await expect(page.locator('[data-listener-mode=overview]')).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Inspect /presence', exact: true }).click();
    await page.locator('[data-sources-back]').click();
    await expect(eye).toHaveAttribute('aria-pressed', 'true');
    await eye.click();
    await expect(eye).toHaveAttribute('aria-pressed', 'false');
    await page.locator('[data-listener-all]').click();
    await page.locator('[data-listener-mode=flow]').click();
    await page.locator('[data-deliver=messages]').click();
    await expect(page.locator('[data-component=MessageList]')).toHaveAttribute('data-pyric-flow-listener');
    await page.screenshot({ path: '/tmp/source-controls-' + service + '.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '/tmp/source-controls-' + service + '-mobile.png' });
    expect(await page.locator('[data-listener-rows]').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(false);
    await page.close();
  }
  console.log('PASS: RTDB and Firestore Flow during drill-in, source highlight toggles, Show all, and narrow layout.');
} finally { await browser.close(); }
