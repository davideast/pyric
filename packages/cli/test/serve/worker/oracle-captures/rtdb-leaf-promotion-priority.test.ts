import { describe, expect, it } from 'bun:test';
import { get, getAdminDatabase, ref } from 'pyric/database';
import * as client from '../../../../src/serve/worker/index.js';
import { setDatabaseRules } from '../../../../src/serve/worker/host/rules.js';
import { connectClientToHost, makeHostCtx, sleep } from '../integration-support.js';
import {
  expectReplay,
  hostedRtdbContext,
  load,
  restoreSharedWorker,
  servedRtdbContext,
  type ServedRtdbAdminContext,
} from './support.ts';

restoreSharedWorker();

interface PromotionSubcaseOutcome {
  beforeServerExport: unknown;
  afterWriterClientPriority?: string | number | null;
  afterWriterClientExport?: unknown;
  afterFreshClientPriority: string | number | null;
  afterFreshClientExport: unknown;
  afterServerExport: unknown;
}

async function waitForChildExport(
  readExport: () => Promise<unknown>,
  expectedChild: string,
): Promise<unknown> {
  const deadline = Date.now() + 2_000;
  let latest: unknown = null;
  while (Date.now() < deadline) {
    latest = await readExport();
    if (typeof latest === 'object' && latest !== null) {
      const childVal = (latest as Record<string, unknown>).child;
      if (childVal === expectedChild) {
        return latest;
      }
    }
    await sleep(5);
  }
  throw new Error(`Timed out waiting for child '${expectedChild}' (last: ${JSON.stringify(latest)})`);
}

