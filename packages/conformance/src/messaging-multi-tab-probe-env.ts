/**
 * Hermetic multi-tab Window + shared ServiceWorker global shim for
 * `firebase/messaging` and `firebase/messaging/sw` `sdk-probes` observations.
 *
 * Models multiple browser window tabs sharing one origin and one active
 * ServiceWorker GlobalScope (`self.clients.matchAll`, `self.clients.openWindow`,
 * `self.registration.showNotification`, `push`, and `notificationclick`).
 */

export type TabVisibilityState = 'visible' | 'hidden';

export interface MultiTabPushDeliverySpec {
  from: string;
  fcmMessageId: string;
  collapseKey: string;
  data?: Record<string, string>;
  notification?: {
    title?: string;
    body?: string;
    image?: string;
    icon?: string;
  };
  fcmOptions?: {
    link?: string;
    analytics_label?: string;
  };
}

export interface NotificationClickResult {
  notificationClosed: boolean;
  openWindowUrls: string[];
}

export interface SimulatedTabHandle {
  readonly id: string;
  readonly url: string;
  setVisibility(state: TabVisibilityState): void;
  focusCount(): number;
  receivedRawWindowMessages(): ReadonlyArray<Record<string, unknown>>;
  bindWindowContext<T>(run: () => T): T;
}

export interface MultiTabMessagingEnvController {
  createWindowTab(id: string, path?: string, initialVisibility?: TabVisibilityState): SimulatedTabHandle;
  setChromeExtensionVisibleClient(enabled: boolean): void;
  dispatchSwPush(spec: MultiTabPushDeliverySpec): Promise<void>;
  dispatchSwNotificationClick(spec: MultiTabPushDeliverySpec, action?: string): Promise<NotificationClickResult>;
  showNotificationCount(): number;
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

class MultiTabIDBRequest {
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

class MultiTabIDBObjectStore {
  readonly storeName: string;

  constructor(storeName: string) {
    this.storeName = storeName;
  }

  get(): MultiTabIDBRequest {
    const req = new MultiTabIDBRequest();
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

  put(value: unknown): MultiTabIDBRequest {
    const req = new MultiTabIDBRequest();
    req.result = value;
    queueMicrotask(() => {
      if (req.onsuccess !== null) {
        req.onsuccess();
      }
    });
    return req;
  }

  delete(): MultiTabIDBRequest {
    const req = new MultiTabIDBRequest();
    queueMicrotask(() => {
      if (req.onsuccess !== null) {
        req.onsuccess();
      }
    });
    return req;
  }
}

class MultiTabIDBTransaction {
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

  objectStore(name: string): MultiTabIDBObjectStore {
    return new MultiTabIDBObjectStore(name);
  }
}

class MultiTabIDBDatabase {
  objectStoreNames = {
    contains(): boolean {
      return true;
    },
  };

