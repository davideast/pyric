import { describe, expect, test } from 'bun:test';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';
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

describe('Firestore Sentinels and Scalar types staged probes (sdk-probes)', () => {
  test('registers all 4 Sentinels/Scalars probes on sdk-probes with pendingRowLink and empty rowIds', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of SENTINEL_SCALAR_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    const probes = [
      docIdFieldPathQueryProbe,
      scalarRoundTripProbe,
      sentinelMismatchProbe,
      timestampProbe,
    ];
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

    expectStagedUntilCaptured(SENTINEL_SCALAR_PROBE_IDS, {
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
      lines.some((line) =>
        line.includes('firestore-timestamp-roundtrip-and-negative-millis'),
      ),
    ).toBe(true);
  });
});