it('rtdb-modular-leaf-promotion-priority, served', async () => {
  const ctx = await makeHostCtx();
  setDatabaseRules(ctx, undefined, { rules: { '.read': true, '.write': true } });
  const adminDb = getAdminDatabase(ctx.sandbox);
  const runPath = '/pyric_oracle/replay';
  let seq = 0;

  const openClient = (label: string) => {
    seq += 1;
    const connected = connectClientToHost(ctx, `worker://leaf-prio-${label}-${seq}`);
    return client.rtdbGetDatabase(connected.db);
  };

  const adminExport = async (subpath: string): Promise<unknown> => {
    const snap = await get(ref(adminDb, `${runPath}/${subpath}`));
    return snap.exportVal();
  };

  const readViaFreshClient = async (
    label: string,
    subpath: string,
  ): Promise<{ priority: string | number | null; exportVal: unknown }> => {
    const readerDb = openClient(label);
    try {
      const snap = await client.rtdbGet(client.rtdbRef(readerDb, `${runPath}/${subpath}`));
      return { priority: snap.priority, exportVal: snap.exportVal() };
    } finally {
      client.rtdbGoOffline(readerDb);
    }
  };

  const runOnDisconnectPromotion = async (spec: {
    label: string;
    folder: string;
    expectedChild: string;
    setup: (writerDb: ReturnType<typeof openClient>) => Promise<void>;
  }): Promise<PromotionSubcaseOutcome> => {
    const writerDb = openClient(`${spec.label}-writer`);
    await spec.setup(writerDb);
    const beforeServerExport = await adminExport(`${spec.folder}/node`);
    client.rtdbGoOffline(writerDb);
    const afterServerExport = await waitForChildExport(
      () => adminExport(`${spec.folder}/node`),
      spec.expectedChild,
    );
    const fresh = await readViaFreshClient(`${spec.label}-reader`, `${spec.folder}/node`);
    return {
      beforeServerExport,
      afterFreshClientPriority: fresh.priority,
      afterFreshClientExport: fresh.exportVal,
      afterServerExport,
    };
  };

  const mainDb = openClient('main');

  const directSetNode = client.rtdbRef(mainDb, `${runPath}/directSet/node`);
  await client.rtdbSetWithPriority(directSetNode, 'leaf-val', 42);
  const beforeDirectSet = await adminExport('directSet/node');
  await client.rtdbSet(client.rtdbRef(mainDb, `${runPath}/directSet/node/child`), 'v1');
  const writerSetSnap = await client.rtdbGet(directSetNode);
  const freshSet = await readViaFreshClient('reader-direct-set', 'directSet/node');
  const afterDirectSet = await adminExport('directSet/node');

  const directSetPromotion: PromotionSubcaseOutcome = {
    beforeServerExport: beforeDirectSet,
    afterWriterClientPriority: writerSetSnap.priority,
    afterWriterClientExport: writerSetSnap.exportVal(),
    afterFreshClientPriority: freshSet.priority,
    afterFreshClientExport: freshSet.exportVal,
    afterServerExport: afterDirectSet,
  };

  const directUpdateNode = client.rtdbRef(mainDb, `${runPath}/directUpdate/node`);
  await client.rtdbSetWithPriority(directUpdateNode, 99, 'prio-alpha');
  const beforeDirectUpdate = await adminExport('directUpdate/node');
  await client.rtdbUpdate(client.rtdbRef(mainDb, `${runPath}/directUpdate`), { 'node/child': 'v2' });
  const writerUpdateSnap = await client.rtdbGet(directUpdateNode);
  const freshUpdate = await readViaFreshClient('reader-direct-update', 'directUpdate/node');
  const afterDirectUpdate = await adminExport('directUpdate/node');

  const directUpdatePromotion: PromotionSubcaseOutcome = {
    beforeServerExport: beforeDirectUpdate,
    afterWriterClientPriority: writerUpdateSnap.priority,
    afterWriterClientExport: writerUpdateSnap.exportVal(),
    afterFreshClientPriority: freshUpdate.priority,
    afterFreshClientExport: freshUpdate.exportVal,
    afterServerExport: afterDirectUpdate,
  };

  const onDisconnectSetPromotion = await runOnDisconnectPromotion({
    label: 'disconnect-set',
    folder: 'onDisconnectSet',
    expectedChild: 'from-disconnect',
    async setup(writerDb) {
      await client.rtdbSetWithPriority(
        client.rtdbRef(writerDb, `${runPath}/onDisconnectSet/node`),
        'leaf-val',
        77,
      );
      await client
        .rtdbOnDisconnect(client.rtdbRef(writerDb, `${runPath}/onDisconnectSet/node/child`))
        .set('from-disconnect');
    },
  });

  const onDisconnectUpdatePromotion = await runOnDisconnectPromotion({
    label: 'disconnect-update',
    folder: 'onDisconnectUpdate',
    expectedChild: 'from-disconnect-update',
    async setup(writerDb) {
      await client.rtdbSetWithPriority(
        client.rtdbRef(writerDb, `${runPath}/onDisconnectUpdate/node`),
        'leaf-val',
        'prio-beta',
      );
      await client
        .rtdbOnDisconnect(client.rtdbRef(writerDb, `${runPath}/onDisconnectUpdate`))
        .update({ 'node/child': 'from-disconnect-update' });
    },
  });

  const queuedOnDisconnectSetPromotion = await runOnDisconnectPromotion({
    label: 'queued-disconnect-set',
    folder: 'queuedOnDisconnectSet',
    expectedChild: 'from-queued-set',
    async setup(writerDb) {
      await client
        .rtdbOnDisconnect(client.rtdbRef(writerDb, `${runPath}/queuedOnDisconnectSet/node`))
        .setWithPriority('leaf-val', 88);
      await client
        .rtdbOnDisconnect(client.rtdbRef(writerDb, `${runPath}/queuedOnDisconnectSet/node/child`))
        .set('from-queued-set');
    },
  });

  const queuedOnDisconnectUpdatePromotion = await runOnDisconnectPromotion({
    label: 'queued-disconnect-update',
    folder: 'queuedOnDisconnectUpdate',
    expectedChild: 'from-queued-update',
    async setup(writerDb) {
      await client
        .rtdbOnDisconnect(client.rtdbRef(writerDb, `${runPath}/queuedOnDisconnectUpdate/node`))
        .setWithPriority('leaf-val', 'prio-gamma');
      await client
        .rtdbOnDisconnect(client.rtdbRef(writerDb, `${runPath}/queuedOnDisconnectUpdate`))
        .update({ 'node/child': 'from-queued-update' });
    },
  });

  expectReplay({
    production: load('rtdb-modular-leaf-promotion-priority'),
    pyric: {
      directSetPromotion,
      directUpdatePromotion,
      onDisconnectSetPromotion,
      onDisconnectUpdatePromotion,
      queuedOnDisconnectSetPromotion,
      queuedOnDisconnectUpdatePromotion,
    },
  });
});

