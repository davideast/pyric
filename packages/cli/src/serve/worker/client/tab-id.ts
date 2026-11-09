/**
 * This tab's id, which the host stamps on the tab's events as
 * `caller.pageId`. Every port a tab opens (one per Firebase app, plus the
 * runtime's control port) sends the same id, and `sessionStorage` keeps it
 * across reloads, so a page's earlier requests stay its own after a reload.
 *
 * Browser "Duplicate Tab" clones `sessionStorage` while the original tab is
 * still open. To avoid two open tabs sharing one `tabId` (and sweeping each
 * other's attached listeners), a top-level browser document records a leaving
 * marker only on non-persisted `pagehide` (actual unload, not BFCache) and only
 * reuses `sessionStorage`'s id when that marker proves the previous document in
 * this tab unloaded. Child iframes keep an isolated in-memory id so they never
 * clobber the top-level tab's `sessionStorage`.
 *
 * A context without `sessionStorage` (a Node process, a worker) or one that
 * refuses it keeps an id minted once in memory instead, so its ports still
 * agree; only a reload then reads as a new tab.
 */
const TAB_ID_KEY = 'pyric.tabId';
const TAB_LEAVING_KEY = 'pyric.tabId.leaving';

const DOCUMENT_TAB_IDS = new WeakMap<object, string>();

let realmTabId: string | undefined;

interface LifecycleTarget {
  addEventListener?(type: string, listener: (event: Event) => void): void;
  window?: unknown;
  top?: unknown;
}

/** 16 random bytes as hex. An id, not a secret: `Math.random` serves where `crypto` is missing. */
function randomHex(): string {
  const bytes = new Uint8Array(16);
  const random = globalThis.crypto;
  const hasCrypto = random !== undefined && typeof random.getRandomValues === 'function';
  if (hasCrypto) random.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * A new tab id. `crypto.randomUUID` exists only in a secure context; a page
 * served over plain http from a non-loopback address still has
 * `crypto.getRandomValues`, so that is what mints it.
 */
function mintTabId(): string {
  return `tab-${randomHex()}`;
}

/** The id minted once for this realm, for a tab whose `sessionStorage` cannot keep one. */
function inMemoryTabId(): string {
  realmTabId ??= mintTabId();
  return realmTabId;
}

function isChildFrame(): boolean {
  try {
    const scope = globalThis as unknown as LifecycleTarget;
    return scope.window !== undefined && scope.top !== undefined && scope.window !== scope.top;
  } catch {
    return true;
  }
}

function browserDocument(): object | undefined {
  const doc = (globalThis as { document?: unknown }).document;
  const events = globalThis as unknown as LifecycleTarget;
  if (typeof doc !== 'object' || doc === null) return undefined;
  if (typeof events.addEventListener !== 'function') return undefined;
  return doc;
}

function armLeavingMarker(storage: Storage, tabId: string): void {
  const events = globalThis as unknown as LifecycleTarget;
  events.addEventListener?.('pagehide', (event: Event) => {
    // BFCache-persisted pages stay alive and keep their WebSocket/session.
    if ((event as { persisted?: boolean }).persisted) return;
    try {
      storage.setItem(TAB_LEAVING_KEY, tabId);
    } catch {
      // Best-effort marker across same-tab reloads.
    }
  });
  events.addEventListener?.('pageshow', (event: Event) => {
    if (!(event as { persisted?: boolean }).persisted) return;
    try {
      storage.removeItem?.(TAB_LEAVING_KEY);
      storage.setItem(TAB_ID_KEY, tabId);
    } catch {
      // Ignore storage failures on BFCache restore.
    }
  });
}

function storedTabId(): string | undefined {
  if (isChildFrame()) return undefined;
  const doc = browserDocument();
  if (doc !== undefined) {
    const cached = DOCUMENT_TAB_IDS.get(doc);
    if (cached !== undefined) return cached;
  }
  try {
    const storage = globalThis.sessionStorage;
    if (storage === undefined) return undefined;
    const stored = storage.getItem(TAB_ID_KEY);
    if (doc === undefined) {
      if (stored !== null) return stored;
      const minted = mintTabId();
      storage.setItem(TAB_ID_KEY, minted);
      return minted;
    }
    const leaving = storage.getItem(TAB_LEAVING_KEY);
    storage.removeItem?.(TAB_LEAVING_KEY);
    const isSameTabNavigation = stored !== null && leaving === stored;
    const resolved = isSameTabNavigation ? stored : mintTabId();
    if (!isSameTabNavigation) storage.setItem(TAB_ID_KEY, resolved);
    DOCUMENT_TAB_IDS.set(doc, resolved);
    armLeavingMarker(storage, resolved);
    return resolved;
  } catch {
    return undefined;
  }
}

export function pageTabId(): string {
  return storedTabId() ?? inMemoryTabId();
}
