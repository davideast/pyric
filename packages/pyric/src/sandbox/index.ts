/**
 * `pyric/sandbox` — sandbox host (foundation). Provides the
 * `Sandbox` type, the `SandboxContext` identity handle, the
 * `initializeSandbox` factory, and the `SandboxError` family.
 *
 * Service handles live in sibling packages (`pyric-admin` for the
 * Admin-SDK-shaped chainable Firestore adapter, future
 * `pyric/firestore` for the modular Web SDK adapter,
 * `pyric/auth`/`pyric/database`/`pyric/storage` later) and consume
 * `SandboxContext` from here.
 *
 * Adapter packages also reach into `pyric/sandbox/internal` for the
 * non-public protocol (`getInternalEnv`, etc.). See
 * the design rationale and
 * the design rationale for the design rationale.
 */

import { SandboxImpl } from './internal/sandbox-impl.js';
import type { Sandbox, SandboxConfig } from './types.js';

export type {
  AuthLens,
  AuthState,
  DenialContext,
  DenialEvent,
  EventActor,
  EventProvenance,
  EventService,
  ListenerLifecycleEvent,
  PersistableService,
  RequestEvent,
  Sandbox,
  SandboxConfig,
  SandboxContext,
  SandboxCommitEvent,
  SandboxErrorCode,
  SandboxEvent,
  SandboxListenerEvent,
  SandboxOperationEvent,
  SandboxRuntimeErrorEvent,
  SandboxSnapshot,
  ServiceMutationEvent,
  SessionBoundaryEvent,
  SnapshotDeliveryEvent,
  SnapshotErrorEvent,
  SnapshotSuppressedEvent,
  WriteSandboxEvent,
} from './types.js';
export { SandboxError } from './types.js';
export { SandboxContextImpl } from './sandbox-context.js';

// Remote sandbox (slice 1) — the brand + minimal channel contract that
// lets `pyric-admin` recognize a Node-side handle onto the browser-hosted
// worker sandbox (constructed by `pyric-tools`' `connectRemoteSandbox`)
// and route its RTDB/Auth ops over the wire instead of into local state.
export { REMOTE_SANDBOX, REMOTE_SANDBOX_FACTORY, isRemoteSandbox } from './remote.js';
export type {
  RemoteSandbox,
  RemoteSandboxChannel,
  RemoteSandboxFactory,
  RemoteSandboxFactoryOptions,
} from './remote.js';

// Replay engine — capture a session via `sandbox.history()` and re-
// issue every write against a fresh sandbox. See
// `docs/how-to/replay-events.md`.
export { replay } from './replay/index.js';
export type { Divergence, ReplayOptions, ReplayResult } from './replay/index.js';

// Branches — fork/apply/diff/promote/discard experiments built on top of
// `snapshot()` + `replay()`. A branch is an isolated in-memory sandbox
// seeded from a `SandboxSnapshot`; `apply` re-issues events via `replay`,
// `diff` is a focused doc-level structural diff (reuses `Divergence`),
// `promote` lands the branch's mutations on a target, `discard` drops it.
// Substrate for Studio's agent dry-run/accept, rules-edit branches, and
// time-travel. See the design rationale.
export { apply, discard, diff, fork, promote } from './branches/index.js';
export type { Branch, DiffTarget } from './branches/index.js';

// Persistence — snapshot the sandbox to IndexedDB (or a custom backend)
// and restore on next init. Turns the sandbox into the host page's
// local Firestore for session storage.
export type {
  PersistenceBackend,
  PersistenceController,
  SandboxPersistenceOptions,
  WebStorageLike,
} from './persistence/index.js';
export {
  attachPersistence,
  createIndexedDBBackend,
  createMemoryBackend,
  recordBackendOverBlob,
  serializeToBuckets,
  deserializeFromBuckets,
  bundleRecords,
  parseBundle,
  PersistenceSchemaError,
  rehydrateDocValue,
} from './persistence/index.js';

// Tab sync — opt-in cross-tab realtime via BroadcastChannel.
export type { BroadcastChannelLike, TabSyncOptions } from './tab-sync/index.js';
export { attachTabSync } from './tab-sync/index.js';

/**
 * Create a sandbox.
 *
 * Identity is **not** part of init — call `sandbox.withAuth(...)` to
 * derive a {@link SandboxContext} for service operations. Service-
 * specific configuration (rules, seed data) happens through service
 * handles — for example, `getFirestore(ctx).setRules(...)`.
 *
 * @example
 * ```ts
 * import { initializeSandbox } from 'pyric/sandbox';
 * import { getFirestore } from 'pyric-admin/firestore';
 *
 * const sandbox = initializeSandbox();
 * const dbAlice = getFirestore(sandbox.withAuth({ uid: 'alice' }));
 * const dbAnon  = getFirestore(sandbox.withAuth(null));
 * ```
 */
export function initializeSandbox(_config: SandboxConfig = {}): Sandbox {
  // `_config` is reserved for future service-agnostic options
  // (rules/documents bundled at init when the multi-service
  // architecture lands). Empty for now.
  return SandboxImpl.createRoot();
}
