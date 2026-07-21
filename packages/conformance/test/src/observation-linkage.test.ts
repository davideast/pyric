import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { observationLinkageOf, readObservationLinkage } from '../../src/observation-linkage.ts';

describe('observation linkage', () => {
  test('retains only the authored registry linkage fields', () => {
    expect(observationLinkageOf({
      matrixRow: 'storage-rules.lookup-budget',
      rowIds: ['storage-rules#131', 132, null],
      behavior: { ignored: true },
    })).toEqual({
      matrixRow: 'storage-rules.lookup-budget',
      rowIds: ['storage-rules#131'],
    });
  });

  test('starts unlinked when no prior observation exists', () => {
    expect(readObservationLinkage(join(import.meta.dir, '__absent-observation__.json'))).toEqual({
      matrixRow: '',
      rowIds: [],
    });
  });
});
