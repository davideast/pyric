/**
 * Hermetic Window + ServiceWorker global shim for `firebase/messaging` and
 * `firebase/messaging/sw` `sdk-probes` observations.
 *
 * Restores every touched property on `globalThis` in `finally` after flushing
 * pending microtasks so `getMessaging()`'s internal `isSupported().then(...)`
 * background check settles cleanly while the shim is active.
 */

export interface SyncThrowOutcome {
  threw: boolean;
  name: string | null;
  code: string | null;
}

interface SyntheticPushDeliverySpec {
  from: string;
  fcmMessageId: string;
  collapseKey: string;
  data?: Record<string, string>;
}

export interface SyntheticMessagingEnvController {
  setNotificationPermission(permission: 'granted' | 'denied' | 'default'): void;
  dispatchWindowSwMessage(spec: SyntheticPushDeliverySpec): Promise<void>;
  dispatchSwPush(spec: SyntheticPushDeliverySpec): Promise<void>;
  createValidSwRegistration(scope?: string): object;
}

type SavedGlobalSlot = {
  hadOwn: boolean;
  descriptor: PropertyDescriptor | undefined;
};

const TOUCHED_GLOBAL_KEYS = [
  'IDBRequest',
  'IDBTransaction',
  'IDBDatabase',
  'IDBObjectStore',
  'IDBIndex',
  'IDBCursor',
  'indexedDB',
  'ServiceWorkerRegistration',
  'PushSubscription',
  'PushManager',
  'Notification',
  'navigator',
  'window',
  'self',
  'clients',
  'origin',
  'location',
  'registration',
  'addEventListener',
  'document',
] as const;

class SyntheticIDBRequest {
  result: unknown = undefined;
  error: Error | null = null;
  onsuccess: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
  onerror: (() => void) | null = null;

  addEventListener(type: string, listener: () => void): void {
    if (type === 'success') {
      this.onsuccess = listener;
    } else if (type === 'error') {
      this.onerror = listener;
    } else if (type === 'upgradeneeded') {
      this.onupgradeneeded = listener;
    }
  }

  removeEventListener(): void {}
}

class SyntheticIDBObjectStore {
  readonly storeName: string;

  constructor(storeName: string) {
    this.storeName = storeName;
  }

  get(): SyntheticIDBRequest {
    const req = new SyntheticIDBRequest();
    if (this.storeName === 'firebase-installations-store') {
      req.result = {
        fid: 'cSyntheticFid0000000001',
        registrationStatus: 2,
        refreshToken: 'synthetic-refresh-token',
        authToken: {
          requestStatus: 2,
          token: 'synthetic-auth-token',
          creationTime: Date.now(),
          expiresIn: 604_800_000,
        },
      };
    }
    queueMicrotask(() => {
      if (req.onsuccess !== null) {
        req.onsuccess();
      }
    });
    return req;
  }

  put(value: unknown): SyntheticIDBRequest {
    const req = new SyntheticIDBRequest();
    req.result = value;
    queueMicrotask(() => {
      if (req.onsuccess !== null) {
        req.onsuccess();
      }
    });
    return req;
  }

  delete(): SyntheticIDBRequest {
    const req = new SyntheticIDBRequest();
    queueMicrotask(() => {
      if (req.onsuccess !== null) {
        req.onsuccess();
      }
    });
    return req;
  }
}

class SyntheticIDBTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: Error | null = null;

  addEventListener(type: string, listener: () => void): void {
    if (type === 'complete') {
      this.oncomplete = listener;
      queueMicrotask(() => {
        listener();
      });
    }
  }

  removeEventListener(): void {}

  objectStore(name: string): SyntheticIDBObjectStore {
    return new SyntheticIDBObjectStore(name);
  }
}

class SyntheticIDBDatabase {
  objectStoreNames = {
    contains(): boolean {
      return true;
    },
  };

  addEventListener(): void {}
  removeEventListener(): void {}
  createObjectStore(name: string): SyntheticIDBObjectStore {
    return new SyntheticIDBObjectStore(name);
  }
  transaction(storeNames: string | string[]): SyntheticIDBTransaction {
    void storeNames;
    return new SyntheticIDBTransaction();
  }
  close(): void {}
}

class SyntheticServiceWorkerRegistration {
  readonly scope: string;
  readonly active = { state: 'activated' as const };
  readonly pushManager = {
    async getSubscription(): Promise<null> {
      return null;
    },
  };

  constructor(scope = '/firebase-cloud-messaging-push-scope') {
    this.scope = scope;
  }

  async update(): Promise<void> {}
}

Object.defineProperty(SyntheticServiceWorkerRegistration.prototype, 'showNotification', {
  value: async function showNotification(): Promise<void> {},
  configurable: true,
  writable: true,
});

class SyntheticPushSubscription {}

Object.defineProperty(SyntheticPushSubscription.prototype, 'getKey', {
  value: function getKey(): ArrayBuffer {
    return new ArrayBuffer(0);
  },
  configurable: true,
  writable: true,
});

export function captureSyncThrow(operation: () => unknown): SyncThrowOutcome {
  try {
    operation();
    return { threw: false, name: null, code: null };
  } catch (error) {
    return extractErrorOutcome(error);
  }
}

export async function captureAsyncReject(
  operation: () => Promise<unknown>,
): Promise<SyncThrowOutcome> {
  try {
    await operation();
    return { threw: false, name: null, code: null };
  } catch (error) {
    return extractErrorOutcome(error);
  }
}