  addEventListener(): void {}
  removeEventListener(): void {}
  createObjectStore(name: string): MultiTabIDBObjectStore {
    return new MultiTabIDBObjectStore(name);
  }
  transaction(storeNames: string | string[]): MultiTabIDBTransaction {
    void storeNames;
    return new MultiTabIDBTransaction();
  }
  close(): void {}
}

class MultiTabServiceWorkerRegistration {
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

class MultiTabPushSubscription {}

Object.defineProperty(MultiTabPushSubscription.prototype, 'getKey', {
  value: function getKey(): ArrayBuffer {
    return new ArrayBuffer(0);
  },
  configurable: true,
  writable: true,
});

type WindowMessageListener = (event: { data: unknown }) => unknown;

interface InternalTabRecord {
  id: string;
  url: string;
  visibilityState: TabVisibilityState;
  focusedCalls: number;
  listeners: WindowMessageListener[];
  rawMessages: Array<Record<string, unknown>>;
}

function buildInternalPushPayload(spec: MultiTabPushDeliverySpec): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    from: spec.from,
    fcmMessageId: spec.fcmMessageId,
    collapse_key: spec.collapseKey,
  };
  if (spec.data !== undefined) {
    payload.data = { ...spec.data };
  }
  if (spec.notification !== undefined) {
    payload.notification = { ...spec.notification };
  }
  if (spec.fcmOptions !== undefined) {
    payload.fcmOptions = { ...spec.fcmOptions };
  }
  return payload;
}

export async function withMultiTabMessagingBrowserEnv<T>(
  run: (controller: MultiTabMessagingEnvController) => Promise<T>,
): Promise<T> {
  const target = globalThis as Record<string, unknown>;
  const saved = new Map<string, SavedGlobalSlot>();
  for (const key of TOUCHED_GLOBAL_KEYS) {
    saved.set(key, {
      hadOwn: Object.prototype.hasOwnProperty.call(target, key),
      descriptor: Object.getOwnPropertyDescriptor(target, key),
    });
  }

  type SwPushListener = (event: {
    data: { json: () => unknown };
    waitUntil: (promise: Promise<unknown>) => void;
  }) => void;
  type SwNotificationClickListener = (event: {
    action: string;
    notification: {
      data: Record<string, unknown>;
      close: () => void;
    };
    stopImmediatePropagation: () => void;
    waitUntil: (promise: Promise<unknown>) => void;
  }) => void;

  const tabs: InternalTabRecord[] = [];
  let activeBindingTab: InternalTabRecord | null = null;
  let includeChromeExtensionVisible = false;
  let showNotifications = 0;

  const swPushListeners: SwPushListener[] = [];
  const swClickListeners: SwNotificationClickListener[] = [];

  Object.defineProperty(MultiTabServiceWorkerRegistration.prototype, 'showNotification', {
    value: async function showNotification(): Promise<void> {
      showNotifications += 1;
    },
    configurable: true,
    writable: true,
  });

  const notificationCtor = Object.assign(function Notification(): void {}, {
    maxActions: 2,
    permission: 'granted' as const,
    requestPermission: async () => 'granted' as const,
  });

  const indexedDbShim = {
    open(): MultiTabIDBRequest {
      const req = new MultiTabIDBRequest();
      req.result = new MultiTabIDBDatabase();
      queueMicrotask(() => {
        if (req.onsuccess !== null) {
          req.onsuccess();
        }
      });
      return req;
    },
    deleteDatabase(): MultiTabIDBRequest {
      const req = new MultiTabIDBRequest();
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

  const openWindowCalls: string[] = [];

  const buildWindowClientForTab = (tab: InternalTabRecord) => {
    const client = {
      url: tab.url,
      visibilityState: tab.visibilityState,
      async focus() {
        tab.focusedCalls += 1;
        return client;
      },
      postMessage(message: unknown) {
        if (message !== null && typeof message === 'object') {
          tab.rawMessages.push(structuredClone(message as Record<string, unknown>));
        }
        for (const listener of tab.listeners) {
          void listener({ data: structuredClone(message) });
        }
      },
    };
    return client;
  };

  try {
    delete target.document;
    setGlobal('IDBRequest', MultiTabIDBRequest);
    setGlobal('IDBTransaction', MultiTabIDBTransaction);
    setGlobal('IDBDatabase', MultiTabIDBDatabase);
    setGlobal('IDBObjectStore', MultiTabIDBObjectStore);
    setGlobal('IDBIndex', function IDBIndex(): void {});
    setGlobal('IDBCursor', function IDBCursor(): void {});
    setGlobal('indexedDB', indexedDbShim);
    setGlobal('ServiceWorkerRegistration', MultiTabServiceWorkerRegistration);
    setGlobal('PushSubscription', MultiTabPushSubscription);
    setGlobal('PushManager', function PushManager(): void {});
    setGlobal('Notification', notificationCtor);
    setGlobal('navigator', {
      cookieEnabled: true,
      serviceWorker: {
        addEventListener(type: string, listener: WindowMessageListener): void {
          if (type === 'message' && activeBindingTab !== null) {
            activeBindingTab.listeners.push(listener);
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
        const list: unknown[] = tabs.map((tab) => buildWindowClientForTab(tab));
        if (includeChromeExtensionVisible) {
          list.push({
            url: 'chrome-extension://abcdefghijklmnop/background.html',
            visibilityState: 'visible',
            async focus() {
              return null;
            },
            postMessage() {},
          });
        }
        return list;
      },
      async openWindow(url: string): Promise<null> {
        openWindowCalls.push(url);
        return null;
      },
    });
    setGlobal('origin', 'https://example.test');
    setGlobal('location', {
      href: 'https://example.test/',
      origin: 'https://example.test',
      host: 'example.test',
    });
    setGlobal('registration', new MultiTabServiceWorkerRegistration());
    setGlobal('addEventListener', (type: string, listener: unknown): void => {
      if (type === 'push') {
        swPushListeners.push(listener as SwPushListener);
      } else if (type === 'notificationclick') {
        swClickListeners.push(listener as SwNotificationClickListener);
      }
    });

    const controller: MultiTabMessagingEnvController = {
      createWindowTab(id, path = '/', initialVisibility = 'visible'): SimulatedTabHandle {
        const normalizedPath = path.startsWith('/') ? path : `/${path}`;
        const record: InternalTabRecord = {
          id,
          url: `https://example.test${normalizedPath}`,
          visibilityState: initialVisibility,
          focusedCalls: 0,
          listeners: [],
          rawMessages: [],
        };
        tabs.push(record);
        return {
          id: record.id,
          url: record.url,
          setVisibility(state): void {
            record.visibilityState = state;
          },
          focusCount(): number {
            return record.focusedCalls;
          },
          receivedRawWindowMessages(): ReadonlyArray<Record<string, unknown>> {
            return record.rawMessages;
          },
          bindWindowContext<R>(fn: () => R): R {
            const prev = activeBindingTab;
            activeBindingTab = record;
            try {
              return fn();
            } finally {
              activeBindingTab = prev;
            }
          },
        };
      },
      setChromeExtensionVisibleClient(enabled): void {
        includeChromeExtensionVisible = enabled;
      },
      async dispatchSwPush(spec): Promise<void> {
        const internalPayload = buildInternalPushPayload(spec);
        const pending: Promise<unknown>[] = [];
        for (const listener of swPushListeners) {
          listener({
            data: { json: () => structuredClone(internalPayload) },
            waitUntil: (promise) => {
              pending.push(promise);
            },
          });
        }
        await Promise.all(pending);
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
      async dispatchSwNotificationClick(spec, action = ''): Promise<NotificationClickResult> {
        const internalPayload = buildInternalPushPayload(spec);
        let notificationClosed = false;
        const beforeOpenCount = openWindowCalls.length;
        const pending: Promise<unknown>[] = [];
        for (const listener of swClickListeners) {
          listener({
            action,
            notification: {
              data: { FCM_MSG: structuredClone(internalPayload) },
              close: () => {
                notificationClosed = true;
              },
            },
            stopImmediatePropagation: () => {},
            waitUntil: (promise) => {
              pending.push(promise);
            },
          });
        }
        await Promise.all(pending);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          notificationClosed,
          openWindowUrls: openWindowCalls.slice(beforeOpenCount),
        };
      },
      showNotificationCount(): number {
        return showNotifications;
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
