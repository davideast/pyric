import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { deleteApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import * as ip from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';
import { handleMessage, type PortLike } from '../../../src/serve/worker/host.js';
import { setDatabaseRules } from '../../../src/serve/worker/host/rules.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import { type FakePort, makeHostCtx, portPair } from './integration-support.js';

const PRIORITY_RULE = 'must be a valid Firebase priority (a string, finite number, server value, or null).';
const NOT_AN_OBJECT = 'values argument  must be an object containing the children to replace.';

function syncThrownMessage(call: () => unknown): string {
  try {
    const result = call() as { catch?: (fn: () => void) => void } | undefined;
    result?.catch?.(() => {});
    return 'returned without throwing synchronously';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe('Cross-plane RTDB transactions and update/onDisconnect validation', () => {
  let restoreSW: () => void;

  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSW = () => {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = previous;
    };
  });

  afterEach(() => restoreSW());

  async function setupPlanes(opts?: { jsonWire?: boolean }) {
    const ctx = await makeHostCtx();
    setDatabaseRules(ctx, undefined, { rules: { '.read': true, '.write': true } });
    const sentFrames: InboundMessage[] = [];
    (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
      port: FakePort;
      addEventListener() {}
      constructor(_url: unknown, _opts: unknown) {
        const { a: clientPort, b: hostPort } = portPair();
        const hostPortLike: PortLike = {
          postMessage: (message: OutboundMessage) =>
            hostPort.postMessage(opts?.jsonWire ? JSON.parse(JSON.stringify(message)) : message),
        };
        hostPort.onmessage = (event) => {
          const frame = (
            opts?.jsonWire ? JSON.parse(JSON.stringify(event.data)) : event.data
          ) as InboundMessage;
          sentFrames.push(frame);
          void handleMessage(ctx, hostPortLike, frame);
        };
        this.port = clientPort;
      }
    };
    const served = await import('../../../src/serve/entries/database.js');
    const servedApp = createAppForSandbox(
      ctx.sandbox,
      { projectId: 'rtdb-validation-parity' },
      `rtdb-validation-served-${Math.random()}`,
    );
    const servedDb = served.getDatabase(servedApp);

    const ipSandbox = initializeSandbox();
    const ipDb = ip.getDatabase(ipSandbox.withAuth({ uid: 'user-1' }));
    ip.sandbox.setDefaultPolicy(ipDb, 'allow');

    return {
      served,
      servedApp,
      servedDb,
      sentFrames,
      ipDb,
      cleanup: async () => {
        await deleteApp(servedApp);
      },
    };
  }

  it('throws synchronously when runTransaction targets /.info/* on both in-process and served planes', async () => {
    const { served, servedDb, ipDb, cleanup } = await setupPlanes();
    try {
      const expected = "Reference.transaction failed = Can't modify data under /.info/";
      expect(
        syncThrownMessage(() => ip.runTransaction(ip.ref(ipDb, '.info/connected'), (v) => v)),
      ).toBe(expected);
      expect(
        syncThrownMessage(() => served.runTransaction(served.ref(servedDb, '.info/connected'), (v) => v)),
      ).toBe(expected);
    } finally {
      await cleanup();
    }
  });

  it('rejects transaction callbacks returning NaN or functions on both planes without mutating stored data', async () => {
    const { served, servedDb, sentFrames, ipDb, cleanup } = await setupPlanes({ jsonWire: true });
    try {
      const ipRef = ip.ref(ipDb, 'items/item-1');
      const servedRef = served.ref(servedDb, 'items/item-1');
      await ip.set(ipRef, { count: 10 });
      await served.set(servedRef, { count: 10 });
      sentFrames.length = 0;

      await expect(ip.runTransaction(ipRef, () => NaN as unknown as object)).rejects.toThrow(
        "transaction failed: Data returned contains NaN in property 'items.item-1'",
      );
      await expect(served.runTransaction(servedRef, () => NaN as unknown as object)).rejects.toThrow(
        "transaction failed: Data returned contains NaN in property 'items.item-1'",
      );

      const badFn = () => 1;
      await expect(ip.runTransaction(ipRef, () => ({ fn: badFn }) as unknown as object)).rejects.toThrow(
        "transaction failed: Data returned contains a function in property 'items.item-1.fn'",
      );
      await expect(served.runTransaction(servedRef, () => ({ fn: badFn }) as unknown as object)).rejects.toThrow(
        "transaction failed: Data returned contains a function in property 'items.item-1.fn'",
      );

      expect(sentFrames.some((f) => f.t === 'op' && f.method === 'rtdb.transactionCommit')).toBe(false);
      expect((await ip.get(ipRef)).val()).toEqual({ count: 10 });
      expect((await served.get(servedRef)).val()).toEqual({ count: 10 });
    } finally {
      await cleanup();
    }
  });

  it('rejects arrays, primitives, and null synchronously in update and OnDisconnect.update across planes', async () => {
    const { served, servedDb, ipDb, cleanup } = await setupPlanes();
    try {
      const ipRef = ip.ref(ipDb, 'items');
      const servedRef = served.ref(servedDb, 'items');
      await ip.set(ipRef, { keep: true });
      await served.set(servedRef, { keep: true });

      for (const bad of [[1], 'text', 42, null]) {
        expect(syncThrownMessage(() => ip.update(ipRef, bad as unknown as Record<string, unknown>))).toBe(
          `update failed: ${NOT_AN_OBJECT}`,
        );
        expect(syncThrownMessage(() => served.update(servedRef, bad as unknown as Record<string, unknown>))).toBe(
          `update failed: ${NOT_AN_OBJECT}`,
        );
        expect(
          syncThrownMessage(() => ip.onDisconnect(ipRef).update(bad as unknown as Record<string, unknown>)),
        ).toBe(`OnDisconnect.update failed: ${NOT_AN_OBJECT}`);
        expect(
          syncThrownMessage(() => served.onDisconnect(servedRef).update(bad as unknown as Record<string, unknown>)),
        ).toBe(`OnDisconnect.update failed: ${NOT_AN_OBJECT}`);
      }

      ip.goOffline(ipDb);
      ip.goOnline(ipDb);
      expect((await ip.get(ipRef)).val()).toEqual({ keep: true });
      expect((await served.get(servedRef)).val()).toEqual({ keep: true });
    } finally {
      await cleanup();
    }
  });

  it('validates OnDisconnect values, priorities, and update paths synchronously across planes', async () => {
    const { served, servedDb, ipDb, cleanup } = await setupPlanes();
    try {
      const ipItem = ip.ref(ipDb, 'items/item-1');
      const servedItem = served.ref(servedDb, 'items/item-1');

      expect(syncThrownMessage(() => ip.onDisconnect(ipItem).set(NaN))).toBe(
        "OnDisconnect.set failed: value argument contains NaN in property 'items.item-1'",
      );
      expect(syncThrownMessage(() => served.onDisconnect(servedItem).set(NaN))).toBe(
        "OnDisconnect.set failed: value argument contains NaN in property 'items.item-1'",
      );

      expect(syncThrownMessage(() => ip.onDisconnect(ipItem).setWithPriority(1, NaN))).toBe(
        `OnDisconnect.setWithPriority failed: priority argument is NaN, but ${PRIORITY_RULE}`,
      );
      expect(syncThrownMessage(() => served.onDisconnect(servedItem).setWithPriority(1, NaN))).toBe(
        `OnDisconnect.setWithPriority failed: priority argument is NaN, but ${PRIORITY_RULE}`,
      );

      expect(syncThrownMessage(() => ip.onDisconnect(ipItem).setWithPriority(1, {} as unknown as number))).toBe(
        `OnDisconnect.setWithPriority failed: priority argument ${PRIORITY_RULE}`,
      );
      expect(syncThrownMessage(() => served.onDisconnect(servedItem).setWithPriority(1, {} as unknown as number))).toBe(
        `OnDisconnect.setWithPriority failed: priority argument ${PRIORITY_RULE}`,
      );

      expect(syncThrownMessage(() => ip.update(ipItem, { count: NaN }))).toBe(
        "update failed: values argument contains NaN in property 'items.item-1.count'",
      );
      expect(syncThrownMessage(() => served.update(servedItem, { count: NaN }))).toBe(
        "update failed: values argument contains NaN in property 'items.item-1.count'",
      );

      const fn = () => 1;
      expect(syncThrownMessage(() => ip.update(ipItem, { fn }))).toBe(
        "update failed: values argument contains a function in property 'items.item-1.fn' with contents = () => 1",
      );
      expect(syncThrownMessage(() => served.update(servedItem, { fn }))).toBe(
        "update failed: values argument contains a function in property 'items.item-1.fn' with contents = () => 1",
      );

      expect(syncThrownMessage(() => ip.onDisconnect(ipItem).update({ count: NaN }))).toBe(
        "OnDisconnect.update failed: values argument contains NaN in property 'items.item-1.count'",
      );
      expect(syncThrownMessage(() => served.onDisconnect(servedItem).update({ count: NaN }))).toBe(
        "OnDisconnect.update failed: values argument contains NaN in property 'items.item-1.count'",
      );

      // Overlapping paths and .info keys in OnDisconnect.update and update
      const ipRoot = ip.ref(ipDb);
      const servedRoot = served.ref(servedDb);

      const overlapMsg = (fnName: string) =>
        `${fnName} failed: values argument contains a path /items/item-1 that is ancestor of another path /items/item-1/name`;
      expect(
        syncThrownMessage(() => ip.update(ipRoot, { 'items/item-1': { name: 'a' }, 'items/item-1/name': 'b' })),
      ).toBe(overlapMsg('update'));
      expect(
        syncThrownMessage(() => served.update(servedRoot, { 'items/item-1': { name: 'a' }, 'items/item-1/name': 'b' })),
      ).toBe(overlapMsg('update'));
      expect(
        syncThrownMessage(() =>
          ip.onDisconnect(ipRoot).update({ 'items/item-1': { name: 'a' }, 'items/item-1/name': 'b' }),
        ),
      ).toBe(overlapMsg('OnDisconnect.update'));
      expect(
        syncThrownMessage(() =>
          served.onDisconnect(servedRoot).update({ 'items/item-1': { name: 'a' }, 'items/item-1/name': 'b' }),
        ),
      ).toBe(overlapMsg('OnDisconnect.update'));

      const infoKeyMsg = (fnName: string) =>
        `${fnName} failed: values argument contains an invalid key (.info) in path /.info/connected. ` +
        'Keys must be non-empty strings and can\'t contain ".", "#", "$", "/", "[", or "]"';
      expect(syncThrownMessage(() => ip.update(ipRoot, { '.info/connected': true }))).toBe(infoKeyMsg('update'));
      expect(syncThrownMessage(() => served.update(servedRoot, { '.info/connected': true }))).toBe(
        infoKeyMsg('update'),
      );
      expect(syncThrownMessage(() => ip.onDisconnect(ipRoot).update({ '.info/connected': true }))).toBe(
        infoKeyMsg('OnDisconnect.update'),
      );
      expect(syncThrownMessage(() => served.onDisconnect(servedRoot).update({ '.info/connected': true }))).toBe(
        infoKeyMsg('OnDisconnect.update'),
      );
    } finally {
      await cleanup();
    }
  });
});