const ROOT_PLANES: ReadonlyArray<[string, () => Promise<ServedRtdbAdminContext>]> = [
  ['served SharedWorker', () => servedRtdbContext()],
  ['served Node host', () => hostedRtdbContext()],
];

for (const [planeName, createContext] of ROOT_PLANES) {
  describe(`rtdb-modular root primitive and child promotion (${planeName}, M73)`, () => {
    it('replays rtdb-modular-leaf-promotion-priority and rtdb-modular-set-replaces-not-merges at root ref(db)', async () => {
      const promoObs = load('rtdb-modular-leaf-promotion-priority') as {
        directSetPromotion: {
          beforeServerExport: unknown;
          afterWriterClientPriority: unknown;
          afterWriterClientExport: unknown;
          afterFreshClientPriority: unknown;
          afterFreshClientExport: unknown;
        };
        directUpdatePromotion: {
          beforeServerExport: unknown;
          afterWriterClientPriority: unknown;
          afterWriterClientExport: unknown;
          afterFreshClientPriority: unknown;
          afterFreshClientExport: unknown;
        };
      };
      const replaceObs = load('rtdb-modular-set-replaces-not-merges') as {
        final: Record<string, unknown>;
        finalKeys: string[];
        bIsAbsent: boolean;
      };

      const ctx = await createContext();
      const reader = await ctx.newClient('root-reader');

      await ctx.rtdb.setWithPriority(ctx.rtdb.ref(ctx.db), 'leaf-val', 42);
      expect((await ctx.rtdb.get(ctx.rtdb.ref(reader.db))).exportVal()).toEqual(
        promoObs.directSetPromotion.beforeServerExport,
      );
      await ctx.rtdb.set(ctx.rtdb.ref(ctx.db, 'child'), 'v1');
      const writerAfterSet = await ctx.rtdb.get(ctx.rtdb.ref(ctx.db));
      const readerAfterSet = await ctx.rtdb.get(ctx.rtdb.ref(reader.db));
      expect(writerAfterSet.priority).toBe(promoObs.directSetPromotion.afterWriterClientPriority as number);
      expect(writerAfterSet.exportVal()).toEqual(promoObs.directSetPromotion.afterWriterClientExport);
      expect(readerAfterSet.priority).toBe(promoObs.directSetPromotion.afterFreshClientPriority as number);
      expect(readerAfterSet.exportVal()).toEqual(promoObs.directSetPromotion.afterFreshClientExport);

      await ctx.rtdb.setWithPriority(ctx.rtdb.ref(ctx.db), 99, 'prio-alpha');
      expect((await ctx.rtdb.get(ctx.rtdb.ref(reader.db))).exportVal()).toEqual(
        promoObs.directUpdatePromotion.beforeServerExport,
      );
      await ctx.rtdb.update(ctx.rtdb.ref(ctx.db), { child: 'v2' });
      const writerAfterUpdate = await ctx.rtdb.get(ctx.rtdb.ref(ctx.db));
      const readerAfterUpdate = await ctx.rtdb.get(ctx.rtdb.ref(reader.db));
      expect(writerAfterUpdate.priority).toBe(promoObs.directUpdatePromotion.afterWriterClientPriority as string);
      expect(writerAfterUpdate.exportVal()).toEqual(promoObs.directUpdatePromotion.afterWriterClientExport);
      expect(readerAfterUpdate.priority).toBe(promoObs.directUpdatePromotion.afterFreshClientPriority as string);
      expect(readerAfterUpdate.exportVal()).toEqual(promoObs.directUpdatePromotion.afterFreshClientExport);

      await ctx.rtdb.set(ctx.rtdb.ref(ctx.db), { a: 1, b: 2 });
      await ctx.rtdb.set(ctx.rtdb.ref(ctx.db), { a: 1 });
      const replacedVal = (await ctx.rtdb.get(ctx.rtdb.ref(ctx.db))).val() as Record<string, unknown>;
      expect(replacedVal).toEqual(replaceObs.final);
      expect(Object.keys(replacedVal)).toEqual(replaceObs.finalKeys);
      expect('b' in replacedVal).toBe(!replaceObs.bIsAbsent);
    });
  });
}
