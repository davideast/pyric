/** One bounded diagnostic, not a replacement for the uncollected I16 acceptance.
 * PATH=/path/to/node22/bin:$PATH node node_modules/@playwright/test/cli.js test --config=scripts/diagnostics/i16-memory.config.ts
 */
import { expect, test } from '@playwright/test';
import { WebSocket, type RawData } from 'ws';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startHostedFixture } from './fixture.js';

let requestId = 0;
function inspectorCall<T>(socket: WebSocket, method: string, params: object): Promise<T> {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', receive);
      reject(new Error(`Inspector ${method} timed out`));
    }, 10_000);
    function receive(data: RawData) {
      const frame = JSON.parse(data.toString());
      const matches = frame.id === id;
      if (!matches) return;
      clearTimeout(timer);
      socket.off('message', receive);
      if (frame.error) reject(new Error(JSON.stringify(frame.error)));
      else resolve(frame.result);
    }
    socket.on('message', receive);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

interface Evaluation {
  result: { objectId?: string; value?: unknown };
  exceptionDetails?: unknown;
}

async function evaluate(socket: WebSocket, expression: string, returnByValue = true): Promise<Evaluation> {
  const result = await inspectorCall<Evaluation>(socket, 'Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue, objectGroup: 'i16-sample',
  });
  const failed = result.exceptionDetails !== undefined;
  if (failed) throw new Error(JSON.stringify(result.exceptionDetails));
  return result;
}

async function collectSample(socket: WebSocket) {
  // Memory is sampled first. History inspection may allocate a serialized snapshot;
  // release every inspector handle so the next cycle's collections can reclaim it.
  const memory = await evaluate(socket, 'gc(); gc(); process.memoryUsage()');
  const moduleUrl = new URL('../../../../pyric/dist/sandbox/internal/sandbox-impl.js', import.meta.url).href;
  try {
    const prototype = await evaluate(socket, `(async () => (await import(${JSON.stringify(moduleUrl)})).SandboxImpl.prototype)()`, false);
    const objects = await inspectorCall<{ objects: { objectId: string } }>(socket, 'Runtime.queryObjects', {
      prototypeObjectId: prototype.result.objectId, objectGroup: 'i16-sample',
    });
    const history = await inspectorCall<Evaluation>(socket, 'Runtime.callFunctionOn', {
      objectId: objects.objects.objectId,
      functionDeclaration: `function() {
        return this.filter(sandbox => sandbox.eventHistory.limits).map(sandbox => {
          const events = sandbox.history();
          const history = sandbox.eventHistory;
          return {
            retainedEvents: events.length,
            serializedBytes: Buffer.byteLength(JSON.stringify(events)),
            accountedBytes: history.bytes + history.liveBytes,
            limits: history.limits
          };
        });
      }`,
      returnByValue: true, objectGroup: 'i16-sample',
    });
    const failed = history.exceptionDetails !== undefined;
    if (failed) throw new Error(JSON.stringify(history.exceptionDetails));
    return { memory: memory.result.value, history: history.result.value };
  } catch (error) {
    return { memory: memory.result.value, history: { unavailable: String(error) } };
  } finally {
    await inspectorCall(socket, 'Runtime.releaseObjectGroup', { objectGroup: 'i16-sample' });
  }
}

test('six slow-consumer cycles with host collection and history measurements', async ({ page }) => {
  const priorOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${priorOptions ?? ''} --expose-gc --inspect=127.0.0.1:0`;
  const fixture = await startHostedFixture().finally(() => {
    if (priorOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = priorOptions;
  });
  const readers: WebSocket[] = [];
  let inspector: WebSocket | undefined;
  try {
    const endpoint = fixture.stderr().match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1];
    const missingEndpoint = endpoint === undefined;
    if (missingEndpoint) throw new Error('Host inspector endpoint missing');
    inspector = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      inspector!.once('open', resolve);
      inspector!.once('error', reject);
    });
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    console.log('I16 baseline', JSON.stringify(await collectSample(inspector)));
    for (const cycle of [0, 1, 2, 3, 4, 5]) {
      const socket = new WebSocket(`${fixture.info.url.replace('http:', 'ws:')}/__pyric/sandbox`);
      readers.push(socket);
      const ready = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<{ code: number; reason: string }>();
      socket.on('error', () => undefined);
      socket.once('close', (code, reason) => closed.resolve({ code, reason: reason.toString() }));
      socket.once('open', () => socket.send(JSON.stringify({ type: 'attach', protocol: 1, transport: 'worker-port' })));
      socket.on('message', data => {
        const frame: unknown = JSON.parse(data.toString());
        const isFrame = isBridgeMessage(frame);
        const isAttached = isFrame && frame.type === 'attach-ack';
        if (isAttached) socket.send(JSON.stringify({ type: 'worker-message', message: { t: 'sub', subId: 'slow', target: 'events' } }));
        const isEvents = isFrame && frame.type === 'worker-message-result' && frame.message.t === 'event';
        if (isEvents) ready.resolve();
      });
      await ready.promise;
      socket.pause();
      const times = await page.evaluate(async cycle => {
        const sdk = await import('firebase/firestore');
        const target = sdk.doc(sdk.getFirestore(), 'load', 'replaced');
        const padding = 'x'.repeat(256 * 1024);
        const times: number[] = [];
        for (const i of Array(192).keys()) {
          const start = performance.now();
          await sdk.setDoc(target, { padding, sequence: `${cycle}:${i}` });
          times.push(performance.now() - start);
        }
        return times;
      }, cycle);
      socket.resume();
      const outcome = await Promise.race([closed.promise, new Promise<null>(resolve => setTimeout(() => resolve(null), 3_000))]);
      expect(outcome).toEqual({ code: 1013, reason: 'Client output backlog exceeds 24 MiB; reconnect to resume.' });
      await page.locator('#write').click();
      await expect(page.locator('#write-result')).toHaveText('Written');
      console.log('I16 cycle', JSON.stringify({ cycle, writes: times.length, ...await collectSample(inspector) }));
    }
  } finally {
    inspector?.terminate();
    for (const socket of readers) socket.terminate();
    await page.close();
    await fixture.stop();
  }
});
