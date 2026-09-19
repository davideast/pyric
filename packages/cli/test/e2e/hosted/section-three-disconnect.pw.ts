import { expect, test } from '@playwright/test';
import { prepareRuntimeFixture } from './runtime-fixture.js';
import { startSectionThreeFixture } from './section-three-fixture.js';

for (const mode of ['hosted', 'sharedworker', 'inpage'] as const) {
  test(`${mode} disconnect cancellation is scoped and consumed intent never runs again`, async ({ page }) => {
    const { flags, expectedMode } = await prepareRuntimeFixture(page, mode);
    const fixture = await startSectionThreeFixture(flags);
    try {
      await page.goto(fixture.info.url);
      await expect(page.locator('#result')).toHaveText('Ready');
      await expect(page.locator('#runtime')).toHaveText(expectedMode);
      await page.locator('#arm').click();
      await expect(page.locator('#result')).toHaveText('Done');
      await page.locator('#cancel-child').click();
      await expect(page.locator('#result')).toHaveText('Done');
      await page.locator('#offline').click();
      await expect(page.locator('#connected')).toHaveText('false');
      await expect(page.locator('#observer-connected')).toHaveText('true');
      await expect(page.locator('#presence')).toHaveText('{"state":"offline","untouched":"initial","executions":1}');
      await page.locator('#online').click();
      await expect(page.locator('#connected')).toHaveText('true');
      await page.locator('#returned').click();
      await expect(page.locator('#presence')).toHaveText('{"state":"returned","untouched":"initial","executions":1}');
      await page.locator('#delete').click();
      await expect(page.locator('#result')).toHaveText('Done');
      // Read through the surviving app after deletion has completed.
      const stored = await page.evaluate(async () => {
        const { getApp } = await import('firebase/app');
        const { getDatabase, ref, get } = await import('firebase/database');
        return (await get(ref(getDatabase(getApp('observer')), 'presence/owner'))).val();
      });
      expect(stored).toEqual({ state: 'returned', untouched: 'initial', executions: 1 });
    } finally {
      await page.close();
      await fixture.stop();
    }
  });
}

for (const mode of ['hosted', 'sharedworker', 'inpage'] as const) {
  test(`${mode} full cancellation preserves data and fresh disconnect intent runs on deletion`, async ({ page }) => {
    const { flags, expectedMode } = await prepareRuntimeFixture(page, mode);
    const fixture = await startSectionThreeFixture(flags);
    try {
      await page.goto(fixture.info.url);
      await expect(page.locator('#result')).toHaveText('Ready');
      await expect(page.locator('#runtime')).toHaveText(expectedMode);
      await page.locator('#arm').click();
      await expect(page.locator('#result')).toHaveText('Done');
      await page.locator('#cancel').click();
      await expect(page.locator('#result')).toHaveText('Done');
      await page.locator('#offline').click();
      await expect(page.locator('#connected')).toHaveText('false');
      const cancelled = await page.evaluate(async () => {
        const { getApp } = await import('firebase/app');
        const { getDatabase, ref, get } = await import('firebase/database');
        return (await get(ref(getDatabase(getApp('observer')), 'presence/owner'))).val();
      });
      expect(cancelled).toEqual({ state: 'online', untouched: 'initial', executions: 0 });
      await page.locator('#online').click();
      await expect(page.locator('#connected')).toHaveText('true');
      await page.locator('#arm').click();
      await expect(page.locator('#result')).toHaveText('Done');
      await page.locator('#delete').click();
      await expect(page.locator('#result')).toHaveText('Done');
      await expect(page.locator('#presence')).toHaveText('{"state":"offline","untouched":"disconnected","executions":1}');
      await expect(page.locator('#observer-connected')).toHaveText('true');
    } finally {
      await page.close();
      await fixture.stop();
    }
  });
}
