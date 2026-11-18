import { describe, expect, test } from 'bun:test';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { probe as refEqualAndAggProbe } from '../../probes/firestore/firestore-refequal-and-aggregate-equality.ts';
import { probe as runtimeClassesProbe } from '../../probes/firestore/firestore-runtime-classes-and-instanceof.ts';
import { probe as txnAndBatchProbe } from '../../probes/firestore/firestore-transaction-and-batch-queued-mutations.ts';

const FIRESTORE_SLICE13_PROBE_IDS = [
  'firestore-refequal-and-aggregate-equality',
  'firestore-runtime-classes-and-instanceof',
  'firestore-transaction-and-batch-queued-mutations',
] as const;

describe('Firestore transaction, batch, equality, server reads, and runtime classes linked probes (sdk-probes)', () => {
  test('registers all 3 Firestore probes on sdk-probes with linked matrixRow and rowIds', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of FIRESTORE_SLICE13_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    expect(txnAndBatchProbe.pendingRowLink).toBeUndefined();
    expect(txnAndBatchProbe.matrixRow).toBe('firestore#91');
    expect(txnAndBatchProbe.rowIds).toEqual(['firestore#91', 'firestore#95']);

    expect(refEqualAndAggProbe.pendingRowLink).toBeUndefined();
    expect(refEqualAndAggProbe.matrixRow).toBe('firestore#112');
    expect(refEqualAndAggProbe.rowIds).toEqual([
      'firestore#112',
      'firestore#114',
      'firestore#118',
      'firestore#147',
      'firestore#155',
    ]);

    expect(runtimeClassesProbe.pendingRowLink).toBeUndefined();
    expect(runtimeClassesProbe.matrixRow).toBe('firestore#151');
    expect(runtimeClassesProbe.rowIds).toEqual(['firestore#151']);

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );
    for (const id of FIRESTORE_SLICE13_PROBE_IDS) {
      expect(unfilteredIds.has(id)).toBe(true);
    }

    const lines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded,
      log: (line) => lines.push(line),
    });
    expect(
      lines.some((line) => line.includes('firestore-runtime-classes-and-instanceof')),
    ).toBe(true);
  });
});
