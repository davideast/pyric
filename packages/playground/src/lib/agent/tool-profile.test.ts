import { describe, expect, test } from 'bun:test';
import { selectToolProfileForPrompt } from './tool-profile';

const SETTINGS = {
  pyricDiagnosticsEnabled: true,
};

describe('selectToolProfileForPrompt', () => {
  test('app-builder behavior keeps the existing heuristic', () => {
    expect(
      selectToolProfileForPrompt({
        prompt: 'hello there',
        settings: SETTINGS,
        promptProfile: 'app-builder',
      }),
    ).toBe('authoring');
    expect(
      selectToolProfileForPrompt({
        prompt: 'Investigate security rules denials',
        settings: SETTINGS,
        promptProfile: 'app-builder',
      }),
    ).toBe('diagnostic');
  });

  test('Firebase expert sessions prefer diagnostic tools', () => {
    expect(
      selectToolProfileForPrompt({
        prompt: 'Audit my rules',
        settings: SETTINGS,
        promptProfile: 'firebase',
      }),
    ).toBe('diagnostic');
  });
});
