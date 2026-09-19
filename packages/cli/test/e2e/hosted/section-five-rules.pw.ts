import { expect, test, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startSoakServe } from '../soak/harness.js';

function firestoreRules(condition: string): string {
  return `rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /checks/{id} { allow read, write: if ${condition}; } } }`;
}
function databaseRules(condition: string): string {
  return JSON.stringify({ rules: { checks: { '.read': condition, '.write': condition } } });
}
async function succeeds(page: Page, action: string): Promise<void> {
  await page.locator(`#${action}`).click();
  await expect(page.locator('#result')).toHaveText('Succeeded');
}
async function denied(page: Page, action: string): Promise<void> {
  await page.locator(`#${action}`).click();
  await expect(page.locator('#result')).toHaveText(/permission[-_]denied/i);
}

for (const mode of ['hosted', 'shared-worker', 'in-page'] as const) {
  for (const service of ['firestore', 'database'] as const) {
    test(`${mode} ${service} file edits enforce rules on two active apps and recover after an invalid edit`, async ({ context }) => {
      const hosted = mode === 'hosted';
      const inpage = mode === 'in-page';
      const isFirestore = service === 'firestore';
      const fixture = await startSoakServe({ flags: hosted ? ['--hosted', '--no-capture'] : ['--no-capture'], extraFiles: {
        'index.html': readFileSync(new URL('../../manual/section-five/index.html', import.meta.url), 'utf8'),
        'main.js': readFileSync(new URL('../../manual/section-five/main.js', import.meta.url), 'utf8'),
        'firestore.rules': firestoreRules('request.auth != null'),
        'database.rules.json': databaseRules('auth != null'),
      } });
      const red = await context.newPage();
      const blue = await context.newPage();
      try {
        if (inpage) await context.addInitScript(() => { Reflect.set(globalThis, '__PYRIC_FORCE_INPAGE__', true); });
        await red.goto(`${fixture.info.url}/?app=red&service=${service}`);
        await blue.goto(`${fixture.info.url}/?app=blue&service=${service}`);
        for (const page of [red, blue]) {
          await expect(page.locator('#result')).toHaveText('Ready');
          await expect(page.locator('#runtime')).toHaveText(mode);
          await succeeds(page, 'write');
          await succeeds(page, 'read');
        }
        const redUid = await red.locator('#uid').innerText();
        expect(await blue.locator('#uid').innerText()).not.toBe(redUid);
        const path = join(fixture.dir, isFirestore ? 'firestore.rules' : 'database.rules.json');
        const restricted = isFirestore ? firestoreRules(`request.auth.uid == '${redUid}'`) : databaseRules(`auth.uid == '${redUid}'`);
        writeFileSync(path, restricted);
        await expect(blue.locator('#listener')).toHaveText(/permission[-_]denied/i);
        const deniedDeliveries = await blue.locator('#updates').innerText();
        await denied(blue, 'write');
        await denied(blue, 'read');
        const before = Number(await red.locator('#updates').innerText());
        await succeeds(red, 'write');
        await expect(red.locator('#updates')).toHaveText(String(before + 1));
        await expect(blue.locator('#updates')).toHaveText(deniedDeliveries);
        writeFileSync(path, 'not valid rules {');
        await expect.poll(() => fixture.stdout() + fixture.stderr()).toContain('NOT reloaded (last-good stays live)');
        await denied(blue, 'write');
        await succeeds(red, 'write');
        const restored = isFirestore ? firestoreRules('request.auth != null') : databaseRules('auth != null');
        writeFileSync(path, restored);
        await expect.poll(async () => {
          await blue.locator('#read').click();
          await expect(blue.locator('#result')).not.toHaveText('Working');
          return blue.locator('#result').innerText();
        }).toBe('Succeeded');
        await blue.locator('#listen').click();
        await expect(blue.locator('#listener')).not.toHaveText(/permission[-_]denied/i);
        await succeeds(blue, 'write');
        await succeeds(red, 'read');
      } finally {
        await red.close();
        await blue.close();
        await fixture.stop();
      }
    });
  }
}
