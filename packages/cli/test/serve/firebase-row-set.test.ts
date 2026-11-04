import { describe, expect, test } from 'bun:test';
import { SDK_MODULES, swappedFirebaseEntries, type FirebaseRowSet } from '../../src/serve/firebase-module-swap.js';

describe('a row set supplied to the Firebase module swap', () => {
  const supplied: FirebaseRowSet = new Map([
    ['firebase/app', 'supplied-app'],
    ['firebase/firestore', 'supplied-firestore'],
  ]);

  test('replaces the rows it names and keeps every other row of the mode', () => {
    const sandbox = swappedFirebaseEntries('sandbox');
    const withRows = swappedFirebaseEntries('sandbox', supplied);
    expect(withRows.get('firebase/app')).toBe('supplied-app');
    expect(withRows.get('firebase/firestore')).toBe('supplied-firestore');
    for (const specifier of SDK_MODULES) {
      const isSupplied = supplied.has(specifier);
      if (!isSupplied) expect(withRows.get(specifier)).toBe(sandbox.get(specifier));
    }
  });

  test('applies after the production AI rows', () => {
    const withRows = swappedFirebaseEntries('production', supplied);
    expect(withRows.get('firebase/app')).toBe('supplied-app');
    expect(withRows.get('firebase/app-check')).toBe('app-ai-passthrough-app-check');
    expect(withRows.has('firebase/ai')).toBe(false);
  });

  test('leaves the table unchanged when no rows are supplied', () => {
    expect([...swappedFirebaseEntries('sandbox', new Map())]).toEqual([...swappedFirebaseEntries('sandbox')]);
  });
});
