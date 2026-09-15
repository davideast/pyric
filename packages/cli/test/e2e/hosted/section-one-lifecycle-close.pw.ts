import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { z } from 'zod';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import type { InitPayload } from '../../../src/serve/init-payload.js';
import { startHost } from './host-process.js';
import { openMethodWire } from './host-method-wire.js';
import { startStoragePersistenceFixture } from './storage-persistence-fixture.js';
import { CLI_PATH } from '../soak/harness.js';

test('overlapping runtime close calls wait for accepted work to finish', async () => {
  test.setTimeout(15_000);
  const project = mkdtempSync(join(tmpdir(), 'pyric-runtime-close-'));
  const upstream = createServer((request, response) => {
    request.resume();
    heldResponse = response;
  });
  const payload: InitPayload = {
    rules: null, rulesHash: null, storageRules: null, storageRulesHash: null,
    bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: project,
  };
  let runtime: Awaited<ReturnType<typeof createHostedRuntime>> | undefined;
  let replacement: Awaited<ReturnType<typeof createHostedRuntime>> | undefined;
  let heldResponse: ServerResponse | undefined;
  let closingWork: Promise<void> | undefined;
  function release(): void {
    const response = heldResponse;
    const cannotReply = response === undefined || response.writableEnded;
    if (cannotReply) return;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      id: 'close', object: 'chat.completion', created: 0, model: 'local',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Finished' }, finish_reason: 'stop' }],
    }));
  }
  try {
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    const hasNoAddress = address === null || typeof address === 'string';
    if (hasNoAddress) throw new Error('The local upstream has no address.');
    const replies: BridgeMessage[] = [];
    runtime = await createHostedRuntime(payload, `http://127.0.0.1:${address.port}`, reply => replies.push(reply), project);
    runtime.receive({ type: 'worker-message', clientSessionId: 'app', message: {
      t: 'op', id: 'held', method: 'ai.generateContent', model: 'local',
      request: { contents: [{ role: 'user', parts: [{ text: 'Finish before closing' }] }] },
      engine: { kind: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1` },
    } });
    await expect.poll(() => heldResponse !== undefined, { timeout: 5_000, message: 'Accepted AI work must reach the real upstream.' }).toBe(true);
    runtime.receive({ type: 'worker-message', clientSessionId: 'app', message: {
      t: 'op', id: 'write', method: 'setDoc', path: 'shared/close',
      data: { message: 'Accepted before close' }, actAs: { mode: 'admin' },
    } });
    const completed: string[] = [];
    const first = runtime.close().then(() => { completed.push('first'); });
    closingWork = first;
    const second = runtime.close().then(() => { completed.push('second'); });
    // Let close promises settle while the real accepted request remains held.
    await setImmediate();
    expect(completed).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(completed).toEqual(['first', 'second']);
    expect(replies).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'worker-message-result', message: expect.objectContaining({ t: 'res', id: 'write', ok: true }) }),
    ]));
    const restored: BridgeMessage[] = [];
    replacement = await createHostedRuntime(payload, `http://127.0.0.1:${address.port}`, reply => restored.push(reply), project);
    replacement.receive({ type: 'worker-message', clientSessionId: 'replacement', message: {
      t: 'op', id: 'read', method: 'getDoc', path: 'shared/close', actAs: { mode: 'admin' },
    } });
    await expect.poll(() => restored).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'worker-message-result', message: expect.objectContaining({
        t: 'res', id: 'read', ok: true, value: expect.objectContaining({
          data: expect.objectContaining({ json: JSON.stringify({ message: 'Accepted before close' }) }),
        }),
      }) }),
    ]));
  } finally {
    release();
    await closingWork;
    await runtime?.close();
    await replacement?.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    rmSync(project, { recursive: true, force: true });
  }
});

