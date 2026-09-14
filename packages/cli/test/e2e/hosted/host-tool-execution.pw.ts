import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { McpHttpClient } from '../soak/harness.js';
import { startHostWithPausedStorageRead, startStoragePersistenceFixture } from './storage-persistence-fixture.js';

for (const failsPersistence of [false, true]) {
  test(`a stalled MCP mutation isolates session execution (persistence failure: ${failsPersistence})`, async ({ page }) => {
    const fixture = await startStoragePersistenceFixture();
    const expectsMutationSuccess = !failsPersistence;
    try {
      await page.goto(fixture.info.url);
      await expect(page.locator('#ready')).toHaveText('Ready');
      await page.getByLabel('Value', { exact: true }).fill('Existing object');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.locator('#saved')).toHaveText('Saved');
      await page.close();
      const host = await startHostWithPausedStorageRead(fixture);
      try {
        expect(await host.startup, host.stderr()).toEqual({ kind: 'ready' });
        const busy = new McpHttpClient(`${fixture.info.url}/__pyric/mcp`);
        const healthy = new McpHttpClient(`${fixture.info.url}/__pyric/mcp`);
        await busy.initialize();
        await healthy.initialize();
        const mutation = busy.toolCall('firestore_create_document', {
          path: 'held/document', data: { message: 'Committed in memory' }, as: 'admin',
        });
        await expect.poll(host.stderr).toContain('Storage binary read paused');
        let queuedResult: unknown;
        const queuedRead = busy.toolCall('firestore_get_document', { path: 'held/document', as: 'admin' })
          .then(value => { queuedResult = value; });
        let result: unknown;
        const reading = healthy.toolCall('firestore_get_document', { path: 'held/document', as: 'admin' })
          .then(value => { result = value; });
        try {
          await expect.poll(() => result, { timeout: 3_000 }).toMatchObject({
            ok: true, data: { exists: true, data: { message: 'Committed in memory' } },
          });
          expect(queuedResult).toBeUndefined();
          if (failsPersistence) chmodSync(join(fixture.dir, '.pyric', 'state'), 0o500);
        } finally {
          host.child.kill('SIGUSR2');
          await reading;
          await expect(mutation).resolves.toMatchObject({ ok: expectsMutationSuccess });
          await queuedRead;
          expect(queuedResult).toMatchObject({ ok: true, data: { exists: true } });
        }
        await expect(busy.toolCall('firestore_get_document', { path: 'held/document', as: 'admin' }))
          .resolves.toMatchObject({ ok: true, data: { exists: true } });
      } finally {
        chmodSync(join(fixture.dir, '.pyric', 'state'), 0o700);
        host.child.kill('SIGUSR2');
        await host.stop();
      }
    } finally {
      await fixture.stop();
    }
  });
}
