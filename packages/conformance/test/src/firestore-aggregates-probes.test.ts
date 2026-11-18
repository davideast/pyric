import {
  AggregateField,
  aggregateFieldEqual,
  average,
  count,
  FieldPath,
  sum,
} from 'firebase/firestore';
import { describe, expect, test } from 'bun:test';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { probe as avgEmptyProbe } from '../../probes/firestore/firestore-aggregate-average-empty-and-nonnumeric.ts';
import { probe as composeDottedProbe } from '../../probes/firestore/firestore-aggregate-compose-dotted-and-fieldpath.ts';
import { probe as countShapeProbe } from '../../probes/firestore/firestore-getcountfromserver-data-shape.ts';
import { probe as countWhereProbe } from '../../probes/firestore/firestore-getcountfromserver-where-filters.ts';

const AGGREGATE_PROBE_IDS = [
  'firestore-aggregate-average-empty-and-nonnumeric',
  'firestore-aggregate-compose-dotted-and-fieldpath',
  'firestore-getcountfromserver-data-shape',
  'firestore-getcountfromserver-where-filters',
] as const;

function observeSyncAggregateDescriptors() {
  const c = count();
  const sumDotted = sum('metrics.pages');
  const sumPath = sum(new FieldPath('metrics', 'pages'));
  const sumLiteralDot = sum(new FieldPath('metrics.pages'));
  const avgDotted = average('metrics.pages');
  const avgPath = average(new FieldPath('metrics', 'pages'));

  return {
    countIsAggregateField: c instanceof AggregateField,
    countType: c.type,
    countAggregateType: c.aggregateType,
    sumType: sumDotted.type,
    sumAggregateType: sumDotted.aggregateType,
    avgType: avgDotted.type,
    avgAggregateType: avgDotted.aggregateType,
    equalCount: aggregateFieldEqual(count(), count()),
    equalSumStringVsFieldPath: aggregateFieldEqual(sumDotted, sumPath),
    equalAvgStringVsFieldPath: aggregateFieldEqual(avgDotted, avgPath),
    equalSumVsAvgSameField: aggregateFieldEqual(sumDotted, avgDotted),
    equalNestedVsLiteralDot: aggregateFieldEqual(sumDotted, sumLiteralDot),
  };
}

describe('Firestore Aggregates probes (sdk-probes)', () => {
  test('registers all 4 Aggregates probes on sdk-probes linked to firestore#74, #75, #77, #78', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of AGGREGATE_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    const expectedLinks = [
      { probeRecord: countShapeProbe, rowId: 'firestore#74' },
      { probeRecord: countWhereProbe, rowId: 'firestore#75' },
      { probeRecord: composeDottedProbe, rowId: 'firestore#77' },
      { probeRecord: avgEmptyProbe, rowId: 'firestore#78' },
    ];
    for (const { probeRecord, rowId } of expectedLinks) {
      expect(probeRecord.rig).toBe('sdk-probes');
      expect(probeRecord.requires).toEqual(['web-config', 'firestore-rules']);
      expect(probeRecord.pendingRowLink).toBeUndefined();
      expect(probeRecord.matrixRow).toBe(rowId);
      expect(probeRecord.rowIds).toEqual([rowId]);
      expect(probeRecord.description.length).toBeGreaterThan(20);
    }

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );
    for (const id of AGGREGATE_PROBE_IDS) {
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
      lines.some((line) => line.includes('firestore-getcountfromserver-data-shape')),
    ).toBe(true);
  });

  test('observes deterministic AggregateField descriptors and aggregateFieldEqual without network I/O', () => {
    const first = observeSyncAggregateDescriptors();
    const second = observeSyncAggregateDescriptors();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toEqual({
      countIsAggregateField: true,
      countType: 'AggregateField',
      countAggregateType: 'count',
      sumType: 'AggregateField',
      sumAggregateType: 'sum',
      avgType: 'AggregateField',
      avgAggregateType: 'avg',
      equalCount: true,
      equalSumStringVsFieldPath: true,
      equalAvgStringVsFieldPath: true,
      equalSumVsAvgSameField: false,
      equalNestedVsLiteralDot: false,
    });
  });
});
