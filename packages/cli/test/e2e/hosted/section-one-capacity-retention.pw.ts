import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, CancelledNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { expect, test } from '@playwright/test';
import { CLI_PATH, startSoakServe } from '../soak/harness.js';
import { startHost } from './host-process.js';
import { writeHeldStorageReadPreload } from './held-storage-read.js';
import { startStoragePersistenceFixture } from './storage-persistence-fixture.js';

for (const { boundary, rejectsQueued } of [
  { boundary: -1, rejectsQueued: false },
  { boundary: 0, rejectsQueued: false },
  { boundary: 1, rejectsQueued: false },
  { boundary: 0, rejectsQueued: true },
]) {
  test(`retained Node MCP work reuses exact charges (boundary: ${boundary}, rejected queued: ${rejectsQueued})`, async ({ page }) => {
    test.setTimeout(60_000);
    const project = `node-capacity-${randomUUID()}`;
    const auditDirectory = join(homedir(), '.pyric', 'projects', project);
    const fixture = await startStoragePersistenceFixture(['--hosted', '--no-capture', '--project', project]);
    try {
      await page.goto(fixture.info.url);
      await expect(page.locator('#ready')).toHaveText('Ready');
      await page.evaluate(async () => {
        const storage = await import('firebase/storage');
        await storage.uploadBytes(storage.ref(storage.getStorage(), 'files/shared.txt'),
          new TextEncoder().encode('Existing object'), { contentType: 'application/x-pyric-held' });
      });
      const firstExit = once(fixture.child, 'exit');
      fixture.child.kill('SIGTERM');
      await firstExit;
      writeFileSync(join(fixture.dir, 'firebase.json'), '{"firestore":{"rules":"firestore.rules"},"storage":{"rules":"storage.rules"}}');
      writeFileSync(join(fixture.dir, 'firestore.rules'),
        "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /held/{document} { allow read: if true; allow write: if false; } match /limit/{document} { allow read: if true; allow write: if false; } } }");
      const preload = join(fixture.dir, 'held-mcp-capacity.mjs');
      writeHeldStorageReadPreload(preload, false);
      const host = startHost(fixture.dir, fixture.info.port, [process.execPath, '--import', preload, CLI_PATH]);
      const client = new Client({ name: 'retained-capacity', version: '1' });
      const healthy = new Client({ name: 'retained-control', version: '1' });
      let receivedCalls = 0;
      let receivedCancellations = 0;
      let holding = true;
      const pending: Promise<unknown>[] = [];
      try {
        expect(await host.startup, host.stderr()).toEqual({ kind: 'ready' });
        await page.reload();
        await expect(page.locator('#ready')).toHaveText('Ready');
        const url = new URL(`${fixture.info.url}/__pyric/mcp`);
        const transport = new StreamableHTTPClientTransport(url, { async fetch(input, init) {
          const request = new Request(input, init);
          const isPost = request.method === 'POST';
          const body: unknown = isPost ? await request.clone().json() : undefined;
          const response = await fetch(request);
          const isToolStream = CallToolRequestSchema.safeParse(body).success && response.status === 200;
          const isCancellation = CancelledNotificationSchema.safeParse(body).success && response.status === 202;
          if (isToolStream) receivedCalls += 1;
          if (isCancellation) receivedCancellations += 1;
          return response;
        } });
        await client.connect(transport);
        await healthy.connect(new StreamableHTTPClientTransport(url));
        // buildMcpServer generates one caller UUID; dispatchSandbox generates
        // one request UUID. Their values vary, but both encode as 36 ASCII bytes.
        // The charged value is this complete ToolCallRequest, not HTTP or MCP JSON.
        function chargedBytes(args: Record<string, unknown>): number {
          return Buffer.byteLength(JSON.stringify({ type: 'tool-call', id: '0'.repeat(36),
            name: 'firestore_create_document', args, callerId: '0'.repeat(36) }));
        }
        function writeArgs(path: string, bytes: number, denied = false) {
          const actor = denied ? { uid: 'denied' } : 'admin';
          const args = { path, data: { message: '' }, as: actor };
          const padding = bytes - chargedBytes(args);
          args.data.message = 'é'.repeat(Math.floor(padding / 2)) + 'x'.repeat(padding % 2);
          expect(chargedBytes(args)).toBe(bytes);
          return args;
        }
        function call(args: Record<string, unknown>, controller?: AbortController) {
          const options = { signal: controller?.signal };
          const promise = client.callTool({ name: 'firestore_create_document', arguments: args }, undefined, options);
          pending.push(promise.catch(() => undefined));
          return promise;
        }
        async function cancelBatch(controllers: AbortController[], calls: Promise<unknown>[]): Promise<void> {
          const expectedCancellations = receivedCancellations + controllers.length;
          for (const controller of controllers) controller.abort();
          await expect.poll(() => receivedCancellations).toBe(expectedCancellations);
          await Promise.allSettled(calls);
        }
        async function refused(): Promise<void> {
          await expect(call({ path: 'limit/refused', data: { message: 'x'.repeat(8192) }, as: 'admin' }))
            .resolves.toMatchObject({ isError: true, content: [{ text: expect.stringContaining('24 MiB queued operation byte limit') }] });
        }
        const operationBytes = 768 * 1024;
        for (const round of ['initial', 'full']) {
          const isInitial = round === 'initial';
          const offset = isInitial ? boundary : 0;
          const failsQueued = isInitial && rejectsQueued;
          const needsRearm = !isInitial;
          if (needsRearm) {
            host.child.kill('SIGUSR2');
            holding = true;
            await expect.poll(host.stderr).toContain('ARMED\n');
          }
          const heldBefore = host.stderr().split('HELD\n').length - 1;
          const callsBefore = receivedCalls;
          const first = call(writeArgs(`held/${round}-first`, operationBytes));
          await expect.poll(() => host.stderr().split('HELD\n').length - 1).toBe(heldBefore + 1);
          const controllers = Array.from({ length: 30 }, () => new AbortController());
          const retained = controllers.map((controller, index) => {
            const deniesCall = failsQueued && index === 0;
            const path = deniesCall ? 'held/denied' : 'held/repeated';
            return call(writeArgs(path, operationBytes, deniesCall), controller);
          });
          await expect.poll(() => receivedCalls).toBe(callsBefore + 31);
          const canceledOffset = failsQueued ? 1 : 0;
          await cancelBatch(controllers.slice(canceledOffset), retained.slice(canceledOffset));
          const lastController = new AbortController();
          const last = call(writeArgs('held/last', operationBytes + offset), lastController);
          const exceedsLimit = offset > 0;
          if (exceedsLimit) {
            await expect(last).resolves.toMatchObject({ isError: true,
              content: [{ text: expect.stringContaining('24 MiB queued operation byte limit') }] });
            const replacementController = new AbortController();
            const corrected = call(writeArgs('held/last', operationBytes), replacementController);
            await expect.poll(() => receivedCalls).toBe(callsBefore + 33);
            await cancelBatch([replacementController], [corrected]);
          } else {
            await expect.poll(() => receivedCalls).toBe(callsBefore + 32);
            await cancelBatch([lastController], [last]);
          }
          await refused();
          await expect(healthy.callTool({ name: 'firestore_get_document', arguments: { path: 'limit/refused', as: 'admin' } }))
            .resolves.toMatchObject({ isError: false, content: [{ text: expect.stringContaining('"exists": false') }] });
          host.child.kill('SIGUSR1');
          await expect(first).resolves.toMatchObject({ isError: false });
          // The denied queued call fails after the first held write settles;
          // its accepted charge must release before the next write is unblocked.
          if (failsQueued) await expect(retained[0]).resolves.toMatchObject({ isError: true });
          await expect.poll(() => host.stderr().split('HELD\n').length - 1).toBe(heldBefore + 2);
          const replacementCount = failsQueued ? 2 : 1;
          const replacementControllers = Array.from({ length: replacementCount }, () => new AbortController());
          const expectedCalls = receivedCalls + replacementCount;
          const replacements = replacementControllers.map(controller =>
            call(writeArgs('held/replacement', operationBytes), controller));
          await expect.poll(() => receivedCalls).toBe(expectedCalls);
          await cancelBatch(replacementControllers, replacements);
          await refused();
          host.child.kill('SIGUSR2');
          holding = false;
          // A same-caller read runs after every accepted mutation in this queue.
          await expect(client.callTool({ name: 'firestore_get_document', arguments: { path: 'held/replacement', as: 'admin' } }))
            .resolves.toMatchObject({ isError: false, content: [{ text: expect.stringContaining('"exists": true') }] });
          const firstExists = await page.evaluate(async path => {
            const firestore = await import('firebase/firestore');
            return (await firestore.getDoc(firestore.doc(firestore.getFirestore(), path))).exists();
          }, `held/${round}-first`);
          expect(firstExists).toBe(true);
          await expect(healthy.callTool({ name: 'firestore_get_document', arguments: { path: 'held/denied', as: 'admin' } }))
            .resolves.toMatchObject({ isError: false, content: [{ text: expect.stringContaining('"exists": false') }] });
        }
        const verifiesCount = boundary === 0 && !rejectsQueued;
        if (verifiesCount) {
          for (const round of ['count-initial', 'count-full']) {
            const heldBefore = host.stderr().split('HELD\n').length - 1;
            const armedBefore = host.stderr().split('ARMED\n').length - 1;
            host.child.kill('SIGUSR2');
            holding = true;
            await expect.poll(() => host.stderr().split('ARMED\n').length - 1).toBe(armedBefore + 1);
            const countPath = `held/${round}`;
            const first = call({ path: countPath, data: { round }, as: 'admin' });
            await expect.poll(() => host.stderr().split('HELD\n').length - 1).toBe(heldBefore + 1);
            const controllers = Array.from({ length: 255 }, () => new AbortController());
            const expectedCalls = receivedCalls + controllers.length;
            const calls = controllers.map((controller, index) => {
              const failsCall = round === 'count-initial' && index === 0;
              const request = failsCall
                ? { name: 'firestore_create_document', arguments: { path: 'held/denied', data: { message: 'Denied' }, as: { uid: 'denied' } } }
                : { name: 'firestore_get_document', arguments: { path: countPath, as: 'admin' } };
              const promise = client.callTool(request, undefined, { signal: controller.signal });
              pending.push(promise.catch(() => undefined));
              return promise;
            });
            await expect.poll(() => receivedCalls).toBe(expectedCalls);
            // Keep the first queued failure observable instead of canceling it.
            await cancelBatch(controllers.slice(1), calls.slice(1));
            await expect(call({ path: 'limit/refused', data: { message: 'Must not execute' }, as: 'admin' }))
              .resolves.toMatchObject({ isError: true, content: [{ text: expect.stringContaining('256 pending operations') }] });
            host.child.kill('SIGUSR2');
            holding = false;
            await expect(first).resolves.toMatchObject({ isError: false });
            const expectsFailure = round === 'count-initial';
            await expect(calls[0]).resolves.toMatchObject({ isError: expectsFailure });
            await expect(client.callTool({ name: 'firestore_get_document', arguments: { path: countPath, as: 'admin' } }))
              .resolves.toMatchObject({ isError: false });
          }
        }
        await expect(healthy.callTool({ name: 'firestore_get_document', arguments: { path: 'limit/refused', as: 'admin' } }))
          .resolves.toMatchObject({ isError: false, content: [{ text: expect.stringContaining('"exists": false') }] });
      } finally {
        if (holding) host.child.kill('SIGUSR2');
        await Promise.allSettled(pending);
        await client.close();
        await healthy.close();
        await host.stop();
      }
    } finally {
      await page.close().finally(() => fixture.stop()).finally(() => rmSync(auditDirectory, { recursive: true, force: true }));
    }
  });
}

