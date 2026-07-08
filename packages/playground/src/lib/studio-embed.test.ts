import { describe, expect, test } from 'bun:test';
import {
  isPlaygroundCommandMessage,
  isStudioEmbedSearch,
  normalizePlaygroundBase,
  PLAYGROUND_OPEN_ACCOUNT_MESSAGE,
  PLAYGROUND_OPEN_KEYS_MESSAGE,
  PLAYGROUND_OPEN_SETTINGS_MESSAGE,
  PLAYGROUND_SET_MODEL_MESSAGE,
  playgroundHomeHref,
  playgroundSessionHref,
  readPlaygroundSandboxMode,
  STUDIO_NAVIGATE_SETTINGS_MESSAGE,
} from './studio-embed';

describe('Studio embed contract', () => {
  test('detects only the explicit studio embed mode', () => {
    expect(isStudioEmbedSearch('?embed=studio')).toBe(true);
    expect(isStudioEmbedSearch('?session=s1&embed=studio')).toBe(true);
    expect(isStudioEmbedSearch('?embed=standalone')).toBe(false);
    expect(isStudioEmbedSearch('')).toBe(false);
  });

  test('pins the settings navigation message name', () => {
    expect(STUDIO_NAVIGATE_SETTINGS_MESSAGE).toBe('pyric:studio:navigate-settings');
  });

  test('validates playground command messages from Studio', () => {
    expect(isPlaygroundCommandMessage({ type: PLAYGROUND_OPEN_KEYS_MESSAGE })).toBe(true);
    expect(isPlaygroundCommandMessage({ type: PLAYGROUND_OPEN_SETTINGS_MESSAGE })).toBe(true);
    expect(isPlaygroundCommandMessage({ type: PLAYGROUND_OPEN_ACCOUNT_MESSAGE })).toBe(true);
    expect(
      isPlaygroundCommandMessage({
        type: PLAYGROUND_SET_MODEL_MESSAGE,
        providerId: 'gemini',
        modelId: 'gemini-3.5-flash',
        effort: 'medium',
      }),
    ).toBe(true);
    expect(
      isPlaygroundCommandMessage({
        type: PLAYGROUND_SET_MODEL_MESSAGE,
        providerId: 'anthropic',
        modelId: 'anthropic-model',
      }),
    ).toBe(false);
    expect(isPlaygroundCommandMessage({ type: PLAYGROUND_SET_MODEL_MESSAGE, providerId: 'gemini' })).toBe(
      false,
    );
  });

  test('builds playground home URLs inside the mounted base', () => {
    expect(playgroundHomeHref()).toBe('/');
    expect(playgroundHomeHref({ base: '/__pyric/playground/', embedded: true })).toBe(
      '/__pyric/playground/?embed=studio',
    );
  });

  test('uses sandbox query only as a default hint', () => {
    expect(readPlaygroundSandboxMode('?embed=studio')).toBe('shared');
    expect(readPlaygroundSandboxMode('')).toBe('isolated');
    expect(readPlaygroundSandboxMode('?embed=studio&sandbox=isolated')).toBe('isolated');
    expect(readPlaygroundSandboxMode('?sandbox=shared')).toBe('shared');
  });

  test('builds session URLs without escaping to the hosted app root', () => {
    expect(playgroundSessionHref('s 1')).toBe('/playground?session=s+1');
    expect(playgroundSessionHref('s 1', { base: '/__pyric/playground/', embedded: true })).toBe(
      '/__pyric/playground/playground?session=s+1&embed=studio',
    );
  });

  test('normalizes configured base paths', () => {
    expect(normalizePlaygroundBase('/')).toBe('/');
    expect(normalizePlaygroundBase('/__pyric/playground')).toBe('/__pyric/playground/');
    expect(normalizePlaygroundBase('__pyric/playground')).toBe('/__pyric/playground/');
  });
});
