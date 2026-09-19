import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';
import { installDocumentReplyFault } from './document-reply-fault.js';

for (const mode of ['hosted', 'shared-worker']) {
 for (const delivery of ['res', 'snap'] as const) {
  test(`${mode} ${delivery}: an over-depth document reply rejects before recursive decoding`, async ({ page }) => {
    const isHosted = mode === 'hosted';
    const isSnapshot = delivery === 'snap';
    const read = isSnapshot
      ? '() => new Promise((resolve, reject) => { onSnapshot(sharedDocument, () => resolve(), reject); })'
      : '() => getDoc(sharedDocument)';
    const fixture = await startSoakServe({
      flags: isHosted ? ['--hosted', '--no-capture'] : ['--no-capture'],
      extraFiles: {
        'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
        'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8') + `
          const { getDoc } = await import('firebase/firestore');
          const readDocument = ${read};
          const readButton = document.createElement('button');
          readButton.textContent = 'Read';
          const readResult = document.createElement('output');
          readResult.id = 'read-result';
          readButton.onclick = async () => {
            readResult.textContent = 'Pending';
            try { await readDocument(); readResult.textContent = 'Accepted'; }
            catch (error) { readResult.textContent = error.code + ': ' + error.message; }
          };
          document.body.append(readButton, readResult);
        `,
      },
    });
    try {
      const json = '{"nested":'.repeat(65) + 'null' + '}'.repeat(65);
      await installDocumentReplyFault(page, json, delivery);
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(fixture.info.url);
      await page.locator('#write').click();
      await expect(page.locator('#write-result')).toHaveText('Written');
      await page.evaluate(() => { document.documentElement.dataset.inject = 'true'; });
      await page.getByRole('button', { name: 'Read', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-injected', 'true');
      await expect(page.locator('#read-result')).toHaveText('invalid-argument: Encoded document nesting exceeds 64 containers.');
      await page.getByRole('button', { name: 'Read', exact: true }).click();
      await expect(page.locator('#read-result')).toHaveText('Accepted');
      expect(errors).toEqual([]);
    } finally {
      await page.close().finally(() => fixture.stop());
    }
  });
}
}
