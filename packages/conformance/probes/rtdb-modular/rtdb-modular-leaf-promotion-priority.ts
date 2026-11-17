import type { Probe } from '../../rigs/types.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

interface PromotionSubcaseOutcome {
  beforeServerExport: unknown;
  afterWriterClientPriority?: string | number | null;
  afterWriterClientExport?: unknown;
  afterFreshClientPriority: string | number | null;
  afterFreshClientExport: unknown;
  afterServerExport: unknown;
}

async function waitForServerChildValue(
  readExport: () => Promise<unknown>,
  expectedChild: string,
  timeoutMs = 10_000,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let latest: unknown = null;
  while (Date.now() < deadline) {
    latest = await readExport();
    if (typeof latest === 'object' && latest !== null) {
      const childVal = (latest as Record<string, unknown>).child;
      if (childVal === expectedChild) {
        return latest;
      }
      if (
        typeof childVal === 'object' &&
        childVal !== null &&
        (childVal as Record<string, unknown>)['.value'] === expectedChild
      ) {
        return latest;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for onDisconnect child '${expectedChild}' to materialize (last export: ${JSON.stringify(latest)})`,
  );
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  matrixRow: 'rtdb-modular#leaf-promotion-priority',
  rowIds: ['rtdb-modular#leaf-promotion-priority'],
  description:
    'RTDB leaf-to-parent promotion .priority retention when a scalar leaf carrying a numeric or string priority acquires a child via direct set/update, committed-leaf onDisconnect set/update, or same-session queued onDisconnect folding.',
  async observe() {
    return withRtdbProbeSession({}, async ({ db, runPath, rtdbSdk, openClient, adminRead }) => {
      const { get, goOffline, onDisconnect, ref, set, setWithPriority, update } = rtdbSdk;

      const readViaFreshClient = async (
        label: string,
        subpath: string,
      ): Promise<{ priority: string | number | null; exportVal: unknown }> => {
        const reader = await openClient(label);
        try {
          const snap = await get(ref(reader.db, `${runPath}/${subpath}`));
          return { priority: snap.priority, exportVal: snap.exportVal() };
        } finally {
          goOffline(reader.db);
        }
      };

      const runOnDisconnectPromotion = async (spec: {
        label: string;
        folder: string;
        expectedChild: string;
        setup: (writerDb: typeof db) => Promise<void>;
      }): Promise<PromotionSubcaseOutcome> => {
        const writer = await openClient(`${spec.label}-writer`);
        await spec.setup(writer.db);
        const beforeServerExport = await adminRead(`${spec.folder}/node`, true);
        goOffline(writer.db);
        const afterServerExport = await waitForServerChildValue(
          () => adminRead(`${spec.folder}/node`, true),
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

      // 1. Direct child `set()` promoting a scalar leaf with numeric priority 42
      const directSetNode = ref(db, `${runPath}/directSet/node`);
      await setWithPriority(directSetNode, 'leaf-val', 42);
      const beforeDirectSet = await adminRead('directSet/node', true);
      await set(ref(db, `${runPath}/directSet/node/child`), 'v1');
      const writerSetSnap = await get(directSetNode);
      const freshSet = await readViaFreshClient('reader-direct-set', 'directSet/node');
      const afterDirectSet = await adminRead('directSet/node', true);

      const directSetPromotion: PromotionSubcaseOutcome = {
        beforeServerExport: beforeDirectSet,
        afterWriterClientPriority: writerSetSnap.priority,
        afterWriterClientExport: writerSetSnap.exportVal(),
        afterFreshClientPriority: freshSet.priority,
        afterFreshClientExport: freshSet.exportVal,
        afterServerExport: afterDirectSet,
      };

      // 2. Direct multi-path `update()` promoting a scalar leaf with string priority
      const directUpdateNode = ref(db, `${runPath}/directUpdate/node`);
      await setWithPriority(directUpdateNode, 99, 'prio-alpha');
      const beforeDirectUpdate = await adminRead('directUpdate/node', true);
      await update(ref(db, `${runPath}/directUpdate`), { 'node/child': 'v2' });
      const writerUpdateSnap = await get(directUpdateNode);
      const freshUpdate = await readViaFreshClient('reader-direct-update', 'directUpdate/node');
      const afterDirectUpdate = await adminRead('directUpdate/node', true);

      const directUpdatePromotion: PromotionSubcaseOutcome = {
        beforeServerExport: beforeDirectUpdate,
        afterWriterClientPriority: writerUpdateSnap.priority,
        afterWriterClientExport: writerUpdateSnap.exportVal(),
        afterFreshClientPriority: freshUpdate.priority,
        afterFreshClientExport: freshUpdate.exportVal,
        afterServerExport: afterDirectUpdate,
      };

      // 3. Committed scalar leaf promoted by `onDisconnect(node/child).set(...)`
      const onDisconnectSetPromotion = await runOnDisconnectPromotion({
        label: 'disconnect-set',
        folder: 'onDisconnectSet',
        expectedChild: 'from-disconnect',
        async setup(writerDb) {
          await setWithPriority(ref(writerDb, `${runPath}/onDisconnectSet/node`), 'leaf-val', 77);
          await onDisconnect(ref(writerDb, `${runPath}/onDisconnectSet/node/child`)).set(
            'from-disconnect',
          );
        },
      });

      // 4. Committed scalar leaf promoted by `onDisconnect(parent).update({ 'node/child': ... })`
      const onDisconnectUpdatePromotion = await runOnDisconnectPromotion({
        label: 'disconnect-update',
        folder: 'onDisconnectUpdate',
        expectedChild: 'from-disconnect-update',
        async setup(writerDb) {
          await setWithPriority(
            ref(writerDb, `${runPath}/onDisconnectUpdate/node`),
            'leaf-val',
            'prio-beta',
          );
          await onDisconnect(ref(writerDb, `${runPath}/onDisconnectUpdate`)).update({
            'node/child': 'from-disconnect-update',
          });
        },
      });

      // 5. Same-session queued `onDisconnect(node).setWithPriority(...)` folded with `onDisconnect(node/child).set(...)`
      const queuedOnDisconnectSetPromotion = await runOnDisconnectPromotion({
        label: 'queued-disconnect-set',
        folder: 'queuedOnDisconnectSet',
        expectedChild: 'from-queued-set',
        async setup(writerDb) {
          await onDisconnect(
            ref(writerDb, `${runPath}/queuedOnDisconnectSet/node`),
          ).setWithPriority('leaf-val', 88);
          await onDisconnect(ref(writerDb, `${runPath}/queuedOnDisconnectSet/node/child`)).set(
            'from-queued-set',
          );
        },
      });

      // 6. Same-session queued `onDisconnect(node).setWithPriority(...)` folded with `onDisconnect(parent).update({ 'node/child': ... })`
      const queuedOnDisconnectUpdatePromotion = await runOnDisconnectPromotion({
        label: 'queued-disconnect-update',
        folder: 'queuedOnDisconnectUpdate',
        expectedChild: 'from-queued-update',
        async setup(writerDb) {
          await onDisconnect(
            ref(writerDb, `${runPath}/queuedOnDisconnectUpdate/node`),
          ).setWithPriority('leaf-val', 'prio-gamma');
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
    });
  },
};
