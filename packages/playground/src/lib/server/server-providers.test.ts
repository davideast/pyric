/**
 * Asserts the server relay provider policy (#760 / #766): a
 * user-base-URL provider (`ollama` / `llamaServer`) must never be
 * registered server-side. This tests the shared source of truth that
 * `relay.ts` builds its map from and asserts against at module init —
 * imported directly here (no service account needed).
 */
import { describe, test, expect } from 'bun:test';
import {
  assertNoUserBaseUrlProvider,
  isUserBaseUrlProvider,
  USER_BASE_URL_PROVIDERS,
} from './server-providers';

describe('server provider policy', () => {
  test('ollama + llamaServer are user-base-URL providers', () => {
    expect(isUserBaseUrlProvider('ollama')).toBe(true);
    expect(isUserBaseUrlProvider('llamaServer')).toBe(true);
    expect(USER_BASE_URL_PROVIDERS.has('ollama')).toBe(true);
  });

  test('fixed-endpoint cloud providers are allowed', () => {
    expect(isUserBaseUrlProvider('gemini')).toBe(false);
    expect(isUserBaseUrlProvider('openrouter')).toBe(false);
  });

  test('the SERVER relay provider set (gemini + openrouter) passes the guard', () => {
    expect(() => assertNoUserBaseUrlProvider(['gemini', 'openrouter'])).not.toThrow();
  });

  test('registering ollama server-side throws', () => {
    expect(() => assertNoUserBaseUrlProvider(['gemini', 'ollama'])).toThrow(/ollama/);
    expect(() => assertNoUserBaseUrlProvider(['llamaServer'])).toThrow(/llamaServer/);
  });
});
