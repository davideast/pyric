/** Auth persistence registration: one shared account store, one session per app. */
import type { Sandbox } from 'pyric/sandbox';
import type { SandboxBackend, SeedUser } from '../sandbox-backend.js';

type AuthSession = Pick<Sandbox, 'currentUser'>;

const registeredStores = new WeakSet<Sandbox>();

interface SessionBinding {
  backend: SandboxBackend;
  session: AuthSession;
  subscribers: Set<() => void>;
  unsubscribeBackend?: () => void;
  unregisterService?: () => void;
  generation: number;
}

const sessionBindings = new WeakMap<Sandbox, Map<string, SessionBinding>>();

export function registerAuthPersistence(
  sandbox: Sandbox,
  backend: SandboxBackend,
  session: AuthSession,
  appName = '[DEFAULT]',
): () => void {
  registerAccountStore(sandbox, backend);
  return registerAppSession(sandbox, backend, session, appName);
}

function registerAccountStore(sandbox: Sandbox, backend: SandboxBackend): void {
  if (registeredStores.has(sandbox)) return;
  registeredStores.add(sandbox);
  sandbox.registerPersistableService('auth', {
    snapshot: () => ({
      users: backend.exportUsers(),
      providers: backend.exportProviderConfig(),
    }),
    restore: (data: unknown) => {
      const restored = data as { users?: SeedUser[]; providers?: Record<string, boolean> };
      backend.clearUsers();
      if (Array.isArray(restored?.users) && restored.users.length > 0) {
        backend.seedUsers(restored.users);
      }
      backend.restoreProviderConfig(restored?.providers);
    },
    subscribe: (onChange) => {
      const unsubscribeUsers = backend.subscribeUsers(onChange);
      const unsubscribeProviders = backend.subscribeProviderConfig(onChange);
      return () => {
        unsubscribeUsers();
        unsubscribeProviders();
      };
    },
  });
}

function appSessionPersistenceHooks(binding: SessionBinding) {
  return {
    snapshot: () => null,
    restore: () => {},
    session: {
      currentUid: () => binding.session.currentUser?.uid ?? null,
      restore: (uid: string, mode: 'LOCAL' | 'SESSION') => {
        binding.backend.setPersistenceMode(mode);
        binding.backend.restoreSession(uid);
      },
      mode: () => binding.backend.getPersistenceMode(),
      subscribe: (onChange: () => void) => {
        binding.subscribers.add(onChange);
        if (!binding.unsubscribeBackend) {
          binding.unsubscribeBackend = binding.backend.subscribeSession(() => {
            for (const subscriber of binding.subscribers) subscriber();
          });
        }
        return () => {
          binding.subscribers.delete(onChange);
          if (binding.subscribers.size === 0) {
            binding.unsubscribeBackend?.();
            binding.unsubscribeBackend = undefined;
          }
        };
      },
    },
  } satisfies Parameters<Sandbox['registerPersistableService']>[1];
}

function registerAppSession(
  sandbox: Sandbox,
  backend: SandboxBackend,
  session: AuthSession,
  appName: string,
): () => void {
  let bindings = sessionBindings.get(sandbox);
  if (!bindings) {
    bindings = new Map();
    sessionBindings.set(sandbox, bindings);
  }
  const serviceName = `auth-session:${appName}`;
  const existing = bindings.get(serviceName);
  if (existing) {
    const generation = ++existing.generation;
    // Re-register the stable name-keyed service so an attached persistence
    // controller applies the retained session to the replacement app. Merely
    // retargeting these closures would leave its empty session current.
    existing.unregisterService?.();
    existing.unregisterService = undefined;
    existing.unsubscribeBackend?.();
    existing.unsubscribeBackend = undefined;
    existing.backend = backend;
    existing.session = session;
    existing.unregisterService = sandbox.registerPersistableService(
      serviceName,
      appSessionPersistenceHooks(existing),
    );
    return () => {
      if (existing.generation !== generation) return;
      existing.unregisterService?.();
      existing.unregisterService = undefined;
      existing.unsubscribeBackend?.();
      existing.unsubscribeBackend = undefined;
      existing.subscribers.clear();
      if (bindings!.get(serviceName) === existing) bindings!.delete(serviceName);
      if (bindings!.size === 0) sessionBindings.delete(sandbox);
    };
  }

  const binding: SessionBinding = {
    backend,
    session,
    subscribers: new Set(),
    generation: 1,
  };
  bindings.set(serviceName, binding);
  binding.unregisterService = sandbox.registerPersistableService(
    serviceName,
    appSessionPersistenceHooks(binding),
  );
  const generation = binding.generation;
  return () => {
    if (binding.generation !== generation) return;
    binding.unregisterService?.();
    binding.unregisterService = undefined;
    binding.unsubscribeBackend?.();
    binding.unsubscribeBackend = undefined;
    binding.subscribers.clear();
    if (bindings!.get(serviceName) === binding) bindings!.delete(serviceName);
    if (bindings!.size === 0) sessionBindings.delete(sandbox);
  };
}
