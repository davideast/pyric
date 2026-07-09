/**
 * Pure parts of the OpenRouter OAuth (PKCE) flow: callback detection,
 * URL cleaning, and the verifier stash lifecycle. The redirect round
 * trip through OpenRouter's authorize page (`beginSignIn` /
 * `completeSignInIfPending`) is NOT covered here — it needs a real
 * browser + network and a human to click through it.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

// bun test has no DOM. Shim just enough `window.sessionStorage` for the
// verifier-stash helpers, mirroring the convention in
// `sandbox-headless.test.ts`.
if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
  (globalThis as { window?: unknown }).window = {};
}
const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
if (!win.sessionStorage) {
  const store = new Map<string, string>();
  win.sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  };
}

import {
  cleanOAuthUrl,
  clearCodeVerifier,
  detectOAuthCode,
  readCodeVerifier,
  stashCodeVerifier,
} from './openrouter-oauth';

describe('detectOAuthCode', () => {
  test('extracts ?code= from a callback URL', () => {
    expect(detectOAuthCode('https://pyric.dev/playground?code=abc123')).toBe('abc123');
  });

  test('extracts code alongside other query params', () => {
    expect(
      detectOAuthCode('https://pyric.dev/playground?session=xyz&code=abc123&foo=bar'),
    ).toBe('abc123');
  });

  test('returns null when no code param is present', () => {
    expect(detectOAuthCode('https://pyric.dev/playground?session=xyz')).toBeNull();
  });

  test('returns null for an empty code value', () => {
    expect(detectOAuthCode('https://pyric.dev/playground?code=')).toBeNull();
  });

  test('returns null for an unparseable URL rather than throwing', () => {
    expect(detectOAuthCode('not a url')).toBeNull();
  });
});

describe('cleanOAuthUrl', () => {
  test('strips code but keeps other query params and the path', () => {
    expect(cleanOAuthUrl('https://pyric.dev/playground?session=xyz&code=abc123')).toBe(
      '/playground?session=xyz',
    );
  });

  test('drops an empty query string entirely when code was the only param', () => {
    expect(cleanOAuthUrl('https://pyric.dev/playground?code=abc123')).toBe('/playground');
  });

  test('preserves the hash', () => {
    expect(cleanOAuthUrl('https://pyric.dev/playground?code=abc123#agent')).toBe(
      '/playground#agent',
    );
  });

  test('is a no-op when there is no code param', () => {
    expect(cleanOAuthUrl('https://pyric.dev/playground?session=xyz')).toBe(
      '/playground?session=xyz',
    );
  });
});

describe('verifier stash lifecycle', () => {
  beforeEach(() => {
    clearCodeVerifier();
  });

  test('starts absent', () => {
    expect(readCodeVerifier()).toBeNull();
  });

  test('stash then read round-trips the verifier', () => {
    stashCodeVerifier('verifier-123');
    expect(readCodeVerifier()).toBe('verifier-123');
  });

  test('clear removes it', () => {
    stashCodeVerifier('verifier-123');
    clearCodeVerifier();
    expect(readCodeVerifier()).toBeNull();
  });

  test('a second stash overwrites the first (one flow in flight at a time)', () => {
    stashCodeVerifier('first');
    stashCodeVerifier('second');
    expect(readCodeVerifier()).toBe('second');
  });
});
