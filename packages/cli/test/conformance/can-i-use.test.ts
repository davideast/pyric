import { describe, expect, it } from 'bun:test';
import * as conformance from '../../src/conformance/index.js';
import { canIUse, canIUseImport, type FeatureSupport } from '../../src/conformance/index.js';

function one(query: string): FeatureSupport {
  const result = canIUse(query);
  if (result.match !== 'exact' || result.supports.length !== 1) throw new Error(`expected one exact result for ${query}`);
  return result.supports[0]!;
}

describe('packaged conformance query', () => {
  it('keeps generated tables and MCP machinery behind the two-function facade', () => {
    expect(Object.keys(conformance).sort()).toEqual(['canIUse', 'canIUseImport']);
  });

  it('preserves the three trust axes in the generated Node projection', () => {
    expect(one('getAfter')).toMatchObject({
      availability: 'available',
      fidelity: 'diverged',
      assurance: 'ineligible',
    });
    expect(one('onDisconnect')).toMatchObject({
      availability: 'deferred',
      fidelity: 'not-applicable',
      assurance: 'not-applicable',
    });
  });

  it('fails closed when the programmatic query has no feature identity', () => {
    for (const query of ['', ' ', 'firestore-rules/']) {
      expect(canIUse(query)).toEqual({ query, match: 'none', supports: [] });
    }
  });

  it('lets documentation consumers scope symbols by published import path', () => {
    expect(canIUse('getDownloadURL', { importPath: 'pyric/storage' })).toMatchObject({
      match: 'exact',
      supports: [expect.objectContaining({
        importPaths: ['pyric/storage'],
        evidenceSlug: 'pyric-storage-compat',
      })],
    });
    expect(canIUse('getDownloadURL', { importPath: 'pyric/firestore' }).match).toBe('none');
    for (const importPath of ['', ' pyric/storage ', 'PYRIC/STORAGE', 'pyric_storage']) {
      expect(canIUse('getDownloadURL', { importPath }).match).toBe('none');
    }
    const appGetAuth = canIUse('getAuth', { importPath: 'pyric/app' });
    expect(appGetAuth.match).not.toBe('exact');
    expect(appGetAuth.supports.map(({ feature }) => feature)).not.toContain('getAuth');
  });

  it('scopes native package exports without treating rules constructs as exports', () => {
    expect(canIUse('evaluateStorageRules', { importPath: 'pyric/storage' })).toMatchObject({
      match: 'exact',
      supports: [expect.objectContaining({
        feature: 'evaluateStorageRules',
        surface: 'storage-rules',
      })],
    });
    expect(canIUse('getAfter', { importPath: 'pyric/rules' }).match).toBe('none');
  });

  it('gives docs generators one canonical import-to-evidence lookup', () => {
    expect(canIUseImport('pyric/rules')).toEqual({
      importPath: 'pyric/rules',
      surface: 'firestore-rules',
      evidenceSlug: 'pyric-rules-compat',
    });
    expect(canIUseImport(' pyric/rules ')).toBeUndefined();
    expect(canIUseImport('pyric/unknown')).toBeUndefined();
  });
});
