/**
 * The served `firebase/database` entry over a worker port: an app whose
 * `databaseURL` is the legacy `https://<projectId>.firebaseio.com` opens the
 * default instance, sending no `instance` on its operations, and its
 * references keep the URL production reports (#1062).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createAppForSandbox } from 'pyric/app/internal';
import { deleteApp } from 'pyric/app';
import { handleMessage, type PortLike } from '../../../src/serve/worker/host.js';
import { setDatabaseRules } from '../../../src/serve/worker/host/rules.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import { type FakePort, makeHostCtx, portPair } from './integration-support.js';

const PROJECT = 'legacy-entry';
const LEGACY_URL = `https://${PROJECT}.firebaseio.com`;
const DEFAULT_RULES = {
  rules: {
    open: { '.read': true, '.write': true },
    closed: { '.read': false, '.write': false },
  },
};

describe('served firebase/database with a legacy databaseURL', () => {
  let restoreSW: () => void;
  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSW = () => { (globalThis as { SharedWorker?: unknown }).SharedWorker = previous; };
  });
  afterEach(() => restoreSW());

  it('opens the default instance with its rules and data', async () => {
    const ctx = await makeHostCtx();
    setDatabaseRules(ctx, undefined, DEFAULT_RULES);
    const instances: Array<string | undefined> = [];
    (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
      port: FakePort;
      addEventListener() {}
      constructor(_url: unknown, _opts: unknown) {
        const { a: clientPort, b: hostPort } = portPair();
        const hostPortLike: PortLike = { postMessage: (message: OutboundMessage) => hostPort.postMessage(message) };
        hostPort.onmessage = (event) => {
          const message = event.data as InboundMessage & { method?: string; instance?: string };
          if (message.t === 'op' && message.method?.startsWith('rtdb.')) instances.push(message.instance);
          void handleMessage(ctx, hostPortLike, message);
        };
        this.port = clientPort;
      }
    };
    const database = await import('../../../src/serve/entries/database.js');
    const legacyApp = createAppForSandbox(ctx.sandbox, { projectId: PROJECT, databaseURL: LEGACY_URL }, `legacy-${Math.random()}`);
    try {
      const legacy = database.getDatabase(legacyApp);
      expect(database.ref(legacy, 'open/a').toString()).toBe(`${LEGACY_URL}/open/a`);
      await database.set(database.ref(legacy, 'open/a'), 'from legacy');
      await expect(database.set(database.ref(legacy, 'closed/a'), 1)).rejects.toThrow('PERMISSION_DENIED');
      expect(instances).toEqual([undefined, undefined]);
      // One Firebase configuration per runtime: the instance an app without a
      // databaseURL opens is reached by the URL the SDK derives for it.
      const projectDefault = database.getDatabase(legacyApp, `https://${PROJECT}-default-rtdb.firebaseio.com`);
      const snapshot = await database.get(database.ref(projectDefault, 'open/a'));
      expect(snapshot.val()).toBe('from legacy');
      expect(instances).toEqual([undefined, undefined, undefined]);
    } finally {
      await deleteApp(legacyApp);
    }
  });
});
