/**
 * Live mode's refusals of calls and writes, over the real Firebase SDK. A
 * named Firestore database is refused by the live row before the SDK runs,
 * so no request leaves: Firestore is pointed at a local server that counts
 * every connection it gets, and it gets none until a default-database read
 * shows the counter works. The import refusals and the host's refusal of
 * pyric's own writes run through real entry points in
 * `packages/cli/test/e2e/live-refusals.pw.ts` and
 * `packages/cli/test/register/live-register-refusals.test.ts`.
 */
import { createServer, type Socket } from 'node:net';
import { afterAll, describe, expect, test } from 'bun:test';
import * as realApp from 'firebase/app';
import * as realFirestore from 'firebase/firestore';
import { LIVE_REFUSED, liveCallRefusal, liveModuleFor, liveWriteRefusal, type LiveModuleSite } from '../src/index.js';

/** A loopback server that counts and drops every connection. */
async function countingServer(): Promise<{ port: number; connections(): number; close(): Promise<void> }> {
  let count = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    count += 1;
    sockets.add(socket);
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no loopback port');
  return {
    port: address.port,
    connections: () => count,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const counter = await countingServer();
const site: LiveModuleSite = { observer: () => undefined, sdkVersion: realApp.SDK_VERSION, client: 'page' };
const app = liveModuleFor('firebase/app', realApp, site);
const firestore = liveModuleFor('firebase/firestore', realFirestore, site);
const OPTIONS = { apiKey: 'demo-api-key', projectId: 'demo-live-refusals', appId: '1:123456789012:web:0a1b2c3d4e5f6071' };
const SETTINGS = { host: `127.0.0.1:${counter.port}`, ssl: false };

const refusedApp = app.initializeApp(OPTIONS, 'live-refusals');
const controlApp = app.initializeApp(OPTIONS, 'live-refusals-control');

afterAll(async () => {
  await realApp.deleteApp(refusedApp);
  await realApp.deleteApp(controlApp);
  await counter.close();
});

function thrown(call: () => unknown): Error & { code?: string } {
  try {
    call();
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error('the call did not throw');
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
}

describe('a named Firestore database', () => {
  test('is refused by getFirestore and initializeFirestore, naming live mode, the database and the client', () => {
    const calls: Array<[string, () => unknown]> = [
      ['initializeFirestore with the database "reports"', () => firestore.initializeFirestore(refusedApp, SETTINGS, 'reports')],
      ['getFirestore with the database "reports"', () => firestore.getFirestore(refusedApp, 'reports')],
      ['getFirestore with the database "reports"', () => firestore.getFirestore('reports')],
    ];
    for (const [named, call] of calls) {
      const error = thrown(call);
      expect(error.code).toBe(LIVE_REFUSED);
      expect(error.message).toContain(`${named} is refused in live mode, from a page`);
      expect(error.message).toContain('only the (default) database');
      expect(error.message).toContain('threw before any request left');
    }
  });

  test('sends no request, while the default database reaches the same server', async () => {
    thrown(() => firestore.initializeFirestore(refusedApp, SETTINGS, 'reports'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(counter.connections()).toBe(0);

    const db = firestore.initializeFirestore(controlApp, SETTINGS, '(default)');
    expect(firestore.getFirestore(controlApp)).toBe(db);
    expect(firestore.getFirestore(controlApp, '')).toBe(db);
    // The SDK reads a string first argument as the database with no fallback:
    // the real getFirestore('') is a separate instance for the database "", not
    // (default), so the live row refuses it.
    const defaultApp = realApp.initializeApp(OPTIONS);
    try {
      expect(realFirestore.getFirestore('')).not.toBe(realFirestore.getFirestore(defaultApp));
      const error = thrown(() => firestore.getFirestore(''));
      expect(error.code).toBe(LIVE_REFUSED);
      expect(error.message).toContain('getFirestore with the database "" is refused in live mode');
    } finally {
      await realApp.deleteApp(defaultApp);
    }
    void firestore.getDocFromServer(firestore.doc(db, 'rooms/lobby')).catch(() => undefined);
    await waitFor(() => counter.connections() > 0, 10_000);
    expect(counter.connections()).toBeGreaterThan(0);
    await realFirestore.terminate(db);
  }, 15_000);
});

describe('the refusal messages', () => {
  test('a refused call names the client it was made from', () => {
    const call = { call: 'getFirestore with the database "x"', reaches: 'the named Firestore database "x"', serves: 'only the (default) database' };
    expect(liveCallRefusal(call, 'node').message).toContain('is refused in live mode, from a Node process');
  });

  test("pyric's own write names live mode, the action and who asked", () => {
    const studio = liveWriteRefusal({ action: 'setDoc', writer: 'studio' }) as Error & { code?: string };
    expect(studio.code).toBe(LIVE_REFUSED);
    expect(studio.message).toContain('setDoc from Studio is refused in live mode');
    expect(studio.message).toContain('pyric holds no production credential');
    expect(liveWriteRefusal({ action: 'firestore_create_document', writer: 'mcp' }).message).toContain('from an MCP tool');
    expect(liveWriteRefusal({ action: 'seed seed.json', writer: 'seed' }).message).toContain('seed seed.json from the seed file');
    expect(liveWriteRefusal({ action: 'firestore.setDoc', writer: 'command' }).message).toContain('from a pyric command');
  });
});
