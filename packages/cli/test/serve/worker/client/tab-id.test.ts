/**
 * A tab's id: minted once into `sessionStorage` and read back on every later
 * call and after a reload. Where there is no `sessionStorage`, or it refuses
 * access, the id is minted once in memory, so every port of the tab still
 * sends the same one.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { pageTabId } from '../../../../src/serve/worker/client/tab-id.js';

const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalAddListener = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener');

function setCrypto(value: unknown): void {
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true });
}

function setSessionStorage(value: unknown): void {
  Object.defineProperty(globalThis, 'sessionStorage', { value, configurable: true, writable: true });
}

function setBrowserRealm(doc: object | undefined, addEventListener?: unknown): void {
  if (doc === undefined) Reflect.deleteProperty(globalThis, 'document');
  else Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
  if (addEventListener === undefined) Reflect.deleteProperty(globalThis, 'addEventListener');
  else Object.defineProperty(globalThis, 'addEventListener', { value: addEventListener, configurable: true, writable: true });
}

function memoryStorage(seed?: ReadonlyMap<string, string>): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { snapshot(): Map<string, string> } {
  const entries = new Map<string, string>(seed);
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
    removeItem: (key) => { entries.delete(key); },
    snapshot: () => new Map(entries),
  };
}

afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
  else Reflect.deleteProperty(globalThis, 'sessionStorage');
  if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else Reflect.deleteProperty(globalThis, 'document');
  if (originalAddListener) Object.defineProperty(globalThis, 'addEventListener', originalAddListener);
  else Reflect.deleteProperty(globalThis, 'addEventListener');
});

describe("a tab's id", () => {
  // First, so the in-memory id is minted here with no crypto at all.
  it('is minted without crypto and without sessionStorage, and stays the same', () => {
    setCrypto(undefined);
    Reflect.deleteProperty(globalThis, 'sessionStorage');
    const first = pageTabId();
    expect(first).toMatch(/^tab-[0-9a-f]{32}$/);
    expect(pageTabId()).toBe(first);
  });

  it('is minted in an insecure context, where crypto has no randomUUID', () => {
    const { getRandomValues } = globalThis.crypto;
    setCrypto({ getRandomValues: getRandomValues.bind(globalThis.crypto) });
    setSessionStorage(memoryStorage());
    const first = pageTabId();
    expect(first).toMatch(/^tab-[0-9a-f]{32}$/);
    expect(pageTabId()).toBe(first);
  });

  it('is minted into sessionStorage without crypto', () => {
    setCrypto(undefined);
    setSessionStorage(memoryStorage());
    const first = pageTabId();
    expect(first).toMatch(/^tab-[0-9a-f]{32}$/);
    expect(pageTabId()).toBe(first);
  });

  it('is minted once and read back after that, as after a reload', () => {
    setSessionStorage(memoryStorage());
    const first = pageTabId();
    expect(first).toMatch(/^tab-[0-9a-f]{32}$/);
    expect(pageTabId()).toBe(first);
  });

  it('is one id kept in memory where there is no sessionStorage', () => {
    Reflect.deleteProperty(globalThis, 'sessionStorage');
    const first = pageTabId();
    expect(first).toMatch(/^tab-[0-9a-f]{32}$/);
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

  it('preserves tabId across a same-tab reload (pagehide) while minting a fresh tabId on Duplicate Tab', () => {
    const storage1 = memoryStorage();
    const listeners1 = new Map<string, Array<(event: Event) => void>>();
    setSessionStorage(storage1);
    setBrowserRealm({}, (type: string, fn: (event: Event) => void) => {
      const list = listeners1.get(type) ?? [];
      list.push(fn);
      listeners1.set(type, list);
    });

    const originalTabId = pageTabId();
    expect(pageTabId()).toBe(originalTabId);

    // Duplicate Tab while Tab 1 is still open (no pagehide fired): clones sessionStorage.
    const duplicatedStorage = memoryStorage(storage1.snapshot());
    setSessionStorage(duplicatedStorage);
    setBrowserRealm({}, () => undefined);
    const duplicatedTabId = pageTabId();
    expect(duplicatedTabId).toMatch(/^tab-[0-9a-f]{32}$/);
    expect(duplicatedTabId).not.toBe(originalTabId);

    // Same-tab reload on Tab 1: pagehide fires before the new document loads.
    setSessionStorage(storage1);
    for (const fn of listeners1.get('pagehide') ?? []) fn({} as Event);

    const listeners1Reload = new Map<string, Array<(event: Event) => void>>();
    setBrowserRealm({}, (type: string, fn: (event: Event) => void) => {
      const list = listeners1Reload.get(type) ?? [];
      list.push(fn);
      listeners1Reload.set(type, list);
    });
    expect(pageTabId()).toBe(originalTabId);

    // BFCache navigation (pagehide persisted: true) does NOT arm the leaving marker, so another same-tab document will not steal the BFCache document's id:
    for (const fn of listeners1Reload.get('pagehide') ?? []) fn({ persisted: true } as unknown as Event);
    setBrowserRealm({}, () => undefined);
    const bfcacheNextDocId = pageTabId();
    expect(bfcacheNextDocId).not.toBe(originalTabId);

    // Restoring the original document from BFCache (pageshow persisted: true) restores its id in sessionStorage:
    for (const fn of listeners1Reload.get('pageshow') ?? []) fn({ persisted: true } as unknown as Event);
    expect(storage1.getItem('pyric.tabId')).toBe(originalTabId);

    // Child iframes (window !== top) never overwrite the top-level tab's sessionStorage:
    Object.defineProperty(globalThis, 'window', { value: { frame: 1 }, configurable: true });
    Object.defineProperty(globalThis, 'top', { value: { frame: 0 }, configurable: true });
    const iframeId = pageTabId();
    expect(iframeId).not.toBe(originalTabId);
    expect(storage1.getItem('pyric.tabId')).toBe(originalTabId);
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'top');
  });
});
