import { describe, expect, test } from 'bun:test';
import { firebaseSubTabsForProfile, workspaceTabsForProfile } from './workbench-tabs';

describe('Playground workbench layout helpers', () => {
  test('app-builder left tabs keep Preview first', () => {
    expect(workspaceTabsForProfile('app-builder').map((tab) => tab.id)).toEqual([
      'preview',
      'firebase',
      'file',
    ]);
  });

  test('Firebase tooling left tabs make Firebase primary', () => {
    expect(workspaceTabsForProfile('firebase-tooling').map((tab) => tab.id)).toEqual([
      'firebase',
      'file',
      'preview',
    ]);
  });

  test('app-builder Firebase workbench keeps the full subtab set', () => {
    expect(firebaseSubTabsForProfile('app-builder').map((tab) => tab.id)).toEqual([
      'sandbox',
      'data',
      'auth',
      'traffic',
      'seed',
      'ideas',
      'suggestions',
      'deploy',
    ]);
  });

  test('Firebase tooling Firebase workbench hides tertiary app-builder tabs', () => {
    expect(firebaseSubTabsForProfile('firebase-tooling').map((tab) => tab.id)).toEqual([
      'sandbox',
      'data',
      'auth',
      'traffic',
      'seed',
    ]);
  });
});