for (const cancellation of ['request', 'session']) {
  test(`SharedWorker accepted MCP work drains after ${cancellation} cancellation in two rounds`, async ({ page }) => {
    const responses: ServerResponse[] = [];
    const upstream = createServer((request, response) => {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Allow-Headers', '*');
      const isPreflight = request.method === 'OPTIONS';
      if (isPreflight) {
        response.writeHead(204).end();
        return;
      }
      request.resume();
      responses.push(response);
    });
    function release(index: number): void {
      const response = responses[index];
      const cannotReply = response === undefined || response.writableEnded;
      if (cannotReply) return;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'retained', object: 'chat.completion', created: 0, model: 'local',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Released' }, finish_reason: 'stop' }] }));
    }
    const project = `shared-worker-retention-${randomUUID()}`;
    const auditDirectory = join(homedir(), '.pyric', 'projects', project);
    let fixture: Awaited<ReturnType<typeof startSoakServe>> | undefined;
    let client = new Client({ name: 'shared-worker-retention', version: '1' });
    let transport: StreamableHTTPClientTransport | undefined;
    const pending: Promise<unknown>[] = [];
    try {
      await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
      const address = upstream.address();
      const hasNoAddress = address === null || typeof address === 'string';
      if (hasNoAddress) throw new Error('The retention upstream did not bind.');
      await page.addInitScript(baseUrl => {
        const originalPost = MessagePort.prototype.postMessage;
        const injectedPaths = new Set<string>();
        MessagePort.prototype.postMessage = function (message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
          const isRecord = message !== null && typeof message === 'object';
          const isTool = isRecord && 't' in message && message.t === 'tool' && 'args' in message;
          const args: unknown = isTool ? message.args : undefined;
          const hasPath = args !== null && typeof args === 'object' && 'path' in args;
          const path = hasPath ? args.path : undefined;
          const isHeldPath = typeof path === 'string' && path.startsWith('held/canceled-');
          const injectsWork = isHeldPath && !injectedPaths.has(path);
          if (injectsWork) {
            injectedPaths.add(path);
            const hasClient = isRecord && 'clientSessionId' in message;
            const clientSessionId = hasClient ? message.clientSessionId : undefined;
            originalPost.call(this, { t: 'op', id: `held-${path}`, clientSessionId,
              method: 'ai.generateContent', model: 'local',
              request: { contents: [{ role: 'user', parts: [{ text: 'Hold this accepted caller' }] }] },
              engine: { kind: 'openai', baseUrl } });
          }
          const transfersObjects = Array.isArray(options);
          const serialization = transfersObjects ? { transfer: options } : options;
          return originalPost.call(this, message, serialization);
        };
      }, `http://127.0.0.1:${address.port}/v1`);
      fixture = await startSoakServe({ flags: ['--no-capture', '--project', project], extraFiles: {
        'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
        'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
      } });
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Empty');
      expect(await page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe('shared-worker');
      const url = new URL(`${fixture.info.url}/__pyric/mcp`);
      transport = new StreamableHTTPClientTransport(url);
      await client.connect(transport);
      for (const round of [0, 1]) {
        const controller = new AbortController();
        const path = `held/canceled-${round}`;
        const first = client.callTool({ name: 'firestore_create_document', arguments: {
          path, data: { round }, as: 'admin',
        } }, undefined, { signal: controller.signal }).then(() => 'completed', () => 'canceled');
        pending.push(first);
        await expect.poll(() => responses.length).toBe(round + 1);
        const closesSession = cancellation === 'session';
        if (closesSession) {
          await transport.terminateSession();
          await client.close();
          client = new Client({ name: `replacement-${round}`, version: '1' });
          transport = new StreamableHTTPClientTransport(url);
          await client.connect(transport);
        } else {
          controller.abort();
        }
        expect(await first).toBe('canceled');
        await page.evaluate(async round => {
          const firestore = await import('firebase/firestore');
          await firestore.setDoc(firestore.doc(firestore.getFirestore(), 'shared/greeting'), { message: `Healthy ${round}` });
        }, round);
        await expect(page.locator('#document')).toHaveText(`Healthy ${round}`);
        let subsequentResult: unknown;
        const subsequent = client.callTool({ name: 'firestore_get_document', arguments: { path, as: 'admin' } })
          .then(result => { subsequentResult = result; });
        pending.push(subsequent);
        if (closesSession) {
          await expect.poll(() => subsequentResult).toMatchObject({ isError: false,
            content: [{ text: expect.stringContaining('"exists": false') }] });
        }
        release(round);
        await subsequent;
        await expect.poll(() => page.evaluate(async path => {
          const firestore = await import('firebase/firestore');
          return (await firestore.getDoc(firestore.doc(firestore.getFirestore(), path))).data();
        }, path)).toEqual({ round });
        await expect(client.callTool({ name: 'firestore_create_document', arguments: {
          path: 'shared/greeting', data: { message: `Drained ${round}` }, as: 'admin',
        } })).resolves.toMatchObject({ isError: false });
        await expect(page.locator('#document')).toHaveText(`Drained ${round}`);
      }
    } finally {
      for (const [index] of responses.entries()) release(index);
      await Promise.allSettled(pending);
      await client.close();
      await page.close().finally(() => fixture?.stop()).finally(() => rmSync(auditDirectory, { recursive: true, force: true }));
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });
}
