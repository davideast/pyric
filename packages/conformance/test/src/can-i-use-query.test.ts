import { describe, expect, it } from 'bun:test';
import { featureIdentity, normalizeFeature, resolveCanIUse, resolveImportEvidence } from '../../src/can-i-use-query.ts';

const supports = [
  { feature: 'getAfter', surface: 'firestore-rules', importPaths: ['pyric/rules'] },
  { feature: 'getDownloadURL', surface: 'storage', importPaths: ['pyric/storage'] },
  { feature: 'request.query', surface: 'firestore-rules', importPaths: ['pyric/rules'] },
] as const;

describe('canonical can-i-use query runtime', () => {
  it('normalizes display spelling without erasing case-sensitive identity', () => {
    expect(normalizeFeature(' Get-After (rules) ')).toBe('getafter');
    expect(featureIdentity(' get_After ')).toBe('get_After');
  });

  it('resolves exact qualified features and labels fuzzy matches as suggestions', () => {
    expect(resolveCanIUse(supports, 'firestore-rules/request.query')).toMatchObject({
      match: 'exact',
      supports: [{ feature: 'request.query', surface: 'firestore-rules' }],
    });
    expect(resolveCanIUse(supports, 'getAftr')).toMatchObject({
      match: 'suggestions',
      supports: [expect.objectContaining({ feature: 'getAfter' })],
    });
  });

  it('never promotes normalized spelling variants to exact trust answers', () => {
    for (const query of ['getafter', 'GETAFTER', 'get-after', 'get_after', 'get after']) {
      expect(resolveCanIUse(supports, query)).toMatchObject({
        match: 'suggestions',
        supports: [expect.objectContaining({ feature: 'getAfter' })],
      });
    }
  });

  it('scopes generated-document queries to the published import that owns the symbol', () => {
    expect(resolveCanIUse(supports, 'getDownloadURL', { importPath: 'pyric/storage' })).toMatchObject({
      match: 'exact',
      supports: [{ feature: 'getDownloadURL', surface: 'storage' }],
    });
    expect(resolveCanIUse(supports, 'getDownloadURL', { importPath: 'pyric/firestore' })).toEqual({
      query: 'getDownloadURL',
      match: 'none',
      supports: [],
    });
  });

  it('resolves documentation evidence by exact published import', () => {
    const evidence = [{ importPath: 'pyric/storage', evidenceSlug: 'pyric-storage-compat' }] as const;
    expect(resolveImportEvidence(evidence, ' pyric/storage ')).toEqual(evidence[0]);
    expect(resolveImportEvidence(evidence, 'pyric/firestore')).toBeUndefined();
  });
});
