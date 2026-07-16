import { describe, expect, it } from 'bun:test';
import { normalizeFeature, resolveCanIUse, resolveImportEvidence } from '../../src/can-i-use-query.ts';

const supports = [
  { feature: 'getAfter', surface: 'firestore-rules', importPaths: ['pyric/rules'] },
  { feature: 'getDownloadURL', surface: 'storage', importPaths: ['pyric/storage'] },
  { feature: 'request.query', surface: 'firestore-rules', importPaths: ['pyric/rules'] },
] as const;

describe('canonical can-i-use query runtime', () => {
  it('normalizes discovery spelling without erasing exact identity', () => {
    expect(normalizeFeature(' Get-After (rules) ')).toBe('getafter');
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
    for (const query of [
      'getafter',
      'GETAFTER',
      'get-after',
      'get_after',
      'get after',
      'getAfter(not canonical)',
      'Firestore-Rules/getAfter',
      'firestore_rules/getAfter',
      'firestore-rules:getAfter',
      ' getAfter',
      'getAfter ',
      'firestore-rules/ getAfter',
      'firestore-rules/getAfter ',
    ]) {
      expect(resolveCanIUse(supports, query)).toMatchObject({
        match: 'suggestions',
        supports: [expect.objectContaining({ feature: 'getAfter' })],
      });
    }
    expect(resolveCanIUse([
      ...supports,
      { feature: 'get', surface: 'firestore-rules' },
      { feature: 'get', surface: 'rtdb' },
    ], 'GET')).toMatchObject({ match: 'suggestions' });
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
    expect(resolveCanIUse(supports, 'getDownloadURL', { importPath: '' })).toEqual({
      query: 'getDownloadURL',
      match: 'none',
      supports: [],
    });
  });

  it('fails closed when no feature identity was supplied', () => {
    for (const query of ['', ' ', 'firestore-rules/']) {
      expect(resolveCanIUse(supports, query)).toEqual({ query, match: 'none', supports: [] });
    }
  });

  it('resolves documentation evidence by exact published import', () => {
    const evidence = [{ importPath: 'pyric/storage', evidenceSlug: 'pyric-storage-compat' }] as const;
    expect(resolveImportEvidence(evidence, 'pyric/storage')).toEqual(evidence[0]);
    expect(resolveImportEvidence(evidence, ' pyric/storage ')).toBeUndefined();
    expect(resolveImportEvidence(evidence, 'pyric/firestore')).toBeUndefined();
  });
});
