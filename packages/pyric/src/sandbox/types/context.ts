/**
 * The identity-bearing handle on a sandbox — a `(sandbox, auth)` pair.
 */

import type { AuthState } from './auth-state.js';
import type { Sandbox } from './service.js';

/**
 * Identity-bearing handle on a {@link Sandbox}. A `(sandbox, auth)`
 * pair — cheap to create, immutable, freely shareable. Service
 * factories require a `SandboxContext`; bare `Sandbox` is a type
 * error so every call site states identity explicitly.
 *
 * Constructed via `Sandbox.withAuth(auth)` or chained via
 * `SandboxContext.withAuth(auth)`. The concrete class is exported
 * from `pyric/sandbox` for `instanceof` routing in service
 * factories; consumers don't construct it directly.
 */
export interface SandboxContext {
  /** The data foundation this context operates against. */
  readonly sandbox: Sandbox;
  /** The identity rules evaluate under for operations through this context. */
  readonly auth: AuthState;
  /**
   * Derive a sibling context on the same sandbox with different auth.
   * Replaces, doesn't merge — the new context carries only the new
   * auth, regardless of any prior context's auth.
   */
  withAuth(auth: AuthState): SandboxContext;
}