for (const caller of ['MCP', 'direct command']) {
  test(`shutdown drains accepted ${caller} work after its caller closes`, async ({ page }) => {
    test.setTimeout(30_000);
    const fixture = await startStoragePersistenceFixture();
    let host: ReturnType<typeof startHost> | undefined;
    let heldRead: ServerResponse | undefined;
    const persistenceIo = createServer((request, response) => {
      request.resume();
      heldRead = response;
    });
    let contender: ReturnType<typeof startHost> | undefined;
    let replacement: ReturnType<typeof startHost> | undefined;
    let closeCaller: (() => Promise<void>) | undefined;
    try {
      await page.goto(fixture.info.url);
      await expect(page.locator('#ready')).toHaveText('Ready');
      await page.getByLabel('Value', { exact: true }).fill('Persisted object');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.locator('#saved')).toHaveText('Saved');
      await page.close();
      const firstExit = once(fixture.child, 'exit');
      fixture.child.kill('SIGTERM');
      await expect.poll(() => fixture.child.exitCode, { timeout: 5_000 }).toBe(0);
      await firstExit;
      await new Promise<void>(resolve => persistenceIo.listen(0, '127.0.0.1', resolve));
      const address = persistenceIo.address();
      const hasNoAddress = address === null || typeof address === 'string';
      if (hasNoAddress) throw new Error('Persistence I/O upstream has no address.');
      const preload = join(fixture.dir, 'hold-persistence-io.mjs');
      writeFileSync(preload, `
        const readBytes = Blob.prototype.arrayBuffer;
        let paused = false;
        Blob.prototype.arrayBuffer = async function () {
          const bytes = await readBytes.call(this);
          const pausesThisRead = !paused && this.type === 'text/plain';
          if (pausesThisRead) {
            paused = true;
            process.stderr.write('Storage binary read paused\\n');
            const response = await fetch('http://127.0.0.1:${address.port}/release');
            await response.text();
          }
          return bytes;
        };
      `);
      host = startHost(fixture.dir, fixture.info.port, [process.execPath, '--import', preload, CLI_PATH]);
      expect(await host.startup, host.stderr()).toEqual({ kind: 'ready' });
      const usesMcp = caller === 'MCP';
      if (usesMcp) {
        const client = new Client({ name: 'shutdown-caller', version: '1' });
        const transport = new StreamableHTTPClientTransport(new URL(`${fixture.info.url}/__pyric/mcp`));
        closeCaller = () => client.close();
        await client.connect(transport);
        const accepted = client.callTool({ name: 'firestore_add_document', arguments: {
          collection: 'shutdown', data: { message: 'Accepted once' }, as: 'admin',
        } }).then(() => 'completed', () => 'canceled');
        await expect.poll(host.stderr, { timeout: 5_000, message: 'MCP mutation must reach held persistence.' }).toContain('Storage binary read paused');
        await transport.terminateSession();
        await client.close();
        expect(await accepted).toBe('canceled');
      } else {
        const wire = await openMethodWire(fixture.info.url, fixture.dir);
        closeCaller = () => wire.close();
        wire.command('firestore.addDoc', { path: 'shutdown', data: { message: 'Accepted once' } });
        await expect.poll(host.stderr, { timeout: 5_000, message: 'Direct mutation must reach held persistence.' }).toContain('Storage binary read paused');
        await wire.close();
      }
      await expect.poll(() => heldRead !== undefined, { timeout: 5_000, message: 'Accepted persistence must own an actual pending HTTP read.' }).toBe(true);
      const exited = once(host.child, 'exit');
      host.child.kill('SIGTERM');
      await expect.poll(host.stderr, { timeout: 5_000 }).toContain('Shutting down...');
      contender = startHost(fixture.dir, fixture.info.port);
      expect(await contender.startup, contender.stderr()).toEqual({ kind: 'exit', code: 2 });
      expect(contender.stderr()).toContain('already owns this project');
      expect(host.child.exitCode).toBeNull();
      heldRead?.end('Released');
      const child = host.child;
      await expect.poll(() => child.exitCode, { timeout: 5_000, message: 'Released host must exit without forced termination.' }).toBe(0);
      expect(await exited).toEqual([0, null]);
      replacement = startHost(fixture.dir, fixture.info.port);
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      const remote = await connectRemoteSandbox({ url: fixture.info.url });
      try {
        const result = await remote.channel.op({ method: 'getDocs', source: { __ref: 'collection', path: 'shutdown' }, actAs: { mode: 'admin' } });
        const snapshot = z.object({ docs: z.array(z.object({ data: z.object({ json: z.string() }) })) }).parse(result);
        expect(snapshot.docs).toHaveLength(1);
        expect(JSON.parse(snapshot.docs[0]?.data.json ?? 'null')).toEqual({ message: 'Accepted once' });
      } finally {
        remote.close();
      }
    } finally {
      heldRead?.end('Released');
      await closeCaller?.();
      await contender?.stop();
      await replacement?.stop();
      await host?.stop();
      await fixture.stop();
      persistenceIo.closeAllConnections();
      await new Promise<void>(resolve => persistenceIo.close(() => resolve()));
    }
  });
}
