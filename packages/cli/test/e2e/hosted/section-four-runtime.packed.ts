import { expect, test, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { packedProject, startPackedServer } from './section-four-fixture.js';

async function writeAndObserve(page: Page) {
  const before = Number(await page.locator('#updates').innerText());
  await page.getByRole('button', { name: 'Write document', exact: true }).click();
  await expect(page.locator('#result')).toHaveText('Written');
  await expect(page.locator('#updates')).toHaveText(String(before + 1));
  const uid = await page.locator('#uid').innerText();
  const document: unknown = JSON.parse(await page.locator('#document').innerText());
  expect(document).toMatchObject({ uid });
}

for (const mode of ['hosted', 'sharedworker', 'inpage'] as const) {
  test(`installed CLI ${mode} serves Auth and one listener through reload and warm restart`, async ({ page }) => {
    const project = packedProject();
    const isHosted = mode === 'hosted';
    const hostMode = isHosted ? 'hosted' : 'sharedworker';
    const isInpage = mode === 'inpage';
    const suffix = isInpage ? '/?runtime=inpage' : '/';
    const expectedMode = isInpage ? 'in-page' : hostMode.replace('sharedworker', 'shared-worker');
    let server = startPackedServer(project, hostMode);
    try {
      const url = await server.url;
      await page.goto(`${url.replace(/\/$/, '')}${suffix}`);
      await expect(page.locator('#runtime')).toHaveText(expectedMode);
      await expect(page.locator('#updates')).toHaveText('1');
      await writeAndObserve(page);
      await page.reload();
      await expect(page.locator('#runtime')).toHaveText(expectedMode);
      await expect(page.locator('#updates')).toHaveText('1');
      await writeAndObserve(page);
      await page.goto('about:blank');
      await server.stop();
      server = startPackedServer(project, hostMode, Number(new URL(url).port));
      await server.url;
      await page.goto(`${url.replace(/\/$/, '')}${suffix}`);
      await expect(page.locator('#runtime')).toHaveText(expectedMode);
      await expect(page.locator('#updates')).toHaveText('1');
      await writeAndObserve(page);
    } finally {
      await page.close();
      await server.stop();
      project.close();
    }
  });
}

for (const mode of ['sharedworker', 'inpage'] as const) {
  test(`installed Vite ${mode} preserves identity and one listener through HMR, reload and warm startup`, async ({ page }) => {
    const project = packedProject();
    const isInpage = mode === 'inpage';
    const suffix = isInpage ? '?runtime=inpage' : '';
    const expectedMode = isInpage ? 'in-page' : 'shared-worker';
    let server = startPackedServer(project, 'vite');
    try {
      const url = await server.url;
      await page.goto(`${url}${suffix}`);
      await expect(page.locator('#runtime')).toHaveText(expectedMode);
      await expect(page.locator('#updates')).toHaveText('1');
      await writeAndObserve(page);
      const uid = await page.locator('#uid').innerText();
      const main = join(project.dir, 'main.js');
      writeFileSync(main, readFileSync(main, 'utf8').replace('version-one', 'version-two'));
      await expect(page.locator('#version')).toHaveText('version-two');
      await expect(page.locator('#uid')).toHaveText(uid);
      await expect(page.locator('#runtime')).toHaveText(expectedMode);
      await expect(page.locator('#updates')).toHaveText('1');
      await writeAndObserve(page);
      await page.reload();
      await expect(page.locator('#version')).toHaveText('version-two');
      await expect(page.locator('#runtime')).toHaveText(expectedMode);
      await expect(page.locator('#updates')).toHaveText('1');
      await writeAndObserve(page);
      await page.goto('about:blank');
      await server.stop();
      server = startPackedServer(project, 'vite', Number(new URL(url).port));
      await server.url;
      await page.goto(`${url}${suffix}`);
      await expect(page.locator('#runtime')).toHaveText(expectedMode);
      await expect(page.locator('#updates')).toHaveText('1');
      await writeAndObserve(page);
    } finally {
      await page.close();
      await server.stop();
      project.close();
    }
  });
}
