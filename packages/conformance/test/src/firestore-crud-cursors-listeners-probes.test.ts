import { describe, expect, test } from 'bun:test';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';
import { probe as crudConverterProbe } from '../../probes/firestore/firestore-crud-converter-delete-and-adddoc.ts';
import { probe as onSnapshotFilteredProbe } from '../../probes/firestore/firestore-onsnapshot-filtered-timestamp-and-refs.ts';
import { probe as queryCursorsProbe } from '../../probes/firestore/firestore-query-cursors-endat-snap-and-pagination.ts';

const FIRESTORE_CRUD_CURSOR_LISTENER_PROBE_IDS = [
  'firestore-crud-converter-delete-and-adddoc',
  'firestore-onsnapshot-filtered-timestamp-and-refs',
  'firestore-query-cursors-endat-snap-and-pagination',
] as const;

describe('Firestore CRUD, cursor pagination, and filtered listener staged probes (sdk-probes)', () => {
  test('registers all 3 Firestore probes on sdk-probes with pendingRowLink and empty rowIds', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of FIRESTORE_CRUD_CURSOR_LISTENER_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    const probes = [crudConverterProbe, queryCursorsProbe, onSnapshotFilteredProbe];
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

    expectStagedUntilCaptured(FIRESTORE_CRUD_CURSOR_LISTENER_PROBE_IDS, {
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
      lines.some((line) => line.includes('firestore-onsnapshot-filtered-timestamp-and-refs')),
    ).toBe(true);
  });
});
