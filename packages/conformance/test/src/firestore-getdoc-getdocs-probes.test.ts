import { describe, expect, test } from 'bun:test';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';
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

describe('Firestore getDoc and getDocs staged probes (sdk-probes)', () => {
  test('registers all 4 Firestore getDoc/getDocs probes on sdk-probes with pendingRowLink and empty rowIds', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of FIRESTORE_READ_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    const probes = [getDocShapeProbe, getDocsForEachProbe, getDocsShapeProbe, snapshotGetProbe];
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

    expectStagedUntilCaptured(FIRESTORE_READ_PROBE_IDS, {
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
      lines.some((line) => line.includes('firestore-getdoc-snapshot-shape-missing-and-ref')),
    ).toBe(true);
  });
});
