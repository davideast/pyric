import type { FirebaseApp } from 'pyric/app';

/** One installation per origin/profile, shared by pages and their Service Workers. */
let installation: Promise<string> | undefined;

function installationId(): Promise<string> {
  installation ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('pyric-messaging', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('installation');
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Messaging installation storage is blocked.'));
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('installation', 'readwrite');
      const store = transaction.objectStore('installation');
      const read = store.get('id');
      let id: string;
      read.onsuccess = () => {
        const stored: unknown = read.result;
        const hasStoredId = typeof stored === 'string' && stored.length > 0;
        id = hasStoredId ? stored : crypto.randomUUID();
        if (!hasStoredId) store.put(id, 'id');
      };
      transaction.oncomplete = () => { db.close(); resolve(id); };
      transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error('Messaging installation storage failed.')); };
    };
  });
  return installation;
}

/** Scope is shared across registration objects, reloads, and worker restarts. */
export function messagingRegistration(app: FirebaseApp): (scope?: string) => Promise<string> {
  const worker = globalThis as typeof globalThis & { registration?: { scope: string } };
  const defaultScope = worker.registration?.scope ?? new URL('/', location.href).href;
  return async (scope = defaultScope) => JSON.stringify([
    await installationId(),
    app.options.appId ?? app.options.projectId,
    app.name,
    new URL(scope, location.href).href,
  ]);
}
