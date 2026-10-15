import { describe, expect, it } from 'bun:test';
import { computeCoverageReport } from '../../src/rules-language-coverage.ts';

// Loading the whole conformance graph takes about 3 s on a CI runner and up to 7 s on a slow one.
const FULL_GRAPH_TIMEOUT_MS = 20_000;

describe('rules-language production coverage', () => {
  it('counts rejection-parity identity constructs after their divergence is resolved', async () => {
    const report = await computeCoverageReport();
    const firestore = report.engines.find((engine) => engine.engine === 'firestore');

    expect(firestore?.constructs.find((construct) => construct.id === 'firestore.binding.resource.id')?.verdict).toBe('verified');
    expect(firestore?.constructs.find((construct) => construct.id === 'firestore.binding.resource.__name__')?.verdict).toBe('verified');
    expect(firestore?.verifiedConstructs).toBe(137);
  }, FULL_GRAPH_TIMEOUT_MS);

  it('restores RTDB validate scope only after the ancestor case conforms', async () => {
    const report = await computeCoverageReport();
    const rtdb = report.engines.find((engine) => engine.engine === 'rtdb');

    expect(rtdb?.constructs.find((construct) => construct.id === 'rtdb.semantic.validate-non-cascade')?.verdict).toBe('verified');
    expect(rtdb?.verifiedConstructs).toBe(72);
  }, FULL_GRAPH_TIMEOUT_MS);
});
