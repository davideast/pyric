/**
 * A browser profile's client id: minted once into `localStorage` and read back
 * by every later call, so every tab of the profile declares the same one.
 * Where there is no `localStorage`, or it refuses access, the id is minted
 * once per realm in memory. It is a random label: nothing the page holds (a
 * uid, a token) ever becomes the id.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { profileClientId } from '../../../../src/serve/worker/client/client-id.js';
import { messagingAppConfig } from '../../../../src/serve/entries/messaging-sw-client.js';
import { SERVICE_WORKER_TAB_ID } from '../../../../src/serve/worker/host/caller.js';

const CLIENT_ID_MODULE = '../../../../src/serve/worker/client/client-id.js';
const MINTED = /^profile-[0-9a-f]{32}$/;
const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

type MemoryStorage = Pick<Storage, 'getItem' | 'setItem'> & { entries: Map<string, string> };

function memoryStorage(seed: Record<string, string> = {}): MemoryStorage {
  const entries = new Map(Object.entries(seed));
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
  };
}

function setLocalStorage(value: unknown): void {
  Object.defineProperty(globalThis, 'localStorage', { value, configurable: true, writable: true });
}

/** A fresh copy of the module, as a new realm (another service worker, a reloaded worker) loads it. */
async function freshRealm(name: string): Promise<() => string> {
  const loaded = await import(`${CLIENT_ID_MODULE}?realm=${name}`) as { profileClientId: () => string };
  return loaded.profileClientId;
}

function inServiceWorkerRealm<T>(run: () => T): T {
  const scope = globalThis as { registration?: unknown; clients?: unknown };
  scope.registration = {};
  scope.clients = {};
  try {
    return run();
  } finally {
    delete scope.registration;
    delete scope.clients;
  }
}

afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

describe("a browser profile's client id", () => {
  it('is minted once into localStorage and read back by every later call', () => {
    const storage = memoryStorage();
    setLocalStorage(storage);
    const first = profileClientId();
    expect(first).toMatch(MINTED);
    expect(profileClientId()).toBe(first);
    expect([...storage.entries.values()]).toEqual([first]);
  });

  it('is the same for a second tab of the profile, which reads the same localStorage', async () => {
    const storage = memoryStorage();
    setLocalStorage(storage);
    const firstTab = await freshRealm('tab-1');
    const secondTab = await freshRealm('tab-2');
    expect(secondTab()).toBe(firstTab());
  });

  it('differs for another profile, whose localStorage is its own', async () => {
    setLocalStorage(memoryStorage());
    const first = (await freshRealm('profile-a'))();
    setLocalStorage(memoryStorage());
    expect((await freshRealm('profile-b'))()).not.toBe(first);
  });

  it('stays the same after the app clears localStorage, and is written back for later tabs', async () => {
    const storage = memoryStorage();
    setLocalStorage(storage);
    const realm = await freshRealm('cleared');
    const first = realm();
    storage.entries.clear();
    expect(realm()).toBe(first);
    expect([...storage.entries.values()]).toEqual([first]);
    expect((await freshRealm('cleared-later-tab'))()).toBe(first);
  });

  it("keeps the realm's id when another tab mints its own at the same moment", async () => {
    const storage = memoryStorage();
    setLocalStorage(storage);
    const realm = await freshRealm('raced');
    const first = realm();
    const otherTab = `profile-${'0'.repeat(32)}`;
    storage.entries.set('pyric.profileClientId', otherTab);
    expect(realm()).toBe(first);
    expect(storage.entries.get('pyric.profileClientId')).toBe(otherTab);
  });

  it('is one id per realm where there is no localStorage, and a fresh one in a new realm', async () => {
    Reflect.deleteProperty(globalThis, 'localStorage');
    const realmA = await freshRealm('a');
    const realmB = await freshRealm('b');
    const first = realmA();
    expect(first).toMatch(MINTED);
    expect(realmA()).toBe(first);
    expect(realmB()).toMatch(MINTED);
    expect(realmB()).not.toBe(first);
  });

  it('is the realm id where localStorage refuses access', async () => {
    const realm = await freshRealm('refused');
    Reflect.deleteProperty(globalThis, 'localStorage');
    const inMemory = realm();
    setLocalStorage({
      getItem() { throw new Error('SecurityError'); },
      setItem() { throw new Error('SecurityError'); },
    });
    expect(realm()).toBe(inMemory);
  });

  it('never comes from a uid or a token the page holds', async () => {
    const uid = 'user-uid-1234567890';
    const token = 'eyJhbGciOiJSUzI1NiJ9.payload.signature';
    const authUser = JSON.stringify({ uid, stsTokenManager: { accessToken: token, refreshToken: 'refresh-abc' } });
    // The key holds a uid, as a page or an older build could have written it.
    const storage = memoryStorage({
      'firebase:authUser:key:[DEFAULT]': authUser,
      'pyric.profileClientId': uid,
    });
    setLocalStorage(storage);
    const realm = await freshRealm('signed-in');
    const id = realm();
    expect(id).toMatch(MINTED);
    for (const held of [uid, token, 'refresh-abc']) expect(id).not.toContain(held);
    storage.entries.set('pyric.profileClientId', token);
    expect(realm()).toBe(id);
    expect(storage.entries.get('pyric.profileClientId')).toBe(id);
  });
});

describe("Messaging's appConfig", () => {
  it("declares the page's profile client id", () => {
    setLocalStorage(memoryStorage());
    const hello = messagingAppConfig({ projectId: 'demo-app' });
    expect(hello.clientId).toBe(profileClientId());
  });

  it("declares the service worker's realm id, since it has no localStorage", () => {
    Reflect.deleteProperty(globalThis, 'localStorage');
    const hello = inServiceWorkerRealm(() => messagingAppConfig({ projectId: 'demo-app' }));
    expect(hello.tabId).toBe(SERVICE_WORKER_TAB_ID);
    expect(hello.clientId).toMatch(MINTED);
    expect(hello.clientId).toBe(profileClientId());
  });
});
