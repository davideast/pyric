import { assertAdminAppActive, onAdminAppDeleted } from '../app/lifecycle.js';

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
