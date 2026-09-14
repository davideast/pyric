import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, CancelledNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { expect, test } from '@playwright/test';
import { McpHttpClient } from '../soak/harness.js';
import { mcpByteWriteArgs } from './mcp-byte-fixture.js';
import { startHostWithPausedStorageRead, startStoragePersistenceFixture } from './storage-persistence-fixture.js';

const scenarios = [
  { byteBound: false, failsPersistence: false },
  { byteBound: false, failsPersistence: true },
  { byteBound: true, failsPersistence: false },
];

for (const { byteBound, failsPersistence } of scenarios) {
  test(`host admission retains canceled work (bytes: ${byteBound}, persistence failure: ${failsPersistence})`, async ({ page }) => {
    test.setTimeout(60_000);
    const pendingCount = byteBound ? 32 : 256;
    const refusal = byteBound ? '24 MiB queued operation byte limit' : '256 pending operations';
    const fixture = await startStoragePersistenceFixture();
    const client = new Client({ name: 'host-admission', version: '1' });
    let receivedCalls = 0;
    let receivedCancellations = 0;
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
        const transport = new StreamableHTTPClientTransport(new URL(`${fixture.info.url}/__pyric/mcp`), {
          async fetch(input, init) {
            const request = new Request(input, init);
            const isPost = request.method === 'POST';
            const body: unknown = isPost ? await request.clone().json() : undefined;
            const response = await fetch(request);
            const isToolStream = CallToolRequestSchema.safeParse(body).success && response.status === 200;
            const isCancellation = CancelledNotificationSchema.safeParse(body).success && response.status === 202;
            if (isToolStream) receivedCalls += 1;
            if (isCancellation) receivedCancellations += 1;
            return response;
          },
        });
        await client.connect(transport);
        const controllers = Array.from({ length: pendingCount }, () => new AbortController());
        const firstArgs = byteBound
          ? mcpByteWriteArgs('held/document', 0)
          : { path: 'held/document', data: { message: 'Held persistence' }, as: 'admin' };
        const first = client.callTool({ name: 'firestore_create_document', arguments: firstArgs },
          undefined, { signal: controllers[0].signal }).then(() => 'completed', () => 'canceled');
        await expect.poll(host.stderr).toContain('Storage binary read paused');
        const calls = [first, ...controllers.slice(1).map((controller, index) => {
          const name = byteBound ? 'firestore_create_document' : 'firestore_get_document';
          const args = byteBound ? mcpByteWriteArgs('held/document', index + 1) : { path: 'held/document', as: 'admin' };
          return client.callTool({ name, arguments: args }, undefined, { signal: controller.signal })
            .then(() => 'completed', () => 'canceled');
        })];
        // The real HTTP transport returns each response stream after dispatching its request.
        await expect.poll(() => receivedCalls).toBe(pendingCount);
        for (const controller of controllers) controller.abort();
        await expect.poll(() => receivedCancellations).toBe(pendingCount);
        expect(await Promise.all(calls)).toEqual(Array(pendingCount).fill('canceled'));
        await expect(client.callTool({ name: 'auth_whoami', arguments: {} })).resolves.toMatchObject({ isError: false });
        let excessResult: unknown;
        const excess = client.callTool({ name: 'firestore_create_document', arguments: {
          path: 'limit/refused', data: { message: 'x'.repeat(8 * 1024) }, as: 'admin',
        } }).then(result => { excessResult = result; });
        const healthy = new McpHttpClient(`${fixture.info.url}/__pyric/mcp`);
        await healthy.initialize();
        try {
          await expect.poll(() => excessResult, { timeout: 3_000 }).toMatchObject({
            isError: true, content: [{ text: expect.stringContaining(refusal) }],
          });
          await expect(healthy.toolCall('firestore_get_document', { path: 'limit/refused', as: 'admin' }))
            .resolves.toMatchObject({ ok: true, data: { exists: false } });
          if (failsPersistence) chmodSync(join(fixture.dir, '.pyric', 'state'), 0o500);
        } finally {
          host.child.kill('SIGUSR2');
          await excess;
        }
        await expect.poll(() => client.callTool({ name: 'firestore_get_document', arguments: {
          path: 'limit/refused', as: 'admin',
        } })).toMatchObject({ isError: false, content: [{ text: expect.stringContaining('"exists": false') }] });
      } finally {
        chmodSync(join(fixture.dir, '.pyric', 'state'), 0o700);
        host.child.kill('SIGUSR2');
        await client.close();
        await host.stop();
      }
    } finally {
      await fixture.stop();
    }
  });
}
