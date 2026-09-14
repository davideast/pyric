import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, test } from '@playwright/test';
import { CLI_PATH } from '../soak/harness.js';
import { startHost } from './host-process.js';
import { writeHeldStorageReadPreload } from './held-storage-read.js';
import { startStoragePersistenceFixture } from './storage-persistence-fixture.js';

test('closed MCP sessions cannot accumulate unbounded host execution owners', async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = await startStoragePersistenceFixture();
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#ready')).toHaveText('Ready');
    await page.evaluate(async () => {
      const app = await import('firebase/app');
      const storage = await import('firebase/storage');
      await storage.uploadBytes(storage.ref(storage.getStorage(app.getApp()), 'files/shared.txt'),
        new TextEncoder().encode('Existing object'), { contentType: 'application/x-pyric-held' });
    });
    const firstExit = once(fixture.child, 'exit');
    fixture.child.kill('SIGTERM');
    await firstExit;
    writeFileSync(join(fixture.dir, 'firebase.json'), '{"firestore":{"rules":"firestore.rules"},"storage":{"rules":"storage.rules"}}');
    writeFileSync(join(fixture.dir, 'firestore.rules'),
      "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /held/{document} { allow read: if true; } } }");
    const preload = join(fixture.dir, 'hold-storage-read.mjs');
    writeHeldStorageReadPreload(preload, false);
    const host = startHost(fixture.dir, fixture.info.port, [process.execPath, '--import', preload, CLI_PATH]);
    const probe = new Client({ name: 'session-probe', version: '1' });
    let holding = true;
    try {
      expect(await host.startup, host.stderr()).toEqual({ kind: 'ready' });
      await page.reload();
      await expect(page.locator('#ready')).toHaveText('Ready');
      const url = new URL(`${fixture.info.url}/__pyric/mcp`);
      await probe.connect(new StreamableHTTPClientTransport(url));
      const callers = Array.from({ length: 64 }, (_, index) => index);
      for (const round of [0, 1]) {
        const rearmsReads = round === 1;
        if (rearmsReads) {
          host.child.kill('SIGUSR2');
          holding = true;
          await expect.poll(host.stderr).toContain('ARMED\n');
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
        await expect.poll(host.stderr).toContain('HELD\n');
        // The application SDK has a separate owner and remains usable.
        await page.reload();
        await expect(page.locator('#ready')).toHaveText('Ready');
        await page.getByRole('button', { name: 'List files', exact: true }).click();
        await expect(page.locator('#files')).toContainText('files/shared.txt');
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
          host.child.kill('SIGUSR2');
          holding = false;
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
      if (holding) host.child.kill('SIGUSR2');
      await probe.close();
      await host.stop();
    }
  } finally {
    await fixture.stop();
  }
});
