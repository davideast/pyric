import { expect, test, type Page } from '@playwright/test';

const WORKER_OP_HELPER = `
  function workerOp(worker, msg) {
    worker.port.start();
    return new Promise((resolve, reject) => {
      const handler = (event) => {
        if (event.data.t === 'res' && event.data.id === msg.id) {
          worker.port.removeEventListener('message', handler);
          if (event.data.ok === false) {
            reject(new Error(JSON.stringify(event.data)));
          } else {
            resolve(event.data);
          }
        }
      };
      worker.port.addEventListener('message', handler);
      worker.port.postMessage(msg);
    });
  }
`;

interface BoxMetric {
  readonly selector: string;
  readonly clientWidth: number;
  readonly scrollWidth: number;
}

async function measureSelectors(page: Page, selectors: readonly string[]): Promise<BoxMetric[]> {
  return await page.evaluate((list) => {
    const out: Array<{ selector: string; clientWidth: number; scrollWidth: number }> = [];
    for (const selector of list) {
      const el = document.querySelector(selector);
      if (!el) continue;
      out.push({
        selector,
        clientWidth: el.clientWidth,
        scrollWidth: el.scrollWidth,
      });
    }
    return out;
  }, selectors);
}

function assertNoHorizontalOverflow(metrics: readonly BoxMetric[], expectedSelectors: readonly string[]): void {
  const seen = new Set(metrics.map((item) => item.selector));
  for (const selector of expectedSelectors) {
    expect(seen.has(selector), `expected selector to be mounted: ${selector}`).toBe(true);
  }
  for (const item of metrics) {
    expect(
      item.scrollWidth,
      `${item.selector} overflowed horizontally (${item.scrollWidth} > ${item.clientWidth})`,
    ).toBeLessThanOrEqual(item.clientWidth);
  }
}

test('Studio Auth and Storage panes fit a 768 px viewport without horizontal overflow (#2501)', async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 768, height: 800 },
    reducedMotion: 'reduce',
  });
  try {
    const app = await context.newPage();
    await app.goto('/');
    await expect(app.locator('#status')).not.toHaveText('loading');

    await app.evaluate(async (helper) => {
      // eslint-disable-next-line no-new-func
      const op = new Function(`${helper}; return workerOp;`)();
      const generation = localStorage.getItem('pyric:worker-generation');
      const workerName = generation ? `pyric-shared-worker:${generation}` : 'pyric-shared-worker';
      const worker = new SharedWorker('/__pyric/sdk/worker.js', { name: workerName });
      await op(worker, {
        t: 'op',
        id: 'fs-seed-2501',
        method: 'admin.setDocument',
        path: 'notes/welcome-768',
        data: { title: 'Viewport check at 768 px', owner: 'user-alice-768' },
      });
      await op(worker, {
        t: 'op',
        id: 'auth-seed-1',
        method: 'auth.adminCreateUser',
        request: {
          uid: 'user-alice-768',
          email: 'alice.long.identifier.address@example.com',
          displayName: 'Alice Nguyen',
          emailVerified: true,
          providerUserInfo: [{ providerId: 'google.com' }, { providerId: 'github.com' }],
        },
      });
      await op(worker, {
        t: 'op',
        id: 'auth-seed-2',
        method: 'auth.adminCreateUser',
        request: {
          uid: 'user-bob-768',
          email: 'bob.carter@example.com',
          password: 'password123',
          displayName: 'Bob Carter',
        },
      });
      await op(worker, {
        t: 'op',
        id: 'auth-seed-3',
        method: 'auth.adminCreateUser',
        request: {
          uid: 'user-carol-768',
          email: 'carol.diaz@example.com',
          displayName: 'Carol Diaz',
        },
      });
    }, WORKER_OP_HELPER);

    const studio = await context.newPage();

    // Baseline check: Firestore fits cleanly at 768 px.
    await studio.goto('/__pyric/ui/firestore/notes/welcome-768');
    await expect(studio.locator('[data-pyric-ui="fs-browser"]')).toHaveAttribute(
      'data-size',
      'medium',
    );
    const firestoreSelectors = [
      'html',
      'body',
      '.studio',
      '.studio__content',
      '[data-pyric-ui="fs-browser"]',
      '[data-pyric-ui="fs-browser"] .fs-columns',
    ];
    assertNoHorizontalOverflow(await measureSelectors(studio, firestoreSelectors), firestoreSelectors);

    // Auth at 768 px: user rows are clickable and neither the page nor .auth-list overflows.
    await studio.goto('/__pyric/ui/auth/');
    await expect(studio.locator('[data-pyric-user-entry]').first()).toBeVisible();
    const authListSelectors = [
      'html',
      'body',
      '.studio',
      '.studio__content',
      '.auth-surface',
      '.auth-sub',
      '.auth-body',
      '.auth-list',
      '[data-pyric-ui="auth-user-list"]',
      '[data-pyric-user-header]',
      '[data-pyric-user-entry]',
      '.auth-detail',
    ];
    assertNoHorizontalOverflow(await measureSelectors(studio, authListSelectors), authListSelectors);

    await studio.locator('[data-pyric-user-select]').first().click();
    await expect(studio.locator('[data-pyric-ui="auth-user-form"]')).toBeVisible();
    assertNoHorizontalOverflow(await measureSelectors(studio, authListSelectors), authListSelectors);

    // Storage at 768 px: upload files, select an object, and drill into a deep folder breadcrumb.
    await studio.goto('/__pyric/ui/storage/');
    await expect(studio.locator('.storage__browser')).toBeVisible();
    await studio.locator('input[type="file"]').setInputFiles([
      {
        name: 'avatar-profile-banner-2026.png',
        mimeType: 'image/png',
        buffer: Buffer.from([137, 80, 78, 71]),
      },
      {
        name: 'quarterly-architecture-notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('hello storage 768'),
      },
    ]);
    await expect(studio.locator('[data-pyric-entry-select]').first()).toBeVisible();

    const storageSelectors = [
      'html',
      'body',
      '.studio',
      '.studio__content',
      '.storage',
      '.storage__sub',
      '[data-pyric-ui="path-breadcrumb"]',
      '.storage__body',
      '.storage__browser',
      '.storage__lhead',
      '[data-pyric-entry-select]',
      '.storage__inspector',
    ];
    assertNoHorizontalOverflow(await measureSelectors(studio, storageSelectors), storageSelectors);

    await studio.locator('[data-pyric-entry-select]').first().click();
    await expect(studio.locator('[data-pyric-object-metadata]')).toBeVisible();
    assertNoHorizontalOverflow(await measureSelectors(studio, storageSelectors), storageSelectors);

    await studio.getByRole('button', { name: 'New folder' }).click();
    await studio
      .getByLabel('New folder name')
      .fill('projects/2026-q4-campaign/shared-assets/thumbnails-and-previews/high-resolution');
    await studio.getByRole('button', { name: 'Create' }).click();
    const deepCrumbSelectors = [
      'html',
      'body',
      '.studio',
      '.studio__content',
      '.storage',
      '.storage__sub',
      '.storage__body',
      '.storage__browser',
      '.storage__lhead',
      '.storage__inspector',
    ];
    assertNoHorizontalOverflow(await measureSelectors(studio, deepCrumbSelectors), deepCrumbSelectors);
  } finally {
    await context.close();
  }
});
