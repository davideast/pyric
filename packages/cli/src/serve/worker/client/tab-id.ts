/**
 * This tab's id, which the host stamps on the tab's events as
 * `caller.pageId`. Every port a tab opens (one per Firebase app, plus the
 * runtime's control port) sends the same id, and `sessionStorage` keeps it
 * across reloads, so a page's earlier requests stay its own after a reload.
 *
 * A context without `sessionStorage` (a Node process, a worker) or one that
 * refuses it sends none, and the host names the port instead.
 */
const TAB_ID_KEY = 'pyric.tabId';

export function pageTabId(): string | undefined {
  try {
    const storage = globalThis.sessionStorage;
    if (storage === undefined) return undefined;
    const stored = storage.getItem(TAB_ID_KEY);
    if (stored !== null) return stored;
    const minted = `tab-${globalThis.crypto.randomUUID()}`;
    storage.setItem(TAB_ID_KEY, minted);
    return minted;
  } catch {
    return undefined;
  }
}
