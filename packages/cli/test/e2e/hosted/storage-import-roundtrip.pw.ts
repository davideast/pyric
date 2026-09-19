import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { startStoragePersistenceFixture } from './storage-persistence-fixture.js';

test('import restores exported Storage bytes instead of retaining a later upload', async ({ page }) => {
  test.setTimeout(30_000);
  const fixture = await startStoragePersistenceFixture();
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#ready')).toHaveText('Ready');
    await page.getByLabel('Value', { exact: true }).fill('Exported bytes');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#saved')).toHaveText('Saved');
    const control = await connectRemoteSandbox({ url: fixture.info.url });
    try {
      const exported = await control.channel.op({ method: 'exportState' });
      const hasBundle = typeof exported === 'object' && exported !== null && 'bundle' in exported;
      const isMissingBundle = !hasBundle;
      if (isMissingBundle) throw new Error('Expected an exported state bundle');
      const bundle = exported.bundle;
      const isInvalidBundle = typeof bundle !== 'string';
      if (isInvalidBundle) throw new Error('Expected a string state bundle');
      await page.getByLabel('Value', { exact: true }).fill('Later bytes');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByRole('button', { name: 'Read', exact: true }).click();
      await expect(page.locator('#value-read')).toHaveText('Later bytes');
      await expect(control.channel.op({ method: 'importState', bundle })).resolves.toEqual({ ok: true });
      await page.getByRole('button', { name: 'Read', exact: true }).click();
      await expect(page.locator('#value-read')).toHaveText('Exported bytes');
    } finally {
      control.close();
    }
  } finally {
    await fixture.stop();
  }
});
