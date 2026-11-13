/**
 * Internal symbol hook invoked by `terminate(db)` to evict a cached
 * `AppFirestore` instance from `appFirestoreRegistry` and release its
 * `appRuntime.onDelete` subscription.
 */
export const EVICT_APP_CACHE_SYMBOL = Symbol.for('pyric.firestore.evictAppCache');
