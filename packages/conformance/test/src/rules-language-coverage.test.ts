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
    expect(firestore?.constructs.find((construct) => construct.id === 'firestore.semantic.type-dispatch')?.verdict).toBe('verified');
    expect(firestore?.verifiedConstructs).toBe(129);
  }, FULL_GRAPH_TIMEOUT_MS);

  it('restores RTDB validate scope only after the ancestor case conforms', async () => {
    const report = await computeCoverageReport();
    const rtdb = report.engines.find((engine) => engine.engine === 'rtdb');

    expect(rtdb?.constructs.find((construct) => construct.id === 'rtdb.semantic.validate-non-cascade')?.verdict).toBe('verified');
    // Every construct conforms now that the 2026-10-26 hunt's findings (#1247,
    // rows rtdb-rules#34 to #39) are fixed.
    expect(rtdb?.verifiedConstructs).toBe(90);
  }, FULL_GRAPH_TIMEOUT_MS);

  it('verifies Storage corpus constructs with input-digest-bound observations and no unresolved AST nodes but its unknown-method probes', async () => {
    const report = await computeCoverageReport();
    const storage = report.engines.find((engine) => engine.engine === 'storage');

    // h1-unknown-method-absorption calls methods that do not exist, so that
    // production can show their errors are absorbed (row storage-rules#211).
    // They name no construct; every other AST node must resolve.
    const unknownMethod = (what: string) => ({
      scenario: 'h1-unknown-method-absorption', what, reason: 'storage: unrecognized method receiver',
    });
    expect(storage?.unresolved).toEqual([
      unknownMethod('method:foo'),
      unknownMethod('method:indexOf'),
      unknownMethod('method:abs'),
      unknownMethod('method:foo'),
    ]);
    expect(storage?.verifiedScenarioCount).toBe(45);
    expect(storage?.verifiedConstructs).toBe(114);
  }, FULL_GRAPH_TIMEOUT_MS);
});
