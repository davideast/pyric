/**
 * This tab's id, which the host stamps on the tab's events as
 * `caller.pageId`. Every port a tab opens (one per Firebase app, plus the
 * runtime's control port) sends the same id, and `sessionStorage` keeps it
 * across reloads, so a page's earlier requests stay its own after a reload.
 *
 * A context without `sessionStorage` (a Node process, a worker) or one that
 * refuses it keeps an id minted once in memory instead, so its ports still
 * agree; only a reload then reads as a new tab.
 */
const TAB_ID_KEY = 'pyric.tabId';

let realmTabId: string | undefined;

function mintTabId(): string {
  return `tab-${globalThis.crypto.randomUUID()}`;
}

/** The id minted once for this realm, for a tab whose `sessionStorage` cannot keep one. */
function inMemoryTabId(): string {
  realmTabId ??= mintTabId();
  return realmTabId;
}

function storedTabId(): string | undefined {
  try {
    const storage = globalThis.sessionStorage;
    if (storage === undefined) return undefined;
    const stored = storage.getItem(TAB_ID_KEY);
    if (stored !== null) return stored;
    const minted = mintTabId();
    storage.setItem(TAB_ID_KEY, minted);
    return minted;
  } catch {
    return undefined;
  }
}

export function pageTabId(): string {
  return storedTabId() ?? inMemoryTabId();
}
