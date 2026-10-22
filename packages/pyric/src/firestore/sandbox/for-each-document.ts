/**
 * Production's `QuerySnapshot.forEach(callback, thisArg?)`: calls
 * `callback.call(thisArg, doc)` once per document, in query order, with the
 * document alone (no index or array, unlike `Array.prototype.forEach`).
 *
 * Shared by every plane that builds a query snapshot (the in-page modular and
 * Admin-shaped snapshots, the remote Admin arm, the served worker client), so
 * each calls the callback the same way. No imports, so any snapshot module can
 * use it without a cycle.
 */
export function forEachDocument<S>(docs: readonly S[]): (callback: (doc: S) => void, thisArg?: unknown) => void {
  return (callback, thisArg) => {
    for (const doc of docs) callback.call(thisArg, doc);
  };
}
