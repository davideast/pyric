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

  test('Firebase expert left tabs make Firebase primary', () => {
    expect(workspaceTabsForProfile('firebase').map((tab) => tab.id)).toEqual([
      'firebase',
      'file',
      'preview',
    ]);
  });

  test('no-preview workspaces omit the Preview tab', () => {
    expect(workspaceTabsForProfile('app-builder', false).map((tab) => tab.id)).toEqual([
      'firebase',
      'file',
    ]);
  });

  test('app-builder Firebase workbench has no production deploy surface', () => {
    expect(firebaseSubTabsForProfile('app-builder').map((tab) => tab.id)).toEqual([
      'sandbox',
      'data',
      'rtdb',
      'auth',
      'traffic',
      'seed',
      'ideas',
      'suggestions',
    ]);
  });

  test('Firebase expert workbench hides tertiary app-builder tabs', () => {
    expect(firebaseSubTabsForProfile('firebase').map((tab) => tab.id)).toEqual([
      'sandbox',
      'data',
      'rtdb',
      'auth',
      'traffic',
      'seed',
    ]);
  });
});
