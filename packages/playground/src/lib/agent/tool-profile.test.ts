import { describe, expect, test } from 'bun:test';
import { selectToolProfileForPrompt } from './tool-profile';

const SETTINGS = {
  pyricDiagnosticsEnabled: true,
  strategyMode: 'auto' as const,
};

describe('selectToolProfileForPrompt', () => {
  test('app-builder behavior keeps the existing heuristic', () => {
    expect(
      selectToolProfileForPrompt({
        prompt: 'hello there',
        settings: SETTINGS,
        delegated: false,
      }),
    ).toBe('authoring');
    expect(
      selectToolProfileForPrompt({
        prompt: 'Investigate security rules denials',
        settings: SETTINGS,
        delegated: false,
      }),
    ).toBe('diagnostic');
  });

  test('Firebase tooling sessions prefer diagnostic tools', () => {
    expect(
      selectToolProfileForPrompt({
        prompt: 'Audit my rules',
        settings: SETTINGS,
        delegated: false,
        promptProfile: 'firebase-tooling',
      }),
    ).toBe('diagnostic');
  });

  test('delegated lanes keep the authoring bridge profile', () => {
    expect(
      selectToolProfileForPrompt({
        prompt: 'Audit my rules',
        settings: SETTINGS,
        delegated: true,
        promptProfile: 'firebase-tooling',
      }),
    ).toBe('authoring');
  });
});
