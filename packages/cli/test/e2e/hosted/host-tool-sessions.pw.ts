import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, test } from '@playwright/test';
import { startPausedPersistenceHost } from './paused-persistence-fixture.js';

test('closed MCP sessions cannot accumulate unbounded host execution owners', async ({ page }) => {
  test.setTimeout(60_000);
  const host = await startPausedPersistenceHost({ browser: true,
    rules: "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /held/{document} { allow read: if true; } } }",
  });
  try {
    await page.goto(host.url);
    await expect(page.locator('#ready')).toHaveText('Ready');
    await page.evaluate(async () => {
      const storage = await import('firebase/storage');
      await storage.uploadBytes(storage.ref(storage.getStorage(), 'files/shared.txt'),
        new TextEncoder().encode('Existing object'));
    });
    const probe = new Client({ name: 'session-probe', version: '1' });
    try {
      const url = new URL(`${host.url}/__pyric/mcp`);
      await probe.connect(new StreamableHTTPClientTransport(url));
      const callers = Array.from({ length: 64 }, (_, index) => index);
      for (const round of [0, 1]) {
        const rearmsPersistence = round === 1;
        if (rearmsPersistence) {
          host.pause();
        }
        for (const index of callers) {
          const client = new Client({ name: `closed-caller-${index}`, version: '1' });
          const transport = new StreamableHTTPClientTransport(url);
          try {
            await client.connect(transport);
            const path = `held/owner-${round}-${index}`;
            const call = client.callTool({ name: 'firestore_create_document', arguments: {
              path, data: { round, index }, as: 'admin',
            } }).then(() => 'completed', () => 'canceled');
            await expect.poll(() => page.evaluate(async (path) => {
              const app = await import('firebase/app');
              const firestore = await import('firebase/firestore');
              const reference = firestore.doc(firestore.getFirestore(app.getApp()), path);
              return (await firestore.getDoc(reference)).data();
            }, path)).toEqual({ round, index });
            await transport.terminateSession();
            await client.close();
            expect(await call).toBe('canceled');
          } finally {
            await client.close();
          }
        }
        expect(host.held()).toBe(true);
        // The application SDK has a separate owner and remains usable.
        await page.reload();
        await expect(page.locator('#ready')).toHaveText('Ready');
        expect(await page.evaluate(async () => {
          const storage = await import('firebase/storage');
          const listing = await storage.listAll(storage.ref(storage.getStorage(), 'files'));
          return listing.items.map(item => item.fullPath);
        })).toContain('files/shared.txt');
        await expect(probe.callTool({ name: 'auth_whoami', arguments: {} })).resolves.toMatchObject({ isError: false });
        let excessResult: unknown;
        const excess = probe.callTool({ name: 'firestore_create_document', arguments: {
          path: 'limit/refused', data: { message: 'Must not execute' }, as: 'admin',
        } }).then(result => { excessResult = result; });
        try {
          await expect.poll(() => excessResult, { timeout: 3_000 }).toMatchObject({
            isError: true, content: [{ text: expect.stringContaining('session cap (64)') }],
          });
        } finally {
          host.release();
          await excess;
        }
        await expect.poll(() => probe.callTool({ name: 'firestore_get_document', arguments: {
          path: 'limit/refused', as: 'admin',
        } })).toMatchObject({ isError: false, content: [{ text: expect.stringContaining('"exists": false') }] });
        await expect(probe.callTool({ name: 'firestore_create_document', arguments: {
          path: 'limit/drained', data: { round }, as: 'admin',
        } })).resolves.toMatchObject({ isError: false });
      }
    } finally {
      host.release();
      await probe.close();
    }
  } finally {
    await page.close().finally(() => host.stop());
  }
});
