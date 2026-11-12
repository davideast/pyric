const deletedApps = new WeakSet<object>();
const deleteHooks = new WeakMap<object, Set<() => void>>();

/** Internal lifecycle guard shared by every pyric-admin service factory. */
export function assertAdminAppActive(app: object & { readonly name: string }): void {
  if (!deletedApps.has(app)) return;
  const error = new Error(
    `Firebase app named "${app.name}" has already been deleted.`,
  ) as Error & { code: string };
  error.name = 'FirebaseAppError';
  error.code = 'app/app-deleted';
  throw error;
}

/** Register a teardown hook invoked once when `deleteApp(app)` tombstones `app`. */
export function onAdminAppDeleted(app: object, cleanup: () => void): void {
  if (deletedApps.has(app)) {
    cleanup();
    return;
  }
  let hooks = deleteHooks.get(app);
  if (hooks === undefined) {
    hooks = new Set();
    deleteHooks.set(app, hooks);
  }
  hooks.add(cleanup);
}

/** Tombstone a wrapper while leaving the caller-owned Sandbox alive. */
export function markAdminAppDeleted(app: object): void {
  deletedApps.add(app);
  const hooks = deleteHooks.get(app);
  if (hooks === undefined) return;
  deleteHooks.delete(app);
  for (const cleanup of hooks) {
    try {
      cleanup();
    } catch {
      // Isolate service teardown errors so every registered service detaches.
    }
  }
}
