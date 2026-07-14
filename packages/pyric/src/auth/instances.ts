/** Auth instance ownership: one handle/session per app over one project store. */
import type { FirebaseApp } from 'firebase/app';
import type { Sandbox } from 'pyric/sandbox';
import {
  defaultClientApp,
  resolveClientApp,
  type ClientAppRuntime,
} from '../sandbox/internal/client-app.js';
import { SandboxBackend } from './sandbox-backend.js';
import { registerAuthPersistence } from './sandbox/persistence.js';
import { createAuthProjectStore, type AuthProjectStore } from './sandbox/project-store.js';
import { signOut } from './sign-in.js';
import { targetOf, type SandboxTarget, type Target } from './target.js';
import { TARGET_SYMBOL, type AppAuth, type Auth, type User } from './types.js';

const sandboxBackends = new WeakMap<Sandbox, SandboxBackend>();
const projectStores = new WeakMap<Sandbox, AuthProjectStore>();
const sandboxHandles = new WeakMap<Sandbox, Auth>();

function projectStoreFor(sandbox: Sandbox): AuthProjectStore {
  let store = projectStores.get(sandbox);
  if (!store) {
    store = createAuthProjectStore();
    projectStores.set(sandbox, store);
  }
  return store;
}

function backendFor(sandbox: Sandbox): SandboxBackend {
  let backend = sandboxBackends.get(sandbox);
  if (!backend) {
    backend = new SandboxBackend(sandbox, sandbox, projectStoreFor(sandbox));
    sandboxBackends.set(sandbox, backend);
    registerAuthPersistence(sandbox, backend, sandbox);
  }
  return backend;
}

function backendForApp(app: FirebaseApp, runtime: ClientAppRuntime): SandboxBackend {
  return runtime.service('auth/backend', () => {
    const { sandbox, session } = runtime;
    // Firebase apps always own their Auth middleware lifecycle, including the
    // default app whose session host happens to be the sandbox itself. The
    // bare `getAuth(sandbox)` API keeps its separate sandbox-lifetime backend.
    const backend = new SandboxBackend(
      sandbox,
      session,
      projectStoreFor(sandbox),
      (cleanup) => { runtime.onDelete(cleanup); },
    );
    runtime.onDelete(registerAuthPersistence(sandbox, backend, session, app.name));
    return backend;
  });
}

export function getAuth(): AppAuth;
export function getAuth(sandbox: Sandbox): Auth;
export function getAuth(app: FirebaseApp): AppAuth;
export function getAuth(target?: Sandbox | FirebaseApp): Auth;
export function getAuth(target?: Sandbox | FirebaseApp): Auth {
  if (target === undefined) return getAuth(defaultClientApp() as FirebaseApp);
  const appRuntime = resolveClientApp(target);
  if (appRuntime) {
    return appRuntime.service('auth/default', () => {
      const t: SandboxTarget = {
        kind: 'sandbox',
        sandbox: appRuntime.sandbox,
        backend: backendForApp(target as FirebaseApp, appRuntime),
        own: (cleanup) => appRuntime.onDelete(cleanup),
        assertAlive: () => appRuntime.assertAlive(),
      };
      return makeAuthHandle(t, target as FirebaseApp);
    });
  }
  if (isSandbox(target)) {
    let handle = sandboxHandles.get(target);
    if (handle) return handle;
    handle = makeAuthHandle({ kind: 'sandbox', sandbox: target, backend: backendFor(target) });
    sandboxHandles.set(target, handle);
    return handle;
  }
  throw new TypeError(
    'pyric/auth is a sandbox-only mirror. Package resolution must leave firebase/auth unchanged for production; activate pyric dev or @pyric/cli/register before importing to select the sandbox.',
  );
}

export function initializeAuth(app: FirebaseApp, deps?: unknown): AppAuth;
export function initializeAuth(app: Sandbox, deps?: unknown): Auth;
export function initializeAuth(app: Sandbox | FirebaseApp, deps?: unknown): Auth {
  void deps;
  return getAuth(app as never);
}

function isSandbox(target: Sandbox | FirebaseApp): target is Sandbox {
  return (
    typeof target === 'object'
    && target !== null
    && typeof (target as Sandbox).onCurrentUserChanged === 'function'
    && typeof (target as Sandbox).withAuth === 'function'
  );
}

function makeAuthHandle(target: Target, app?: FirebaseApp): Auth {
  const handle = {
    [TARGET_SYMBOL]: target,
    ...(app ? { app } : {}),
    signOut(): Promise<void> {
      return signOut(handle as Auth);
    },
  } as Auth;
  return Object.defineProperty(handle, 'currentUser', {
    enumerable: true,
    get(): User | null {
      return target.backend.getCurrentUser();
    },
  });
}

export function connectAuthEmulator(
  auth: Auth,
  url: string,
  options?: { disableWarnings?: boolean },
): void {
  targetOf(auth);
  void url;
  void options;
}
