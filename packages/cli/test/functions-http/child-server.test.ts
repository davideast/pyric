import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { startHttpChildServer } from '../../src/functions/http/child-server.js';
import type { DiscoveredOnRequest } from '../../src/functions/http/discovery.js';

/** Any file inside the conformance package resolves its firebase-functions, and through it express. */
const ENTRY = join(import.meta.dir, '../../../conformance/package.json');

type Res = { end(body: string): void };

function fn(exportName: string, handler: (req: unknown, res: Res) => void): DiscoveredOnRequest {
  return {
    exportName,
    regions: ['us-central1'],
    platform: 'gcfv2',
    privateInvoker: false,
    timeoutSeconds: null,
    handler: handler as DiscoveredOnRequest['handler'],
  };
}

const call = (port: number, name: string): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}/`, { headers: { 'x-pyric-function-target': name } });

describe('the child HTTP server', () => {
  test('close lets an in-flight request finish (a reload must not cut it)', async () => {
    const server = await startHttpChildServer(ENTRY, [
      fn('slow', (_req, res) => { setTimeout(() => res.end('done'), 300); }),
    ]);
    const inFlight = call(server.port, 'slow');
    await Bun.sleep(50);
    const closed = server.close();
    const response = await inFlight;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('done');
    await closed;
  });

  test('close force-closes a request still open after the drain deadline', async () => {
    const server = await startHttpChildServer(ENTRY, [fn('hang', () => undefined)], { drainMs: 200 });
    const inFlight = call(server.port, 'hang').then(() => 'answered', () => 'closed');
    await Bun.sleep(50);
    const startedAt = Date.now();
    await server.close();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(await inFlight).toBe('closed');
  });
});
