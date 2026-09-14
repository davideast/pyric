import { test, expect } from '@playwright/test';
import { startSdkFlowServer } from '../../../../examples/runtime-flow-lab/sdk-server.mts';

let server: Awaited<ReturnType<typeof startSdkFlowServer>>;
test.beforeAll(async () => { server = await startSdkFlowServer(); });
test.afterAll(async () => { await server.close(); });

for (const runtime of ['inpage', 'worker']) {
  test(`${runtime}: real SDK reads and listeners render into the same component and unmapped activity stays visible`, async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1500, height: 1100 });
    await page.goto(`${server.url}/?runtime=${runtime}`);
    await page.getByRole('tab', { name: 'Data' }).click();
    const panel = page.locator('[data-component=DataPanel]');
    const rows = page.locator('[data-listener-row]');
    for (const read of ['document', 'query', 'database']) {
      const previousId = await panel.getAttribute('data-pyric-flow-listener');
      await page.locator(`[data-read=${read}]`).click();
      await expect(panel).toHaveAttribute('data-pyric-flow');
      await expect.poll(() => panel.getAttribute('data-pyric-flow-listener')).not.toBe(previousId);
      const id = await panel.getAttribute('data-pyric-flow-listener');
      await expect(page.locator(`[data-listener-row="${id}"]`)).toContainText('1 delivery');
    }
    await expect(rows).toHaveCount(3);
    await page.locator('[data-listen]').click();
    await expect(rows).toHaveCount(3);
    await page.locator('[data-write]').click();
    await expect(page.locator('[data-result]')).toContainText('version":2');
    const id = await panel.getAttribute('data-pyric-flow-listener');
    await page.locator('[data-listen]').click();
    await page.waitForTimeout(300);
    const before = await page.locator('[data-result]').textContent();
    await page.locator('[data-unmapped]').click();
    await expect(page.locator('[data-result]')).toHaveText(before!);
    await rows.filter({ hasText: 'Firestore' }).first().click();
    await expect(page.locator('[data-history-entry]').filter({ hasText: 'No render observed' })).not.toHaveCount(0);
    await page.locator('[data-sources-back]').click();
    await page.locator('[data-denied]').click();
    await rows.filter({ hasText: 'private/denied' }).click();
    await expect(page.locator('[data-history-entry]')).toContainText('Failed');
    await page.locator('[data-sources-back]').click();
    await page.locator('[data-read=document]').click();
    await expect(panel).toHaveAttribute('data-pyric-flow');
    await page.locator('[data-flow-treatment]').selectOption('corners');
    await expect(page.locator('html')).toHaveAttribute('data-pyric-treatment', 'corners');
    await expect(panel).toHaveCSS('outline-width', '0px');
    await page.locator('[data-flow-treatment]').selectOption('outline');
    await expect(panel).toHaveCSS('outline-width', '2px');
    await page.screenshot({ path: `/tmp/sdk-flow-final-${runtime}.png`, fullPage: true });
    // Verify actual runtime retention, not just the journal's unit-test clock.
    await expect(panel).not.toHaveAttribute('data-pyric-flow', { timeout: 35_000 });
    await expect(rows).not.toHaveCount(0);
    await expect(panel).not.toHaveAttribute('data-pyric-flow');
    expect(errors).toEqual([]);
  });
}

