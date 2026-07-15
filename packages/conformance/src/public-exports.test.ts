import { describe, expect, it } from 'bun:test';
import { isPublicExportName, publicTypeExportNames } from './public-exports.ts';

describe('Firebase public export classification', () => {
  it('classifies leading-underscore exports as private by rule', () => {
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
});
