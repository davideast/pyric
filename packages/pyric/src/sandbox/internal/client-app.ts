/** Neutral adapter seam between mirror surfaces and the FirebaseApp registry/runtime. */
import type { AuthState } from '../types/auth-state.js';
import type { Sandbox } from '../types/service.js';

export interface ClientAppSession {
  currentUser: AuthState;
  onCurrentUserChanged(callback: (user: AuthState) => void): () => void;
}

export interface ClientAppRuntime {
  readonly app: object;
  readonly sandbox: Sandbox;
  readonly session: ClientAppSession;
  readonly authScope?: object;
  /** Throw the Firebase-compatible deletion error when the app is no longer usable. */
  assertAlive(): void;
  service<T>(key: string, create: () => T): T;
  /** Own a live resource for the app lifetime; returns a release function. */
  onDelete(cleanup: () => void | Promise<void>): () => void;
}

interface ClientAppAdapter {
  resolve(value: unknown, includeDeleted: boolean): ClientAppRuntime | undefined;
  defaultApp(): object;
}

let adapter: ClientAppAdapter | undefined;

export function installClientAppAdapter(next: ClientAppAdapter): void {
  adapter = next;
}

export function resolveClientApp(value: unknown): ClientAppRuntime | undefined {
  return adapter?.resolve(value, false);
}

/** Firebase AI uniquely permits service resolution from a deleted app. */
export function resolveClientAppIncludingDeleted(value: unknown): ClientAppRuntime | undefined {
  return adapter?.resolve(value, true);
}

export function defaultClientApp(): object {
  if (!adapter) {
    throw new TypeError(
      'No default sandbox app registry is installed - import and initialize pyric/app before calling a service factory without an app.',
    );
  }
  return adapter.defaultApp();
}