for (const runtime of ['inpage', 'worker']) {
  test(`${runtime}: Scanner pass restarts for successive rendered reads`, async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 1100 });
    await page.goto(`${server.url}/?runtime=${runtime}`);
    await page.getByRole('tab', { name: 'Data' }).click();
    await page.locator('[data-flow-treatment]').selectOption('scan');
    await expect(page.locator('html')).toHaveAttribute('data-pyric-treatment', 'scan');
    await page.addStyleTag({ content: '@keyframes pyric-treatment-child { from { opacity: .9; } to { opacity: 1; } } [data-result] { animation: pyric-treatment-child 60s linear infinite; }' });

    await page.evaluate(() => {
      const state = window as typeof window & { scanStarts: number };
      state.scanStarts = 0;
      document.addEventListener('animationstart', event => {
        if (event.animationName === 'pyric-treatment-scan') state.scanStarts++;
      });
    });
    const panel = page.locator('[data-component=DataPanel]');
    await page.locator('[data-read=document]').click();
    await expect.poll(() => page.evaluate(() => (window as typeof window & { scanStarts: number }).scanStarts)).toBe(1);
    const first = await panel.getAttribute('data-pyric-flow-listener');
    const childStart = await page.locator('[data-result]').evaluate(el => el.getAnimations()[0].startTime);
    await page.waitForTimeout(1600);
    await page.locator('[data-read=document]').click();
    await expect(page.locator('[data-result]')).toContainText('Document read #2');
    await expect.poll(() => panel.getAttribute('data-pyric-flow-listener')).not.toBe(first);
    await expect.poll(() => page.evaluate(() => (window as typeof window & { scanStarts: number }).scanStarts)).toBe(2);
    // Restart an in-flight scan too, without waiting for it to finish.
    await page.locator('[data-read=document]').click();
    await expect.poll(() => page.evaluate(() => (window as typeof window & { scanStarts: number }).scanStarts)).toBe(3);
    // Exercise different sources across the previous deliveries' fade timers.
    for (const [index, read] of ['document', 'database', 'query', 'document', 'database', 'query'].entries()) {
      await page.waitForTimeout(1100);
      await page.locator(`[data-read=${read}]`).click();
      await expect.poll(() => page.evaluate(() => (window as typeof window & { scanStarts: number }).scanStarts)).toBe(4 + index);
      await expect(panel).not.toHaveAttribute('data-pyric-flow-retained');
    }
    expect(await page.locator('[data-result]').evaluate(el => el.getAnimations()[0].startTime)).toBe(childStart);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('[data-read=query]').click();
    await expect.poll(() => panel.evaluate(el => getComputedStyle(el, '::before').animationName)).toBe('none');
    expect(await page.evaluate(() => (window as typeof window & { scanStarts: number }).scanStarts)).toBe(9);

  });
}

test('Listeners puts activity before a fixed compact display toolbar', async ({ page }) => {
  for (const width of [1100, 360]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${server.url}/?runtime=inpage`);
    await page.getByRole('tab', { name: 'Data' }).click();
    await page.locator('[data-read=document]').click();
    await expect(page.locator('[data-listener-row]')).toHaveCount(1);
    const toolbar = page.locator('[data-action-bar]');
    await expect(toolbar.locator('[data-listener-mode=flow]')).toBeVisible();
    await expect(toolbar.locator('[data-flow-treatment]')).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Highlight settings' })).toBeVisible();
    await expect(page.locator('[data-chip-view=listeners] [data-flow-treatment]')).toHaveCount(0);
    const row = await page.locator('[data-listener-row]').boundingBox();
    const bar = await toolbar.boundingBox();
    expect(row!.y + row!.height).toBeLessThan(bar!.y);
    expect(await toolbar.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/chip-list-layout-${width}.png` });
  }
});

