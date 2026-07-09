/**
 * BYOK slot storage — specifically the session-backed variant added for
 * OpenRouter's OAuth flow: `setKey({ backend })`, `getKey()` precedence
 * between the two backends, `hasSessionKey()`, and `promoteToLocal()`
 * ("remember on this device"). Manual-paste (`localStorage`-only)
 * behavior is covered implicitly — `backend` defaults to `'local'`, so
 * every existing call site (`slot.setKey(value)`) is unaffected.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

// bun test has no DOM. Shim `window.localStorage` + `window.sessionStorage`
// as independent in-memory maps, mirroring the convention in
// `sandbox-headless.test.ts`.
interface MemStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  clear(): void;
  key(): null;
  readonly length: number;
}

function memStorage(): MemStorage {
  const store = new Map<string, string>();
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  };
}

interface WindowShim {
  localStorage: MemStorage;
  sessionStorage: MemStorage;
}

if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
  (globalThis as unknown as { window?: WindowShim }).window = {
    localStorage: memStorage(),
    sessionStorage: memStorage(),
  };
}
const win = (globalThis as unknown as { window: WindowShim }).window;
if (!win.localStorage) win.localStorage = memStorage();
if (!win.sessionStorage) win.sessionStorage = memStorage();

import { openrouterByok } from './byok';

function reset() {
  win.localStorage.clear();
  win.sessionStorage.clear();
}

describe('apiKey slot — backend selection', () => {
  beforeEach(reset);

  test('setKey defaults to localStorage (manual paste, unchanged behavior)', () => {
    openrouterByok.setKey('sk-or-v1-manual');
    expect(win.localStorage.getItem('pyric.playground.byok.openrouter')).toBe(
      'sk-or-v1-manual',
    );
    expect(win.sessionStorage.getItem('pyric.playground.byok.openrouter')).toBeNull();
  });

  test('setKey({ backend: "session" }) writes to sessionStorage only', () => {
    openrouterByok.setKey('sk-or-v1-oauth', { backend: 'session' });
    expect(win.sessionStorage.getItem('pyric.playground.byok.openrouter')).toBe(
      'sk-or-v1-oauth',
    );
    expect(win.localStorage.getItem('pyric.playground.byok.openrouter')).toBeNull();
  });
});

describe('apiKey slot — read precedence + hasKey/hasSessionKey', () => {
  beforeEach(reset);

  test('absent everywhere: hasKey/hasSessionKey false, getKey null', () => {
    expect(openrouterByok.hasKey()).toBe(false);
    expect(openrouterByok.hasSessionKey()).toBe(false);
    expect(openrouterByok.getKey()).toBeNull();
  });

  test('local only: getKey returns it, hasSessionKey stays false', () => {
    openrouterByok.setKey('sk-local');
    expect(openrouterByok.hasKey()).toBe(true);
    expect(openrouterByok.hasSessionKey()).toBe(false);
    expect(openrouterByok.getKey()).toBe('sk-local');
  });

  test('session only: getKey returns it, hasSessionKey true', () => {
    openrouterByok.setKey('sk-session', { backend: 'session' });
    expect(openrouterByok.hasKey()).toBe(true);
    expect(openrouterByok.hasSessionKey()).toBe(true);
    expect(openrouterByok.getKey()).toBe('sk-session');
  });

  test('both set: session wins (fresher OAuth key over a stale pasted one)', () => {
    openrouterByok.setKey('sk-local-stale');
    openrouterByok.setKey('sk-session-fresh', { backend: 'session' });
    expect(openrouterByok.getKey()).toBe('sk-session-fresh');
    expect(openrouterByok.hasSessionKey()).toBe(true);
  });
});

describe('apiKey slot — promoteToLocal ("remember on this device")', () => {
  beforeEach(reset);

  test('moves the session key to localStorage and clears the session copy', () => {
    openrouterByok.setKey('sk-session', { backend: 'session' });
    openrouterByok.promoteToLocal();
    expect(win.localStorage.getItem('pyric.playground.byok.openrouter')).toBe('sk-session');
    expect(win.sessionStorage.getItem('pyric.playground.byok.openrouter')).toBeNull();
    expect(openrouterByok.hasSessionKey()).toBe(false);
    expect(openrouterByok.getKey()).toBe('sk-session');
  });

  test('is a no-op when there is no session key', () => {
    openrouterByok.setKey('sk-local-only');
    openrouterByok.promoteToLocal();
    expect(win.localStorage.getItem('pyric.playground.byok.openrouter')).toBe(
      'sk-local-only',
    );
  });
});

describe('apiKey slot — clearKey removes both backends', () => {
  beforeEach(reset);

  test('clearKey wipes local and session copies', () => {
    openrouterByok.setKey('sk-local');
    openrouterByok.setKey('sk-session', { backend: 'session' });
    openrouterByok.clearKey();
    expect(openrouterByok.hasKey()).toBe(false);
    expect(openrouterByok.getKey()).toBeNull();
  });
});
