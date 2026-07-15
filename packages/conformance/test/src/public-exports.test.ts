import { describe, expect, it } from 'bun:test';
import { isPublicExportName, publicTypeExportNames, resolvePublicTypeEntry } from '../../src/public-exports.ts';
import { workspaceEntryPaths } from '../../src/workspace-entry.ts';

describe('Firebase public export classification', () => {
  it('classifies leading-underscore type exports as private by rule', () => {
    expect(isPublicExportName('_apps')).toBe(false);
    expect(isPublicExportName('_isFirebaseServerApp')).toBe(false);
    expect(isPublicExportName('initializeApp')).toBe(true);
    expect(isPublicExportName('initializeServerApp')).toBe(true);
  });

  it('keeps deprecated public exports public', () => {
    expect(isPublicExportName('fetchSignInMethodsForEmail')).toBe(true);
  });

  it('reads public type exports through package declaration barrels', () => {
    const appTypes = publicTypeExportNames(['firebase/app']);
    expect(appTypes).toContain('FirebaseApp');
    expect(appTypes).toContain('FirebaseServerApp');
    expect(appTypes.every(isPublicExportName)).toBe(true);
  });

  it('resolves aliased mirror type exports', () => {
    const appTypes = publicTypeExportNames(['pyric/app']);
    expect(appTypes).toContain('FirebaseApp');
    expect(appTypes).toContain('FirebaseOptions');
  });

  it('resolves workspace type census entries from source before generated declarations', () => {
    const entry = workspaceEntryPaths('pyric/storage');
    expect(entry).not.toBeNull();
    if (!entry) throw new Error('expected pyric/storage workspace entry');
    expect(resolvePublicTypeEntry('pyric/storage')).toBe(entry.source);
    expect(resolvePublicTypeEntry('pyric/storage')).not.toBe(entry.built.replace(/\.js$/, '.d.ts'));
  });

  it('resolves transitive workspace type aliases without generated declarations', () => {
    const firestoreTypes = publicTypeExportNames(['pyric/firestore']);
    expect(firestoreTypes).toEqual(expect.arrayContaining([
      'DocumentData',
      'FieldValue',
      'Timestamp',
      'WhereFilterOp',
    ]));
  });
});