for (const runtime of ['inpage', 'worker']) {
  test(`${runtime}: sources group calls and explain compact outcomes in details`, async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 850 });
    await page.goto(`${server.url}/?runtime=${runtime}`);
    await page.getByRole('tab', { name: 'Data' }).click();
    for (let i = 0; i < 12; i++) await page.locator('[data-read=document]').click();
    await expect(page.locator('[data-listener-row]')).toHaveCount(1);
    await expect(page.locator('[data-activity-history]')).toHaveCount(0);
    await page.locator('[data-listener-row]').click();
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Data');
    await expect(page.locator('[data-chip-view=listeners]')).not.toContainText('30 seconds');
    await expect(page.locator('[data-chip-view=listeners]')).not.toContainText('commits');
    await expect(page.locator('[data-history-entry]')).toHaveCount(10);
    await expect(page.locator('[data-history-entry]').first()).toContainText('Rendered');
    await expect(page.locator('[data-history-entry]').first()).not.toContainText('app-');
    await expect(page.locator('[data-history-entry]').first()).not.toContainText('commit');
    await page.screenshot({ path: `/tmp/sources-${runtime}-desktop.png` });
    await page.locator('[data-history-entry]').first().click();
    await expect(page.locator('[data-activity-detail]')).toContainText('Response time');
    await page.setViewportSize({ width: 360, height: 800 });
    await page.screenshot({ path: `/tmp/sources-${runtime}-mobile.png` });
    expect(await page.locator('[data-chip-view=listeners]').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.locator('[data-history-page]').filter({ hasText: 'Next' }).click();
    await expect(page.locator('[data-history-entry]')).toHaveCount(2);
    await page.setViewportSize({ width: 1100, height: 850 });
    await expect(page.getByRole('link', { name: 'View traffic' })).toContainText('Traffic');
    const originalUrl = page.url();
    await page.getByRole('link', { name: 'View traffic' }).click();
    expect(page.url()).toBe(originalUrl);
    await expect(page.getByRole('tab', { name: 'Traffic' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Traffic');
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('messages/current');
    await page.locator('[data-inspect-request]').first().click();
    await expect(page.locator('[data-traffic-detail]')).toContainText('messages/current');
    await expect(page.locator('[data-traffic-detail]')).toContainText('Succeeded');
    await expect(page.locator('[data-traffic-rows]')).toHaveCount(0);
    await page.screenshot({ path: `/tmp/traffic-detail-${runtime}.png` });
    await page.locator('[data-request-back]').click();
    await expect(page.locator('[data-traffic-rows]')).toBeVisible();
    await page.screenshot({ path: `/tmp/traffic-breadcrumb-${runtime}.png` });
    await page.locator('[data-clear-traffic-source]').click();
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Data' }).click();
    await page.locator('[data-listen]').click();
    await page.locator('[data-clear-activity-history]').click();
    await expect(page.locator('[data-history-entry]')).toHaveCount(0);
    await page.locator('[data-write]').click();
    await expect(page.locator('[data-history-entry]')).toHaveCount(1);
    await expect(page.locator('[data-history-entry]')).toContainText('Update received');
    await expect(page.locator('[data-history-entry]')).toHaveAttribute('aria-label', /Subscription 1/);
    await page.waitForTimeout(300);
    await page.locator('[data-unmapped]').click();
    await expect(page.locator('[data-history-entry]').filter({ hasText: 'No render observed' })).toHaveCount(1);
    await page.setViewportSize({ width: 360, height: 800 });
    await page.screenshot({ path: `/tmp/sources-${runtime}-mobile-outcomes.png` });
    expect(await page.locator('[data-chip-view=listeners]').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.locator('[data-sources-back]').click();
    await expect(page.locator('[data-activity-history]')).toHaveCount(0);
    await expect(page.locator('[data-listener-row]')).toHaveCount(2);
  });
}

for (const runtime of ['inpage', 'worker']) {
  test(`${runtime}: Overview keeps observed listener regions and the treatment picker available`, async ({ page }) => {
    await page.goto(`${server.url}/?runtime=${runtime}`);
    await page.getByRole('tab', { name: 'Data' }).click();
    await page.locator('[data-listen]').click();
    await expect(page.locator('[data-component=DataPanel]')).toHaveAttribute('data-pyric-flow');
    await page.locator('[data-listener-mode=overview]').click();
    await expect(page.locator('[data-pyric-listener-box]').first()).toBeVisible();
    await expect(page.locator('[data-flow-treatment]')).toBeVisible();
    await page.locator('[data-write]').click();
    await expect(page.locator('[data-result]')).toContainText('version\":2');
    await expect(page.locator('[data-pyric-listener-box]').first()).toBeVisible();
    await expect(page.locator('[data-component=DataPanel]')).not.toHaveAttribute('data-pyric-flow');
    await page.screenshot({ path: `/tmp/overview-${runtime}.png` });
    await page.locator('[data-listen]').click();
    await expect(page.locator('[data-pyric-listener-box]')).toHaveCount(0);
    await expect(page.locator('[data-listener-row]').filter({ hasText: 'Stopped' })).toHaveCount(2);
    // A fresh session must discover regions without visiting Flow first.
    await page.reload();
    await page.getByRole('tab', { name: 'Data' }).click();
    await page.locator('[data-listener-mode=overview]').click();
    await page.locator('[data-listen]').click();
    await expect(page.locator('[data-pyric-listener-box]').first()).toBeVisible();
    await expect(page.locator('[data-flow-treatment]')).toBeVisible();
    await page.locator('[data-listener-mode=flow]').click();
    await page.locator('[data-write]').click();
    await expect(page.locator('[data-component=DataPanel]')).toHaveAttribute('data-pyric-flow');
    await page.locator('[data-listen]').click();
    await expect(page.locator('[data-component=DataPanel]')).not.toHaveAttribute('data-pyric-flow');
  });
}

for (const runtime of ['inpage', 'worker']) {
  test(`${runtime}: repeated reads share one Overview badge with the Data total`, async ({ page }) => {
    await page.goto(`${server.url}/?runtime=${runtime}`);
    await page.getByRole('tab', { name: 'Data' }).click();
    await page.locator('[data-listener-mode=overview]').click();
    for (let n = 1; n <= 10; n++) {
      await page.locator('[data-read=document]').click();
      await expect(page.locator('[data-result]')).toContainText(`Document read #${n}:`);
    }
    await expect(page.locator('[data-listener-row]')).toContainText('10 calls');
    await expect(page.locator('[data-pyric-listener-badge]')).toHaveCount(1);
    await expect(page.locator('[data-pyric-listener-badge]')).toContainText('10');
    await page.locator('[data-listener-mode=flow]').click();
    await page.locator('[data-read=document]').click();
    await expect(page.locator('[data-listener-row]')).toContainText('11 calls');
    await expect(page.locator('[data-component=DataPanel]')).toHaveAttribute('data-pyric-flow-label', /11$/);
    const hue = await page.locator('[data-component=DataPanel]').getAttribute('data-pyric-flow');
    await page.locator('[data-read=document]').click();
    await expect(page.locator('[data-component=DataPanel]')).toHaveAttribute('data-pyric-flow', hue!);
    await expect(page.locator('[data-listener-row]')).toContainText('12 calls');
    let swatch = '';
    await expect.poll(async () => (swatch = await page.locator('.listener-mark').evaluate(el => getComputedStyle(el).borderTopColor))).not.toBe('');
    await page.locator('[data-listener-mode=overview]').click();
    await page.locator('[data-listener-row]').click();
    await page.locator('[data-history-entry]').first().click();
    await expect(page.locator('html')).toHaveAttribute('data-pyric-treatment', 'outline');
    await expect(page.locator('[data-component=DataPanel]')).toHaveCSS('outline-color', swatch);

    await expect(page.locator('[data-component=DataPanel]')).toHaveAttribute('data-pyric-flow', hue!);
    await page.waitForTimeout(4200);
    await expect(page.locator('[data-component=DataPanel]')).not.toHaveAttribute('data-pyric-flow-retained');


  });
}

for (const runtime of ['inpage', 'worker']) {
  test(`${runtime}: denial marks a related region and opens the exact request`, async ({ page }) => {
    await page.goto(`${server.url}/?runtime=${runtime}`);
    await page.getByRole('tab', { name: 'Data' }).click();
    // No known region: chip fallback only, without inventing a target.
    await page.locator('[data-denied]').click();
    await expect(page.locator('[data-pyric-denials]')).toHaveCount(0);
    await page.locator('[data-read=document]').click();
    await expect(page.locator('[data-component=DataPanel]')).toHaveAttribute('data-pyric-flow');
    await page.locator('[data-denied-write]').click();
    const marker = page.locator('[data-pyric-denials] [data-pyric-listener-badge]').first();
    await expect(marker).toContainText('Write denied — related region');
    await expect(page.locator('[data-result]')).toContainText('version":1');
    const id = await marker.getAttribute('data-listener-id');
    await marker.click();
    await expect(page.locator('[data-traffic-detail]')).toHaveAttribute('data-request-row', id!);
    await expect(page.locator('[data-traffic-detail]')).toContainText('Denied');
    await expect(page.locator('[data-traffic-detail]')).toContainText('No applicable rule allowed this request');
    await expect(page.locator('.rules-evidence')).toContainText('version');
    await expect(page.locator('.rules-evidence')).toContainText('At least');
    await page.getByText('Rule details', { exact: true }).click();
    await expect(page.locator('.rules-evidence')).not.toContainText('Captured rules version');
    await expect(page.locator('.rules-evidence')).toContainText('Review them before copying or sharing');
    await expect(page.locator('.rules-evidence')).toContainText('-1');
    await page.setViewportSize({ width: 360, height: 800 });
    await expect.poll(() => page.locator('.rules-evidence').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/denial-${runtime}.png` });
    await expect(page.locator('[data-pyric-denials]')).toHaveCount(0, { timeout: 10000 });
  });
}

for (const runtime of ['inpage', 'worker']) {
  test(`${runtime}: signed-in project denials explain ownership, roles and validation`, async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 1100 });
    await page.goto(`${server.url}/?runtime=${runtime}`);
    for (const [scenario, expected] of [['ownership', 'bob'], ['role', 'editor'], ['validation', '-250']]) {
      await page.locator('#security-scenario').selectOption(scenario!);
      await page.locator('[data-security-load]').click();
      await expect(page.locator('[data-security-result]')).toContainText('North launch');
      await page.locator('[data-security-attempt]').click();
      await expect(page.locator('[data-security-result]')).toContainText('Change denied');
      await page.getByRole('tab', { name: 'Traffic' }).click();
      const back = page.locator('[data-clear-traffic-source]');
      if (await back.count()) await back.click();
      const row = page.locator('[data-request-row]').filter({ hasText: 'projects/' }).filter({ hasText: 'denied' }).first();
      await row.click();
      await expect(page.locator('[data-traffic-detail]')).toContainText('alice');
        await expect(page.locator('.rule-comparison')).not.toHaveCount(0);
      await expect(page.locator('.rules-evidence')).toContainText(expected!);
      await page.locator('.rule-comparison').last().scrollIntoViewIfNeeded();
      await page.screenshot({ path: `/tmp/security-${runtime}-${scenario}.png` });
      if (scenario === 'ownership') {
        await page.getByText('Rule details', { exact: true }).click();
        await expect(page.locator('.rules-detail-body')).toContainText('does not cover projects/bobs-launch');
        await expect(page.locator('.rules-detail-body')).toContainText('covers projects/bobs-launch');
        await page.locator('.rules-detail-body').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `/tmp/security-details-${runtime}.png` });
        await page.setViewportSize({ width: 360, height: 800 });
        await expect.poll(() => page.locator('.rules-evidence').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        const condition = page.locator('.rules-group .rule-expression').first();
        await expect(condition).toHaveCSS('white-space', 'nowrap');
        await expect.poll(() => condition.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
        const textClearance = await condition.evaluate(element => {
          const text = document.createRange();
          text.selectNodeContents(element);
          return element.getBoundingClientRect().bottom - text.getBoundingClientRect().bottom;
        });
        expect(textClearance).toBeGreaterThanOrEqual(16);
        await condition.hover();
        await page.mouse.wheel(160, 0);
        await expect.poll(() => condition.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
        await page.waitForTimeout(1200);
        expect(await condition.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
        await page.getByRole('button', { name: 'Read document', exact: true }).dispatchEvent('click');
        await expect(page.locator('[data-result]')).toContainText('Document read');
        expect(await condition.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
        const labels = await page.locator('.rule-check').evaluateAll(rows => rows.every(row => row.querySelector('dt')?.textContent === 'Condition'));
        expect(labels).toBe(true);
        await page.locator('.rules-group').first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: `/tmp/security-narrow-${runtime}.png` });
        await page.setViewportSize({ width: 1500, height: 1100 });
      }
    }
    await page.locator('#security-scenario').selectOption('allowed');
    await page.locator('[data-security-load]').click();
    await page.locator('[data-security-attempt]').click();
    await expect(page.locator('[data-security-result]')).toContainText('Saved successfully');
  });
}
