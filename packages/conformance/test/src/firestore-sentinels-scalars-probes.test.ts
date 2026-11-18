import { describe, expect, test } from 'bun:test';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { probe as docIdFieldPathQueryProbe } from '../../probes/firestore/firestore-query-documentid-and-nested-fieldpath.ts';
import { probe as scalarRoundTripProbe } from '../../probes/firestore/firestore-scalar-bytes-geopoint-vector-roundtrip.ts';
import { probe as sentinelMismatchProbe } from '../../probes/firestore/firestore-sentinel-type-mismatch-overwrite.ts';
import { probe as timestampProbe } from '../../probes/firestore/firestore-timestamp-roundtrip-and-negative-millis.ts';

const SENTINEL_SCALAR_PROBE_IDS = [
  'firestore-query-documentid-and-nested-fieldpath',
  'firestore-scalar-bytes-geopoint-vector-roundtrip',
  'firestore-sentinel-type-mismatch-overwrite',
  'firestore-timestamp-roundtrip-and-negative-millis',
] as const;

describe('Firestore Sentinels and Scalar types probes (sdk-probes)', () => {
  test('registers all 4 Sentinels/Scalars probes linked to firestore#104, #104a, #104b, #105a, #106..108, #111', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of SENTINEL_SCALAR_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    const expectedLinks = [
      {
        probeRecord: timestampProbe,
        matrixRow: 'firestore#104',
        rowIds: ['firestore#104', 'firestore#104a', 'firestore#104b'],
      },
      {
        probeRecord: sentinelMismatchProbe,
        matrixRow: 'firestore#105a',
        rowIds: ['firestore#105a'],
      },
      {
        probeRecord: scalarRoundTripProbe,
        matrixRow: 'firestore#106',
        rowIds: ['firestore#106', 'firestore#111'],
      },
      {
        probeRecord: docIdFieldPathQueryProbe,
        matrixRow: 'firestore#107',
        rowIds: ['firestore#107', 'firestore#108'],
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
    for (const id of SENTINEL_SCALAR_PROBE_IDS) {
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
      lines.some((line) =>
        line.includes('firestore-timestamp-roundtrip-and-negative-millis'),
      ),
    ).toBe(true);
  });
});
