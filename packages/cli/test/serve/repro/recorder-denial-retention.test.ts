import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { captureCheckpoint } from 'pyric/sandbox/checkpoints';
import { getFirestore } from 'pyric/firestore';
import { buildReproFile } from '../../../src/serve/repro/capture.js';
import { listDenials } from '../../../src/serve/repro/denials.js';
import { parseRepro, type ReproBase } from '../../../src/serve/repro/format.js';
import { createReproRecorder, DEFAULT_REPRO_WINDOW } from '../../../src/serve/repro/recorder.js';
import { replayRepro } from '../../../src/serve/repro/replay.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';

function emptyBase(at = 0): Omit<ReproBase, 'subscriptions'> {
  return {
    at,
    checkpoint: {
      format: 'pyric-checkpoint-v1',
      at,
      counts: { firestore: 0, database: 0, storage: 0, auth: 0 },
      state: {
        firestore: [],
        database: null,
        storage: [],
        auth: { users: [] },
        rules: { firestore: null, database: null, storage: null },
        clock: { now: at },
      },
    } as unknown as ReproBase['checkpoint'],
    databaseInstances: {},
    rules: { firestore: null, database: {}, storage: null },
    defaultInstance: '(default)',
    permissive: false,
    appOptions: null,
    sessions: {},
  };
}

function rtdbWriteDenial(id: string, path: string, uid: string): OutboundMessage {
  return {
    t: 'res',
    id,
    ok: false,
    error: {
      code: 'permission-denied',
      message: 'Permission denied',
      denialContext: {
        engine: 'rtdb',
        auth: { uid },
        reasons: ['no .write granted'],
        request: { method: 'set', path },
        matchedPath: '/items/$itemId',
        matchedRule: "newData.val() != 'refused'",
      },
    },
  };
}

function rtdbSnapDenial(subId: string, path: string, uid: string): OutboundMessage {
  return {
    t: 'snap',
    subId,
    value: {
      __error: {
        code: 'permission-denied',
        message: 'Permission denied',
        denialContext: {
          engine: 'rtdb',
          auth: { uid },
          reasons: ['no .read granted'],
          request: { method: 'listen', path },
          matchedPath: '/private/$itemId',
          matchedRule: 'auth != null',
        },
      },
    },
  };
}

function firestoreReadDenial(id: string, path: string): OutboundMessage {
  return {
    t: 'res',
    id,
    ok: false,
    error: {
      code: 'permission-denied',
      message: 'Permission denied',
      denialContext: {
        auth: null,
        reasons: ['allow read: false'],
        request: { method: 'get', path },
        rule: {
          line: 4,
          col: 7,
          citation: 'firestore.rules:4:7',
          expression: 'request.auth != null',
        },
      } as unknown as NonNullable<Extract<OutboundMessage, { t: 'res'; ok: false }>['error']['denialContext']>,
    },
  };
}

