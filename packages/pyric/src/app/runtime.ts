/** App-owned runtime state behind the neutral sandbox adapter seam. */
import type { FirebaseApp } from 'firebase/app';
import {
  installClientAppAdapter,
  type ClientAppRuntime,
  type ClientAppSession,
} from '../sandbox/internal/client-app.js';
import type { Sandbox } from '../sandbox/types/service.js';
import { FirebaseError } from '../sandbox/internal/firebase-error.js';

function createAppSession(): ClientAppSession {
  let currentUser: ClientAppSession['currentUser'] = null;
  const subscribers = new Set<(user: ClientAppSession['currentUser']) => void>();
  return {
    get currentUser() {
      return currentUser;
    },
    set currentUser(user) {
      if (currentUser === user) return;
      currentUser = user;
      for (const subscriber of [...subscribers]) subscriber(user);
    },
    onCurrentUserChanged(callback) {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
  };
}

interface OwnedAppRuntime extends ClientAppRuntime {
  readonly app: FirebaseApp;
  readonly services: Map<string, unknown>;
  readonly cleanups: Set<() => void | Promise<void>>;
  deleted: boolean;
}

const runtimes = new WeakMap<FirebaseApp, OwnedAppRuntime>();
let defaultAppResolver: (() => FirebaseApp) | undefined;

export function attachSandboxApp(
  app: FirebaseApp,
  sandbox: Sandbox,
  session: ClientAppSession = createAppSession(),
): OwnedAppRuntime {
  const appName = app.name;
  const authScope = session === sandbox ? undefined : {};
  const services = new Map<string, unknown>();
  const cleanups = new Set<() => void | Promise<void>>();
  const runtime: OwnedAppRuntime = {
    app,
    sandbox,
    session,
    services,
    cleanups,
    assertAlive() {
      if (!runtime.deleted) return;
      throw new FirebaseError(
        'app/app-deleted',
        `Firebase: Firebase App named '${appName}' already deleted (app/app-deleted).`,
      );
    },
    ...(authScope ? { authScope } : {}),
    service<T>(key: string, create: () => T): T {
      const existing = services.get(key);
      if (existing !== undefined) return existing as T;
      runtime.assertAlive();
      const service = create();
      services.set(key, service);
      return service;
    },
    onDelete(cleanup) {
      if (runtime.deleted) {
        void cleanup();
        return () => {};
      }
      cleanups.add(cleanup);
      return () => cleanups.delete(cleanup);
    },
    deleted: false,
  };
  runtimes.set(app, runtime);
  return runtime;
}

export async function markSandboxAppDeleted(app: FirebaseApp): Promise<void> {
  const runtime = runtimes.get(app);
  if (!runtime) return;
  runtime.deleted = true;
  const results = await Promise.allSettled(
    [...runtime.cleanups].map((cleanup) => Promise.resolve().then(cleanup)),
  );
  runtime.cleanups.clear();
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Multiple app-owned resources failed to tear down');
  }
}

export function sandboxForApp(app: FirebaseApp): Sandbox {
  const runtime = resolveOwnedRuntime(app);
  return runtime.sandbox;
}

export function ownSandboxAppResource(
  app: FirebaseApp,
  cleanup: () => void | Promise<void>,
): () => void {
  return resolveOwnedRuntime(app).onDelete(cleanup);
}

export function isSandboxAppDeleted(app: FirebaseApp): boolean {
  return runtimes.get(app)?.deleted === true;
}

export function installDefaultAppResolver(resolve: () => FirebaseApp): void {
  defaultAppResolver = resolve;
}

function resolveOwnedRuntime(value: unknown): OwnedAppRuntime {
  const runtime = typeof value === 'object' && value !== null
    ? runtimes.get(value as FirebaseApp)
    : undefined;
  if (!runtime) throw new TypeError('pyric: unrecognized FirebaseApp handle');
  runtime.assertAlive();
  return runtime;
}

installClientAppAdapter({
  resolve(value, includeDeleted) {
    const runtime = typeof value === 'object' && value !== null
      ? runtimes.get(value as FirebaseApp)
      : undefined;
    if (!runtime) return undefined;
    void includeDeleted;
    return runtime;
  },
  defaultApp() {
    if (!defaultAppResolver) {
      throw new TypeError(
        'No default sandbox app registry is installed - import and initialize pyric/app before calling a service factory without an app.',
      );
    }
    return defaultAppResolver();
  },
});