function extractErrorOutcome(error: unknown): SyncThrowOutcome {
  const shaped = error as { name?: unknown; code?: unknown } | null;
  let name: string | null = null;
  let code: string | null = null;
  if (shaped !== null && typeof shaped === 'object') {
    if (typeof shaped.name === 'string') {
      name = shaped.name;
    }
    if (typeof shaped.code === 'string') {
      code = shaped.code;
    }
  }
  return { threw: true, name, code };
}

export async function withSyntheticMessagingBrowserEnv<T>(
  run: (controller: SyntheticMessagingEnvController) => Promise<T>,
): Promise<T> {
  const target = globalThis as Record<string, unknown>;
  const saved = new Map<string, SavedGlobalSlot>();
  for (const key of TOUCHED_GLOBAL_KEYS) {
    saved.set(key, {
      hadOwn: Object.prototype.hasOwnProperty.call(target, key),
      descriptor: Object.getOwnPropertyDescriptor(target, key),
    });
  }

  type WindowMessageListener = (event: { data: unknown }) => unknown;
  type SwPushListener = (event: {
    data: { json: () => unknown };
    waitUntil: (promise: Promise<unknown>) => void;
  }) => void;

  const swMessageListeners: WindowMessageListener[] = [];
  const swPushListeners: SwPushListener[] = [];
  let notificationPermission: 'granted' | 'denied' | 'default' = 'granted';

  const notificationCtor = Object.assign(function Notification(): void {}, {
    maxActions: 2,
    requestPermission: async () => notificationPermission,
  });
  Object.defineProperty(notificationCtor, 'permission', {
    get: () => notificationPermission,
    configurable: true,
  });

  const indexedDbShim = {
    open(): SyntheticIDBRequest {
      const req = new SyntheticIDBRequest();
      req.result = new SyntheticIDBDatabase();
      queueMicrotask(() => {
        if (req.onsuccess !== null) {
          req.onsuccess();
        }
      });
      return req;
    },
    deleteDatabase(): SyntheticIDBRequest {
      const req = new SyntheticIDBRequest();
      queueMicrotask(() => {
        if (req.onsuccess !== null) {
          req.onsuccess();
        }
      });
      return req;
    },
    async databases(): Promise<Array<{ name: string }>> {
      return [];
    },
  };

  const setGlobal = (key: string, value: unknown): void => {
    Object.defineProperty(target, key, {
      value,
      configurable: true,
      writable: true,
    });
  };

  try {
    delete target.document;
    setGlobal('IDBRequest', SyntheticIDBRequest);
    setGlobal('IDBTransaction', SyntheticIDBTransaction);
    setGlobal('IDBDatabase', SyntheticIDBDatabase);
    setGlobal('IDBObjectStore', SyntheticIDBObjectStore);
    setGlobal('IDBIndex', function IDBIndex(): void {});
    setGlobal('IDBCursor', function IDBCursor(): void {});
    setGlobal('indexedDB', indexedDbShim);
    setGlobal('ServiceWorkerRegistration', SyntheticServiceWorkerRegistration);
    setGlobal('PushSubscription', SyntheticPushSubscription);
    setGlobal('PushManager', function PushManager(): void {});
    setGlobal('Notification', notificationCtor);
    setGlobal('navigator', {
      cookieEnabled: true,
      serviceWorker: {
        addEventListener(type: string, listener: WindowMessageListener): void {
          if (type === 'message') {
            swMessageListeners.push(listener);
          }
        },
        removeEventListener(): void {},
        async register(): Promise<never> {
          throw new Error('synthetic default SW registration unavailable');
        },
      },
    });
    setGlobal('window', target);
    setGlobal('self', target);
    setGlobal('clients', {
      async matchAll(): Promise<unknown[]> {
        return [];
      },
    });
    setGlobal('origin', 'https://example.test');
    setGlobal('location', {
      href: 'https://example.test/',
      origin: 'https://example.test',
      host: 'example.test',
    });
    setGlobal('registration', new SyntheticServiceWorkerRegistration());
    setGlobal('addEventListener', (type: string, listener: SwPushListener): void => {
      if (type === 'push') {
        swPushListeners.push(listener);
      }
    });

    const controller: SyntheticMessagingEnvController = {
      setNotificationPermission(permission): void {
        notificationPermission = permission;
      },
      async dispatchWindowSwMessage(spec): Promise<void> {
        const internalPayload: Record<string, unknown> = {
          isFirebaseMessaging: true,
          messageType: 'push-received',
          from: spec.from,
          fcmMessageId: spec.fcmMessageId,
          collapse_key: spec.collapseKey,
        };
        if (spec.data !== undefined) {
          internalPayload.data = spec.data;
        }
        for (const listener of swMessageListeners) {
          await listener({ data: internalPayload });
        }
      },
      async dispatchSwPush(spec): Promise<void> {
        const internalPayload: Record<string, unknown> = {
          from: spec.from,
          fcmMessageId: spec.fcmMessageId,
          collapse_key: spec.collapseKey,
        };
        if (spec.data !== undefined) {
          internalPayload.data = spec.data;
        }
        const pending: Promise<unknown>[] = [];
        for (const listener of swPushListeners) {
          listener({
            data: { json: () => internalPayload },
            waitUntil: (promise) => {
              pending.push(promise);
            },
          });
        }
        await Promise.all(pending);
      },
      createValidSwRegistration(scope = '/custom-sw-scope'): object {
        return new SyntheticServiceWorkerRegistration(scope);
      },
    };

    const result = await run(controller);
    await new Promise((resolve) => setTimeout(resolve, 15));
    return result;
  } finally {
    for (const key of TOUCHED_GLOBAL_KEYS) {
      const slot = saved.get(key);
      if (slot !== undefined && slot.hadOwn && slot.descriptor !== undefined) {
        Object.defineProperty(target, key, slot.descriptor);
      } else {
        delete target[key];
      }
    }
  }
}
