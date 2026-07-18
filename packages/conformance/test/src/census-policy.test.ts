import { describe, expect, it } from 'bun:test';
import { censusGapProblems, censusIntegrityProblems } from '../../src/census-policy.ts';
import type { ConformanceModel } from '../../src/conformance-model.ts';

describe('census policy', () => {
  it('fails closed when the live census contains a gap absent from the accepted ratchet', () => {
    const problems = censusGapProblems([{
      surface: 'app',
      runtime: { unmapped: ['newRuntimeExport'] },
      types: { unmapped: ['knownTypeGap', 'newTypeExport'] },
    } as ConformanceModel['census'][number]], {
      runtime: { app: ['newRuntimeExport'] },
      types: { app: ['knownTypeGap'] },
    });
    expect(problems).toEqual([
      'app runtime: newRuntimeExport',
      'app types: newTypeExport',
    ]);
  });

  it('reports stale and redundant dispositions as fatal model problems', () => {
    const problems = censusIntegrityProblems([{
      surface: 'app',
      runtime: {
        staleDispositions: ['removed'],
        redundantDispositions: ['nowMapped'],
        stalePrivateUpstream: ['removedPrivate'],
      },
    } as ConformanceModel['census'][number]]);
    expect(problems).toEqual([
      'app runtime: stale dispositions: removed',
      'app runtime: redundant dispositions: nowMapped',
      'app runtime: stale private classifications: removedPrivate',
    ]);
  });
});
