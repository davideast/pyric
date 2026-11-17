import { it } from 'bun:test';
import { get, getAdminDatabase, ref } from 'pyric/database';
import * as client from '../../../../src/serve/worker/index.js';
import { setDatabaseRules } from '../../../../src/serve/worker/host/rules.js';
import { connectClientToHost, makeHostCtx, sleep } from '../integration-support.js';
import { expectReplay, load, restoreSharedWorker } from './support.ts';

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
