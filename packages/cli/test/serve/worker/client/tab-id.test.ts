/**
 * A tab's id: minted once into `sessionStorage`, read back on every later
 * call and after a reload, and absent where there is no `sessionStorage` or
 * it refuses access, so the host names the port instead.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { pageTabId } from '../../../../src/serve/worker/client/tab-id.js';

const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');

function setSessionStorage(value: unknown): void {
  Object.defineProperty(globalThis, 'sessionStorage', { value, configurable: true, writable: true });
}

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
  };
}

afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
  else Reflect.deleteProperty(globalThis, 'sessionStorage');
});

describe("a tab's id", () => {
  it('is minted once and read back after that, as after a reload', () => {
    setSessionStorage(memoryStorage());
    const first = pageTabId();
    expect(first).toMatch(/^tab-[0-9a-f-]{36}$/);
    expect(pageTabId()).toBe(first);
  });

  it('is absent where there is no sessionStorage', () => {
    Reflect.deleteProperty(globalThis, 'sessionStorage');
    expect(pageTabId()).toBeUndefined();
  });

  it('is absent where sessionStorage refuses access', () => {
    setSessionStorage({
      getItem() { throw new Error('SecurityError'); },
      setItem() { throw new Error('SecurityError'); },
    });
    expect(pageTabId()).toBeUndefined();
  });
});
