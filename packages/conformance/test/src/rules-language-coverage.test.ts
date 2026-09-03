import { describe, expect, it } from 'bun:test';
import { computeCoverageReport } from '../../src/rules-language-coverage.ts';

describe('rules-language production coverage', () => {
  it('counts rejection-parity identity constructs after their divergence is resolved', async () => {
    const report = await computeCoverageReport();
    const firestore = report.engines.find((engine) => engine.engine === 'firestore');

    expect(firestore?.constructs.find((construct) => construct.id === 'firestore.binding.resource.id')?.verdict).toBe('verified');
    expect(firestore?.constructs.find((construct) => construct.id === 'firestore.binding.resource.__name__')?.verdict).toBe('verified');
    expect(firestore?.verifiedConstructs).toBe(137);
  });

  it('restores RTDB validate scope only after the ancestor case conforms', async () => {
    const report = await computeCoverageReport();
    const rtdb = report.engines.find((engine) => engine.engine === 'rtdb');

    expect(rtdb?.constructs.find((construct) => construct.id === 'rtdb.semantic.validate-non-cascade')?.verdict).toBe('verified');
    expect(rtdb?.verifiedConstructs).toBe(53);
  });
});
