const deletedApps = new WeakSet<object>();
const deleteHooks = new WeakMap<object, Set<() => void | Promise<void>>>();

/** Shared global key tracking implicitly-created ambient `[DEFAULT]` apps. */
export const IMPLICIT_DEFAULT_APPS = Symbol.for('pyric.admin.app.implicitDefaultApps');

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
export function onAdminAppDeleted(app: object, cleanup: () => void | Promise<void>): void {
  if (deletedApps.has(app)) {
    try {
      const result = cleanup();
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => {});
      }
    } catch {
      // Isolate late teardown throws on an already-deleted app.
    }
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
export function markAdminAppDeleted(app: object): Promise<void> {
  deletedApps.add(app);
  const hooks = deleteHooks.get(app);
  if (hooks === undefined) return Promise.resolve();
  deleteHooks.delete(app);
  const pending: Promise<void>[] = [];
  for (const cleanup of hooks) {
    try {
      const result = cleanup();
      if (result !== undefined) {
        pending.push(Promise.resolve(result).catch(() => {}));
      }
    } catch {
      // Isolate service teardown errors so every registered service detaches.
    }
  }
  if (pending.length === 0) return Promise.resolve();
  return Promise.all(pending).then(() => undefined);
}

export interface AdminServiceLifecycle {
  readonly isDeleted: boolean;
  assertActive(): void;
  trackSubscription(unsubscribe: () => void): () => void;
}

/**
 * Bind an Admin service instance and all handles/listeners derived from it to
 * the owning `PyricAdminApp` lifecycle (`deleteApp(app)`).
 */
export function createAdminServiceLifecycle(
  app: object & { readonly name: string },
): AdminServiceLifecycle {
  let deleted = false;
  const subscriptions = new Set<() => void>();

  onAdminAppDeleted(app, () => {
    if (deleted) return;
    deleted = true;
    for (const unsubscribe of [...subscriptions]) {
      subscriptions.delete(unsubscribe);
      try {
        unsubscribe();
      } catch {
        // Isolate individual listener detach errors during app teardown.
      }
    }
  });

  return {
    get isDeleted(): boolean {
      return deleted;
    },
    assertActive(): void {
      assertAdminAppActive(app);
    },
    trackSubscription(unsubscribe: () => void): () => void {
      if (deleted) {
        unsubscribe();
        return () => {};
      }
      let active = true;
      const detach = (): void => {
        if (!active) return;
        active = false;
        subscriptions.delete(detach);
        unsubscribe();
      };
      subscriptions.add(detach);
      return detach;
    },
  };
}
