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
import { LIVE_REFUSED, LIVE_ROWS, liveCallRefusal, liveModuleFor, liveWriteRefusal, type LiveModuleSite } from '../src/index.js';
import { PASS_THROUGH_CANDIDATES, liveRefusal, passThroughOption } from '../src/refusal.js';

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

/** The SDK's internal record of the project and database an instance reaches. */
type DatabaseHolder = { _databaseId: { projectId: string; database: string } };

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
    // getFirestore('') is its own instance in the SDK, but its DatabaseId reads
    // '' as (default): it reaches the default database, so the row forwards it.
    const defaultApp = realApp.initializeApp(OPTIONS);
    try {
      const emptyNamed = firestore.getFirestore('') as unknown as DatabaseHolder;
      expect(emptyNamed._databaseId.database).toBe('(default)');
      expect(emptyNamed._databaseId.projectId).toBe(OPTIONS.projectId);
      expect((realFirestore.getFirestore(defaultApp) as unknown as DatabaseHolder)._databaseId.database).toBe('(default)');
      const named = thrown(() => firestore.getFirestore('reports'));
      expect(named.code).toBe(LIVE_REFUSED);
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

/** `a, b and c`: the served list as the refusal writes it. */
function servedList(specifiers: readonly string[]): string {
  return `${specifiers.slice(0, -1).join(', ')} and ${specifiers.at(-1)}`;
}

describe('the refusals follow the live rows', () => {
  const rows = [...LIVE_ROWS.keys()];
  const served = servedList(rows);
  const tail = 'It is not served from the Pyric sandbox either, so production and sandbox services never share one app. ' +
    'Remove the import, or run the app without @pyric/live to use the sandbox.';

  test('an import with no live row names every row, in row order, for pages and Node processes', () => {
    expect(liveRefusal('firebase/storage', 'page').message).toBe(
      `@pyric/live: firebase/storage (Cloud Storage) is refused in live mode. Live mode serves only ${served} to pages, ` +
        `from your installed Firebase SDK. ${tail}`,
    );
    expect(liveRefusal('firebase/storage', 'node').message).toBe(
      `@pyric/live: firebase/storage (Cloud Storage) is refused in live mode. Live mode serves only ${served} to a Node process, ` +
        `from your installed Firebase SDK. ${tail}`,
    );
    expect(liveRefusal('firebase/storage', 'server').message).toBe(
      '@pyric/live: firebase/storage (Cloud Storage) is refused in live mode. Live mode serves Firebase to pages only; ' +
        `server code the dev server runs gets no Firebase module yet. ${tail}`,
    );
  });

  test('passThrough refuses every live row as already served, and takes none of them', () => {
    for (const row of rows) {
      expect(() => passThroughOption('@pyric/live/vite', [row])).toThrow(
        `@pyric/live/vite: passThrough lists ${row}, which live mode already serves and observes; remove it.`,
      );
      expect(PASS_THROUGH_CANDIDATES).not.toContain(row);
    }
  });
});
