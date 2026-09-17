import { setPersistenceWritable } from './persistence-fault.js';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { McpHttpClient } from '../soak/harness.js';
import { startPausedPersistenceHost } from './paused-persistence-fixture.js';

for (const failsPersistence of [false, true]) {
  test(`a stalled MCP mutation isolates session execution (persistence failure: ${failsPersistence})`, async () => {
    const host = await startPausedPersistenceHost();
    const expectsMutationSuccess = !failsPersistence;
    try {
      try {
        const busy = new McpHttpClient(`${host.url}/__pyric/mcp`);
        const healthy = new McpHttpClient(`${host.url}/__pyric/mcp`);
        await busy.initialize();
        await healthy.initialize();
        const mutation = busy.toolCall('firestore_create_document', {
          path: 'held/document', data: { message: 'Committed in memory' }, as: 'admin',
        });
        await expect.poll(host.held).toBe(true);
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
          if (failsPersistence) setPersistenceWritable(join(host.dir, '.pyric', 'state'), false);
        } finally {
          host.release();
          await reading;
          await expect(mutation).resolves.toMatchObject({ ok: expectsMutationSuccess });
          await queuedRead;
          expect(queuedResult).toMatchObject({ ok: true, data: { exists: true } });
        }
        await expect(busy.toolCall('firestore_get_document', { path: 'held/document', as: 'admin' }))
          .resolves.toMatchObject({ ok: true, data: { exists: true } });
      } finally {
        setPersistenceWritable(join(host.dir, '.pyric', 'state'), true);
        host.release();
      }
    } finally {
      await host.stop();
    }
  });
}
