type AuthUser<Auth extends { currentUser: unknown }> = Auth['currentUser'];

export interface ActiveAuthRegistry<Auth extends { currentUser: unknown }> {
  register(auth: Auth): () => void;
  subscribe(listener: (user: AuthUser<Auth>) => void): () => void;
  auths(): IterableIterator<Auth>;
}

/** Coordinates unique Auth handles while allowing more than one lifecycle owner. */
export function createActiveAuthRegistry<Auth extends { currentUser: unknown }>(
  observe: (auth: Auth, listener: (user: AuthUser<Auth>) => void) => () => void,
): ActiveAuthRegistry<Auth> {
  const registrations = new Map<Auth, { owners: number; unsubscribe: () => void }>();
  const listeners = new Set<(user: AuthUser<Auth>) => void>();

  const register = (auth: Auth): (() => void) => {
    const existing = registrations.get(auth);
    if (existing) {
      existing.owners += 1;
    } else {
      const unsubscribe = observe(auth, (user) => {
        for (const listener of listeners) listener(user);
      });
      registrations.set(auth, { owners: 1, unsubscribe });
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const registration = registrations.get(auth);
      if (!registration) return;
      registration.owners -= 1;
      if (registration.owners > 0) return;
      registrations.delete(auth);
      registration.unsubscribe();
    };
  };

  const subscribe = (listener: (user: AuthUser<Auth>) => void): (() => void) => {
    listeners.add(listener);
    for (const auth of registrations.keys()) {
      if (auth.currentUser) {
        listener(auth.currentUser);
        break;
      }
    }
    return () => listeners.delete(listener);
  };

  return {
    register,
    subscribe,
    auths: () => registrations.keys(),
  };
}
