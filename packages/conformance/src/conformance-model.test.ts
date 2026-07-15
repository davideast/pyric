import { beforeAll, describe, expect, it } from 'bun:test';
import { canIUse, deriveConformanceModel, renderCliQuery, type ConformanceModel, type FeatureSupport } from './conformance-model.ts';

let model: ConformanceModel;
beforeAll(async () => { model = await deriveConformanceModel(); }, 20_000);

function one(query: string): FeatureSupport {
  const result = canIUse(model, query);
  if (Array.isArray(result)) throw new Error(`expected one result for ${query}, got ${result.length}`);
  return result;
}

describe('multi-axis conformance model', () => {
  it('supplies the shared assurance and rules-report projections in memory', () => {
    expect(Object.keys(model.nodeVerdicts)).toHaveLength(1067);
    expect(model.rulesLanguage.capability.engines).toHaveLength(3);
    expect(model.rulesLanguage.coverage.engines).toHaveLength(3);
    expect(model.documentation.registries.length).toBeGreaterThan(0);
    expect(model.documentation.descriptors.length).toBeGreaterThan(0);
  });

  it('reports getAfter as available, diverged, and assurance-ineligible', () => {
    const result = one('getAfter');
    expect(result).toMatchObject({
      surface: 'firestore-rules', availability: 'available', fidelity: 'diverged', assurance: 'ineligible',
    });
    expect(result.claims.map(({ id }) => id)).toEqual(['firestore-rules#164', 'firestore.function.getAfter']);
  });

  it('aggregates every getDownloadURL row and explains its local URL divergence', () => {
    const result = one('getDownloadURL');
    expect(result).toMatchObject({ surface: 'storage', availability: 'available', fidelity: 'diverged', assurance: 'qualified' });
    expect(result.claims.map(({ id }) => id)).toContain('storage#51');
    expect(result.claims.map(({ id }) => id)).toContain('storage#52');
    expect(result.caveats.join(' ')).toContain('page-local');
  });

  it('reports onDisconnect as deferred with non-applicable trust axes', () => {
    expect(one('onDisconnect')).toMatchObject({
      feature: 'onDisconnect', surface: 'rtdb', availability: 'deferred',
      fidelity: 'not-applicable', assurance: 'not-applicable',
    });
  });

  it('returns stable candidates for ambiguous or fuzzy names', () => {
    const first = canIUse(model, 'getDown');
    const second = canIUse(model, 'getDown');
    expect(first).toEqual(second);
    expect(Array.isArray(first)).toBe(true);
    expect((first as FeatureSupport[])[0]?.feature).toBe('getDownloadURL');
  });

  it('does not encode live GitHub issue state in the pure model', () => {
    const source = renderCliQuery(model);
    expect(source).not.toContain('github.com/davideast/pyric/issues/201');
    expect(source).not.toContain('github.com/davideast/pyric/issues/205');
  });
});
