/**
 * The RTDB backend seam the viewer drives — an EXPLICIT bundle, not a context
 * default. Unlike Firestore/Auth/Storage there is no in-process handle typed
 * into `@pyric/ui`, so the consumer constructs the bundle and passes it to the
 * hook/components directly (Studio wires it to the SharedWorker client's
 * admin-lens ops; data views are always admin — PRINCIPLES M3).
 */
export interface RtdbApi {
  /** Replace the value at `path` (`null` deletes, RTDB semantics). */
  set(path: string, value: unknown): Promise<void>;
  /** Delete the subtree at `path`. */
  remove(path: string): Promise<void>;
  /**
   * Live value subscription at `path`: `next` fires with the subtree's plain
   * JSON value (`null` when absent) on subscribe and after every change.
   * Returns the unsubscribe.
   */
  subscribeValue(
    path: string,
    next: (value: unknown) => void,
    error?: (err: unknown) => void,
  ): () => void;
}
