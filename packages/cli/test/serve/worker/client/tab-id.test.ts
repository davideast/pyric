/**
 * A tab's id: minted once into `sessionStorage` and read back on every later
 * call and after a reload. Where there is no `sessionStorage`, or it refuses
 * access, the id is minted once in memory, so every port of the tab still
 * sends the same one.
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

  it('is one id kept in memory where there is no sessionStorage', () => {
    Reflect.deleteProperty(globalThis, 'sessionStorage');
    const first = pageTabId();
    expect(first).toMatch(/^tab-[0-9a-f-]{36}$/);
    expect(pageTabId()).toBe(first);
  });

  it('is the same in-memory id where sessionStorage refuses access', () => {
    Reflect.deleteProperty(globalThis, 'sessionStorage');
    const inMemory = pageTabId();
    setSessionStorage({
      getItem() { throw new Error('SecurityError'); },
      setItem() { throw new Error('SecurityError'); },
    });
    expect(pageTabId()).toBe(inMemory);
    expect(pageTabId()).toBe(inMemory);
  });
});