describe('repro recorder denial retention across window rollover', () => {
  test('retains early denial groups after 3,500+ allowed entries roll past the 1,000-entry window', async () => {
    let clock = 1_000;
    const recorder = createReproRecorder({
      limit: DEFAULT_REPRO_WINDOW,
      now: () => {
        clock += 1;
        return clock;
      },
      capture: async () => emptyBase(clock),
    });

    await recorder.inbound('client-1', {
      t: 'op',
      id: 'deny-rtdb-1',
      method: 'rtdb.set',
      instance: undefined,
      path: '/items/first',
      value: 'refused',
    } as InboundMessage);
    recorder.outbound('client-1', rtdbWriteDenial('deny-rtdb-1', '/items/first', 'u-1'));

    await recorder.inbound('client-1', {
      t: 'sub',
      subId: 'sub-denied-1',
      target: { service: 'rtdb', instance: undefined, path: '/private/secret' },
    } as InboundMessage);
    recorder.outbound('client-1', rtdbSnapDenial('sub-denied-1', '/private/secret', 'u-1'));
    await recorder.inbound('client-1', { t: 'unsub', subId: 'sub-denied-1' } as InboundMessage);

    await recorder.inbound('client-2', {
      t: 'op',
      id: 'deny-fs-1',
      method: 'getDoc',
      path: 'items/locked',
    } as InboundMessage);
    recorder.outbound('client-2', firestoreReadDenial('deny-fs-1', 'items/locked'));

    const allowedWrites = 3_600;
    for (let index = 0; index < allowedWrites; index++) {
      const id = `allow-${index}`;
      await recorder.inbound('client-1', {
        t: 'op',
        id,
        method: 'rtdb.set',
        instance: undefined,
        path: `/items/n${index % 20}`,
        value: index,
      } as InboundMessage);
      recorder.outbound('client-1', { t: 'res', id, ok: true, value: null });
    }

    const log = await recorder.log();
    expect(log.truncated).toBe(true);

    const built = await buildReproFile(log, () => undefined);
    const parsed = parseRepro(JSON.parse(JSON.stringify(built)));
    const groups = listDenials(parsed, {});

    expect(groups).toHaveLength(3);

    const rtdbWriteGroup = groups.find((group) => group.service === 'rtdb' && group.path === '/items/$itemId');
    expect(rtdbWriteGroup).toMatchObject({
      service: 'rtdb',
      path: '/items/$itemId',
      count: 1,
      loads: 1,
      paths: ['/items/first'],
      identities: ['u-1'],
      trace: ['no .write granted'],
    });

    const rtdbSnapGroup = groups.find((group) => group.service === 'rtdb' && group.path === '/private/$itemId');
    expect(rtdbSnapGroup).toMatchObject({
      service: 'rtdb',
      path: '/private/$itemId',
      count: 1,
      loads: 1,
      paths: ['/private/secret'],
      identities: ['u-1'],
      trace: ['no .read granted'],
    });

    const fsGroup = groups.find((group) => group.service === 'firestore');
    expect(fsGroup).toMatchObject({
      service: 'firestore',
      path: 'firestore.rules:4:7',
      rule: 'request.auth != null',
      count: 1,
      loads: 1,
      paths: ['items/locked'],
      identities: ['anonymous'],
    });

    expect(listDenials(parsed, { service: 'firestore' })).toHaveLength(1);
    expect(listDenials(parsed, { service: 'rtdb' })).toHaveLength(2);
    expect(listDenials(parsed, { sinceAt: clock })).toHaveLength(0);
  });

  test('bounds archived dropped denials so a flood of denials cannot grow memory unboundedly', async () => {
    let clock = 100;
    const recorder = createReproRecorder({
      limit: 8,
      now: () => {
        clock += 1;
        return clock;
      },
      capture: async () => emptyBase(clock),
    });

    for (let index = 0; index < 1_050; index++) {
      const id = `deny-${index}`;
      await recorder.inbound('client-1', {
        t: 'op',
        id,
        method: 'rtdb.set',
        instance: undefined,
        path: `/items/d-${index}`,
        value: 'refused',
      } as InboundMessage);
      recorder.outbound('client-1', rtdbWriteDenial(id, `/items/d-${index}`, 'u-1'));
    }

    for (let index = 0; index < 40; index++) {
      const id = `allow-${index}`;
      await recorder.inbound('client-1', {
        t: 'op',
        id,
        method: 'rtdb.set',
        instance: undefined,
        path: `/items/a-${index}`,
        value: index,
      } as InboundMessage);
      recorder.outbound('client-1', { t: 'res', id, ok: true, value: null });
    }

    const log = await recorder.log();
    expect(log.truncated).toBe(true);

    const built = await buildReproFile(log, () => undefined);
    const parsed = parseRepro(JSON.parse(JSON.stringify(built)));
    const groups = listDenials(parsed, {});

    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(1_000);
    expect(groups[0]?.paths[0]).toBe('/items/d-50');
    expect(groups[0]?.paths[999]).toBe('/items/d-1049');
  });

  test('archived res and snap denials remain replay-safe on the worker plane', async () => {
    const firestoreRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} {
      allow read: if true;
      allow write: if request.resource.data.allowed == true;
    }
  }
}`;
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox);
    const { setRules } = await import('pyric/sandbox/firestore');
    setRules(sandbox, firestoreRules);

    try {
      const ctx: HostCtx = {
        db,
        sandbox,
        instanceId: 'repro-denial-replay',
        subs: new Map(),
        flushPersistence: async () => {},
      };
      const recorder = createReproRecorder({
        limit: 4,
        capture: async () => {
          const checkpoint = await captureCheckpoint(sandbox);
          return {
            at: Date.now(),
            checkpoint,
            databaseInstances: {},
            rules: { firestore: firestoreRules, database: {}, storage: null },
            defaultInstance: '(default)',
            permissive: false,
            appOptions: null,
            sessions: {},
          };
        },
      });

      const sendOp = async (id: string, payload: Record<string, unknown>): Promise<OutboundMessage> => {
        const inbound = { t: 'op', id, ...payload } as InboundMessage;
        await recorder.inbound('tab-1', inbound);
        return new Promise<OutboundMessage>((resolve) => {
          const port: PortLike = {
            postMessage(msg: OutboundMessage) {
              recorder.outbound('tab-1', msg);
              if (msg.t === 'res' && msg.id === id) resolve(msg);
            },
          };
          void handleMessage(ctx, port, inbound);
        });
      };

      const denied = await sendOp('op-denied', {
        method: 'setDoc',
        path: 'items/denied',
        data: { allowed: false },
      });
      expect(denied.t === 'res' && !denied.ok).toBe(true);

      // Also inject a dropped snap denial to ensure archived snap denials do not stall replay.
      recorder.outbound('tab-1', rtdbSnapDenial('sub-dropped', '/private/one', 'u-1'));

      for (let index = 0; index < 12; index++) {
        const allowed = await sendOp(`op-ok-${index}`, {
          method: 'setDoc',
          path: `items/ok-${index}`,
          data: { allowed: true, n: index },
        });
        expect(allowed.t === 'res' && allowed.ok).toBe(true);
      }

      const log = await recorder.log();
      expect(log.truncated).toBe(true);

      const built = await buildReproFile(log, () => undefined);
      const parsed = parseRepro(JSON.parse(JSON.stringify(built)));

      const groups = listDenials(parsed, {});
      expect(groups.some((group) => group.service === 'firestore' && group.paths.includes('items/denied'))).toBe(true);
      expect(groups.some((group) => group.service === 'rtdb' && group.paths.includes('/private/one'))).toBe(true);

      const report = await replayRepro(parsed, { planes: ['worker'] });
      expect(report.ok).toBe(true);
      expect(report.planes.worker?.divergences).toEqual([]);
    } finally {
      sandbox.dispose();
    }
  });
});
