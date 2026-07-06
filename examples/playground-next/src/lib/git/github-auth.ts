/**
 * GitHub personal access token storage.
 *
 * The PAT is held in a dedicated IndexedDB database (`pyric:github-creds`),
 * single object store (`creds`), single record under key `github-pat`.
 * No encryption — the value never leaves the browser. The user is the
 * only audience; protect it the same way they protect anything in their
 * own origin storage.
 */

const DB_NAME = 'pyric:github-creds';
const STORE = 'creds';
const KEY = 'github-pat';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error(`Failed to open IndexedDB '${DB_NAME}'`));
    req.onblocked = () => reject(new Error(`IndexedDB open blocked for '${DB_NAME}'`));
  });
}

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getStoredPAT(): Promise<string | null> {
  if (typeof indexedDB === 'undefined') return null;
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readonly');
    const value = await reqAsPromise(tx.objectStore(STORE).get(KEY));
    return (value as string | undefined) ?? null;
  } finally {
    db.close();
  }
}

export async function storePAT(token: string): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB unavailable; cannot persist GitHub PAT.');
  }
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    await reqAsPromise(tx.objectStore(STORE).put(token, KEY));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

export async function clearPAT(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    await reqAsPromise(tx.objectStore(STORE).delete(KEY));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}
