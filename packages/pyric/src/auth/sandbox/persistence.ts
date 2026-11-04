/** Auth persistence registration: one shared account store, one session per app. */
import type { Sandbox } from 'pyric/sandbox';
import { authAccountsFor } from 'pyric/sandbox/internal';
import { isAuthAccountHistory } from '../../sandbox/internal/auth-accounts.js';
import type { SandboxBackend, SeedUser } from '../sandbox-backend.js';
import { persistedSessions, restorePersistedSessions, type AuthProjectStore } from './project-store.js';
import { sessionKeyOf } from './session-ledger.js';

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
  store: AuthProjectStore,
  appName = '[DEFAULT]',
): () => void {
  registerAccountStore(sandbox, backend, store);
  return registerAppSession(sandbox, backend, session, appName);
}

function registerAccountStore(sandbox: Sandbox, backend: SandboxBackend, store: AuthProjectStore): void {
  if (registeredStores.has(sandbox)) return;
  registeredStores.add(sandbox);
  sandbox.registerPersistableService('auth', {
    // Each account's revocation time, the deleted uids, and the sessions'
    // sign-in times persist with the accounts, so a reload does not bring
    // a revoked session back (#2018).
    snapshot: () => ({
      users: backend.exportUsers(),
      providers: backend.exportProviderConfig(),
      history: authAccountsFor(sandbox)?.history(),
      sessions: persistedSessions(store),
    }),
    restore: (data: unknown) => {
      const restored = data as {
        users?: SeedUser[];
        providers?: Record<string, boolean>;
        history?: unknown;
        sessions?: unknown;
      };
      backend.clearUsers();
      const accounts = authAccountsFor(sandbox);
      accounts?.forgetHistory();
      if (Array.isArray(restored?.users) && restored.users.length > 0) {
        backend.seedUsers(restored.users);
      }
      backend.restoreProviderConfig(restored?.providers);
      // Persisted state written before the history restores as before.
      if (isAuthAccountHistory(restored?.history)) accounts?.replayHistory(restored.history);
      restorePersistedSessions(store, restored?.sessions);
    },
    // Sandbox.resetAll: wipe the user DB + provider config back to defaults —
    // identical to restoring an empty snapshot. The signed-in session is the
    // sandbox core's job (reset() clears currentUser before services run).
    reset: () => {
      backend.clearUsers();
      authAccountsFor(sandbox)?.forgetHistory();
      backend.restoreProviderConfig(undefined);
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
      // The current session's key, saved with its uid so a reload resumes
      // the session with the sign-in time it had (#2018).
      sessionKey: () => {
        const current = binding.backend.getCurrentUser();
        return current === null ? undefined : sessionKeyOf(current);
      },
      restore: (uid: string, mode: 'LOCAL' | 'SESSION', sessionKey?: string) => {
        binding.backend.setPersistenceMode(mode);
        binding.backend.restoreSession(uid, sessionKey);
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
