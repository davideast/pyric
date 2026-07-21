import { describe, expect, test } from 'bun:test';
import { mapFirebaseImport } from './virtual-imports-plugin';

describe('Firebase preview import mapping', () => {
  test('maps every Firebase subpath to the matching Pyric subpath', () => {
    for (const subpath of [
      'app',
      'firestore',
      'auth',
      'database',
      'storage',
      'messaging',
      'messaging/sw',
      'future/module',
    ]) {
      expect(mapFirebaseImport(`firebase/${subpath}`)).toBe(`pyric/${subpath}`);
    }
  });

  test('leaves non-Firebase imports alone', () => {
    expect(mapFirebaseImport('react')).toBeNull();
    expect(mapFirebaseImport('pyric/firestore')).toBeNull();
    expect(mapFirebaseImport('./firebase')).toBeNull();
  });
});
