import { describe, expect, test } from 'bun:test';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { probe as getDocShapeProbe } from '../../probes/firestore/firestore-getdoc-snapshot-shape-missing-and-ref.ts';
import { probe as getDocsForEachProbe } from '../../probes/firestore/firestore-getdocs-foreach-thisarg-and-arity.ts';
import { probe as getDocsShapeProbe } from '../../probes/firestore/firestore-getdocs-snapshot-empty-and-doc-refs.ts';
import { probe as snapshotGetProbe } from '../../probes/firestore/firestore-snapshot-get-dotted-and-fieldpath.ts';

const FIRESTORE_READ_PROBE_IDS = [
  'firestore-getdoc-snapshot-shape-missing-and-ref',
  'firestore-getdocs-foreach-thisarg-and-arity',
  'firestore-getdocs-snapshot-empty-and-doc-refs',
  'firestore-snapshot-get-dotted-and-fieldpath',
] as const;

describe('Firestore getDoc and getDocs probes (sdk-probes)', () => {
  test('registers all 4 Firestore getDoc/getDocs probes linked to firestore#16..19, #22, #22a, #23, #25', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of FIRESTORE_READ_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    const expectedLinks = [
      {
        probeRecord: getDocShapeProbe,
        matrixRow: 'firestore#16',
        rowIds: ['firestore#16', 'firestore#17', 'firestore#18', 'firestore#19'],
      },
      {
        probeRecord: getDocsShapeProbe,
        matrixRow: 'firestore#22',
        rowIds: ['firestore#22', 'firestore#23', 'firestore#25'],
      },
      {
        probeRecord: getDocsForEachProbe,
        matrixRow: 'firestore#22a',
        rowIds: ['firestore#22a'],
      },
      {
        probeRecord: snapshotGetProbe,
        matrixRow: 'firestore#22a',
        rowIds: ['firestore#22a'],
      },
    ];

    for (const { probeRecord, matrixRow, rowIds } of expectedLinks) {
      expect(probeRecord.rig).toBe('sdk-probes');
      expect(probeRecord.requires).toEqual(['web-config', 'firestore-rules']);
      expect(probeRecord.pendingRowLink).toBeUndefined();
      expect(probeRecord.matrixRow).toBe(matrixRow);
      expect(probeRecord.rowIds).toEqual(rowIds);
      expect(probeRecord.description.length).toBeGreaterThan(20);
    }

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );
    for (const id of FIRESTORE_READ_PROBE_IDS) {
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
      lines.some((line) => line.includes('firestore-getdoc-snapshot-shape-missing-and-ref')),
    ).toBe(true);
  });
});
