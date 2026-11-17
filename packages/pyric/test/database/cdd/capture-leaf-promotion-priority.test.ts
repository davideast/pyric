import { describe, expect, it } from 'bun:test';
import {
  get,
  getAdminDatabase,
  getDatabase,
  goOffline,
  onDisconnect,
  ref,
  set,
  setWithPriority,
  update,
  type Database,
} from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/database';
import { expectReplay, obs } from './capture-replay.ts';

const row = (id: string, assertion: () => unknown | Promise<unknown>) => it(`rtdb-modular#${id}`, assertion);

interface PromotionSubcaseOutcome {
  beforeServerExport: unknown;
  afterWriterClientPriority?: string | number | null;
  afterWriterClientExport?: unknown;
  afterFreshClientPriority: string | number | null;
  afterFreshClientExport: unknown;
  afterServerExport: unknown;
}

async function runInPageLeafPromotionScenario(): Promise<Record<string, PromotionSubcaseOutcome>> {
  const sandbox = initializeSandbox();
  setRules(sandbox, {
    rules: {
      pyric_oracle: {
        $run: {
          '.read': 'auth != null',
          '.write': 'auth != null',
        },
      },
    },
  });
  const adminDb = getAdminDatabase(sandbox);
  const runPath = '/pyric_oracle/replay';
  let clientSeq = 0;

  const openClient = (label: string): Database => {
    clientSeq += 1;
    return getDatabase(sandbox.withAuth({ uid: `${label}-${clientSeq}` }));
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
      const snap = await get(ref(readerDb, `${runPath}/${subpath}`));
      return { priority: snap.priority, exportVal: snap.exportVal() };
    } finally {
      goOffline(readerDb);
    }
  };

  const runOnDisconnectPromotion = async (spec: {
    label: string;
    folder: string;
    setup: (writerDb: Database) => Promise<void>;
  }): Promise<PromotionSubcaseOutcome> => {
    const writerDb = openClient(`${spec.label}-writer`);
    await spec.setup(writerDb);
    const beforeServerExport = await adminExport(`${spec.folder}/node`);
    goOffline(writerDb);
    const afterServerExport = await adminExport(`${spec.folder}/node`);
    const fresh = await readViaFreshClient(`${spec.label}-reader`, `${spec.folder}/node`);
    return {
      beforeServerExport,
      afterFreshClientPriority: fresh.priority,
      afterFreshClientExport: fresh.exportVal,
      afterServerExport,
    };
  };

  const mainDb = openClient('main');

  const directSetNode = ref(mainDb, `${runPath}/directSet/node`);
  await setWithPriority(directSetNode, 'leaf-val', 42);
  const beforeDirectSet = await adminExport('directSet/node');
  await set(ref(mainDb, `${runPath}/directSet/node/child`), 'v1');
  const writerSetSnap = await get(directSetNode);
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

  const directUpdateNode = ref(mainDb, `${runPath}/directUpdate/node`);
  await setWithPriority(directUpdateNode, 99, 'prio-alpha');
  const beforeDirectUpdate = await adminExport('directUpdate/node');
  await update(ref(mainDb, `${runPath}/directUpdate`), { 'node/child': 'v2' });
  const writerUpdateSnap = await get(directUpdateNode);
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
    async setup(writerDb) {
      await setWithPriority(ref(writerDb, `${runPath}/onDisconnectSet/node`), 'leaf-val', 77);
      await onDisconnect(ref(writerDb, `${runPath}/onDisconnectSet/node/child`)).set('from-disconnect');
    },
  });

  const onDisconnectUpdatePromotion = await runOnDisconnectPromotion({
    label: 'disconnect-update',
    folder: 'onDisconnectUpdate',
    async setup(writerDb) {
      await setWithPriority(ref(writerDb, `${runPath}/onDisconnectUpdate/node`), 'leaf-val', 'prio-beta');
      await onDisconnect(ref(writerDb, `${runPath}/onDisconnectUpdate`)).update({
        'node/child': 'from-disconnect-update',
      });
    },
  });

  const queuedOnDisconnectSetPromotion = await runOnDisconnectPromotion({
    label: 'queued-disconnect-set',
    folder: 'queuedOnDisconnectSet',
    async setup(writerDb) {
      await onDisconnect(ref(writerDb, `${runPath}/queuedOnDisconnectSet/node`)).setWithPriority(
        'leaf-val',
        88,
      );
      await onDisconnect(ref(writerDb, `${runPath}/queuedOnDisconnectSet/node/child`)).set(
        'from-queued-set',
      );
    },
  });

  const queuedOnDisconnectUpdatePromotion = await runOnDisconnectPromotion({
    label: 'queued-disconnect-update',
    folder: 'queuedOnDisconnectUpdate',
    async setup(writerDb) {
      await onDisconnect(ref(writerDb, `${runPath}/queuedOnDisconnectUpdate/node`)).setWithPriority(
        'leaf-val',
        'prio-gamma',
      );
      await onDisconnect(ref(writerDb, `${runPath}/queuedOnDisconnectUpdate`)).update({
        'node/child': 'from-queued-update',
      });
    },
  });

  return {
    directSetPromotion,
    directUpdatePromotion,
    onDisconnectSetPromotion,
    onDisconnectUpdatePromotion,
    queuedOnDisconnectSetPromotion,
    queuedOnDisconnectUpdatePromotion,
  };
}

describe('SDK probes: RTDB leaf-to-parent promotion retains .priority', () => {
  row('leaf-promotion-priority', async () => {
    const production = obs('rtdb-modular-leaf-promotion-priority');
    const pyric = await runInPageLeafPromotionScenario();
    expectReplay({ production, pyric });

    // Also verify newData.getPriority() sees the retained ancestor priority during rules validation.
    const rulesSandbox = initializeSandbox();
    const adminDb = getAdminDatabase(rulesSandbox);
    const writerDb = getDatabase(rulesSandbox.withAuth({ uid: 'writer-1' }));
    await setWithPriority(ref(adminDb, 'items/n1'), 'scalar-seed', 42);
    await setWithPriority(ref(adminDb, 'items/n2'), 'scalar-seed', 'prio-alpha');
    setRules(rulesSandbox, {
      rules: {
        items: {
          n1: {
            '.read': 'auth != null',
            '.write': 'auth != null',
            '.validate': 'newData.getPriority() === 42',
          },
          n2: {
            '.read': 'auth != null',
            '.write': 'auth != null',
            '.validate': "newData.getPriority() === 'prio-alpha'",
          },
        },
      },
    });

    await set(ref(writerDb, 'items/n1/child'), 'v1');
    await update(ref(writerDb, 'items'), { 'n2/child': 'v2' });
    expect((await get(ref(writerDb, 'items/n1'))).exportVal()).toEqual({
      '.priority': 42,
      child: 'v1',
    });
    expect((await get(ref(writerDb, 'items/n2'))).exportVal()).toEqual({
      '.priority': 'prio-alpha',
      child: 'v2',
    });
  });
});
