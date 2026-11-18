import { describe, expect, test } from 'bun:test';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';
import { probe as refEqualAndAggProbe } from '../../probes/firestore/firestore-refequal-and-aggregate-equality.ts';
import { probe as runtimeClassesProbe } from '../../probes/firestore/firestore-runtime-classes-and-instanceof.ts';
import { probe as txnAndBatchProbe } from '../../probes/firestore/firestore-transaction-and-batch-queued-mutations.ts';

const FIRESTORE_SLICE13_PROBE_IDS = [
  'firestore-refequal-and-aggregate-equality',
  'firestore-runtime-classes-and-instanceof',
  'firestore-transaction-and-batch-queued-mutations',
] as const;

describe('Firestore transaction, batch, equality, server reads, and runtime classes staged probes (sdk-probes)', () => {
  test('registers all 3 Firestore probes on sdk-probes with pendingRowLink and empty rowIds', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of FIRESTORE_SLICE13_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    const probes = [txnAndBatchProbe, refEqualAndAggProbe, runtimeClassesProbe];
    for (const probeRecord of probes) {
      expect(probeRecord.rig).toBe('sdk-probes');
      expect(probeRecord.requires).toEqual(['web-config', 'firestore-rules']);
      expect(probeRecord.pendingRowLink).toBe(true);
      expect(probeRecord.matrixRow).toBe('');
      expect(probeRecord.rowIds).toEqual([]);
      expect(probeRecord.description.length).toBeGreaterThan(20);
    }

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );

    expectStagedUntilCaptured(FIRESTORE_SLICE13_PROBE_IDS, {
      rig: 'sdk-probes',
      filterFlag: '--probe',
      filterValueFor: (name) => name,
      whenUncaptured(name) {
        expect(unfilteredIds.has(name)).toBe(false);
      },
      whenCaptured(name) {
        expect(unfilteredIds.has(name)).toBe(true);
      },
    });

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
