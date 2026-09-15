import { expect, test } from '@playwright/test';
import { prepareRuntimeFixture } from './runtime-fixture.js';
import { startSectionThreeFixture } from './section-three-fixture.js';

for (const mode of ['hosted', 'sharedworker', 'inpage'] as const) {
  test(`${mode} concurrent SDK transactions preserve both writes and retry a real Firestore conflict`, async ({ page }) => {
    const { flags, expectedMode } = await prepareRuntimeFixture(page, mode);
    const fixture = await startSectionThreeFixture(flags);
    try {
      await page.goto(`${fixture.info.url}/concurrent.html`);
      await expect(page.locator('#result')).toHaveText('Ready');
      await expect(page.locator('#runtime')).toHaveText(expectedMode);
      await page.locator('#firestore').click();
      await expect(page.locator('#result')).toHaveText('{"firstReads":[0,1],"final":2}');
      await page.locator('#rtdb').click();
      await expect(page.locator('#result')).toContainText('"final":2');
      const outcome: unknown = JSON.parse(await page.locator('#result').innerText());
      expect(outcome).toMatchObject({ committed: [true, true], final: 2 });
    } finally {
      await page.close();
      await fixture.stop();
    }
  });
}

for (const mode of ['hosted', 'sharedworker', 'inpage'] as const) {
  test(`${mode} rejected batch and multipath writes leave the entire write set unchanged`, async ({ page }) => {
    const { flags, expectedMode } = await prepareRuntimeFixture(page, mode);
    const fixture = await startSectionThreeFixture(flags);
    try {
      await page.goto(`${fixture.info.url}/concurrent.html`);
      await expect(page.locator('#result')).toHaveText('Ready');
      await expect(page.locator('#runtime')).toHaveText(expectedMode);
      await page.locator('#batch').click();
      await expect(page.locator('#result')).toHaveText('{"error":"permission-denied","allowed":{"value":"before"},"blockedExists":false}');
      await page.locator('#multipath').click();
      await expect(page.locator('#result')).toHaveText('{"error":"PERMISSION_DENIED","stored":{"allowed":"before"}}');
    } finally {
      await page.close();
      await fixture.stop();
    }
  });
}
