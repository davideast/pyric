import { describe, expect, test } from 'bun:test';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { probe as crudConverterProbe } from '../../probes/firestore/firestore-crud-converter-delete-and-adddoc.ts';
import { probe as onSnapshotFilteredProbe } from '../../probes/firestore/firestore-onsnapshot-filtered-timestamp-and-refs.ts';
import { probe as queryCursorsProbe } from '../../probes/firestore/firestore-query-cursors-endat-snap-and-pagination.ts';

const FIRESTORE_CRUD_CURSOR_LISTENER_PROBE_IDS = [
  'firestore-crud-converter-delete-and-adddoc',
  'firestore-onsnapshot-filtered-timestamp-and-refs',
  'firestore-query-cursors-endat-snap-and-pagination',
] as const;

describe('Firestore CRUD, cursor pagination, and filtered listener linked probes (sdk-probes)', () => {
  test('registers all 3 Firestore probes on sdk-probes with linked rowIds', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of FIRESTORE_CRUD_CURSOR_LISTENER_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    expect(crudConverterProbe.rig).toBe('sdk-probes');
    expect(crudConverterProbe.requires).toEqual(['web-config', 'firestore-rules']);
    expect(crudConverterProbe.pendingRowLink).toBeUndefined();
    expect(crudConverterProbe.matrixRow).toBe('firestore#35');
    expect(crudConverterProbe.rowIds).toEqual([
      'firestore#35',
      'firestore#38',
      'firestore#41',
      'firestore#44',
    ]);

    expect(queryCursorsProbe.rig).toBe('sdk-probes');
    expect(queryCursorsProbe.requires).toEqual(['web-config', 'firestore-rules']);
    expect(queryCursorsProbe.pendingRowLink).toBeUndefined();
    expect(queryCursorsProbe.matrixRow).toBe('firestore#72');
    expect(queryCursorsProbe.rowIds).toEqual(['firestore#72', 'firestore#73']);

    expect(onSnapshotFilteredProbe.rig).toBe('sdk-probes');
    expect(onSnapshotFilteredProbe.requires).toEqual(['web-config', 'firestore-rules']);
    expect(onSnapshotFilteredProbe.pendingRowLink).toBeUndefined();
    expect(onSnapshotFilteredProbe.matrixRow).toBe('firestore#81a');
    expect(onSnapshotFilteredProbe.rowIds).toEqual([
      'firestore#81a',
      'firestore#81b',
      'firestore#86',
    ]);

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );
    for (const id of FIRESTORE_CRUD_CURSOR_LISTENER_PROBE_IDS) {
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
      lines.some((line) => line.includes('firestore-onsnapshot-filtered-timestamp-and-refs')),
    ).toBe(true);
  });
});
