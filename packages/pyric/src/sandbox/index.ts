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

import { createSandboxRoot } from './internal/root.js';
import type { LocalSandbox, SandboxConfig } from './types/service.js';

export type {
  ActivityEventProvenance,
  AuthLens,
  AuthState,
  DenialContext,
  DenialEvent,
  EventActor,
  EventProvenance,
  EventService,
  OperationContext,
  ListenerLifecycleEvent,
  LocalSandbox,
  MutationEventService,
  PersistableService,
  RequestEvent,
  RulesDisposition,
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
  ServiceEventOperation,
  ServiceEventRecord,
  ServiceEventTarget,
  ServiceMutationEvent,
  ServiceMutationEventFields,
  SessionBoundaryEvent,
  SnapshotDeliveryEvent,
  SnapshotErrorEvent,
  SnapshotSuppressedEvent,
  WriteSandboxEvent,
} from './types/index.js';
export { SandboxError, MUTATION_EVENT_SERVICES, SERVICE_EVENT_RECORDS } from './types/index.js';
export {
  SandboxContextImpl,
  normalizeAuthState,
  validateAuthState,
} from './sandbox-context.js';
// The sandbox clock: the one source of time every service on the sandbox
// reads. `getClock(sandbox).set(...)` / `.advance(...)` / `.reset()` move
// Firestore `serverTimestamp()` and `request.time`, Realtime Database
// `ServerValue.TIMESTAMP` and rules `now`, Storage `timeCreated` / `updated`,
// auth token `iat` / `exp` / `auth_time`, and every listener and event stamp
// together.
export { SandboxClock, wallClockState } from './clock.js';
export type { SandboxClockMode, SandboxClockState } from './clock.js';
export { getClock } from './clock.js';

export {
  isOperationEvent,
  operationContextFor,
  rulesDispositionFor,
  toListenerRecord,
  toOperationRecord,
} from './operation-record.js';
export type { ListenerPhase, OperationRecord } from './operation-record.js';

export { activeListeners, activeListenerTargetStartsWith } from './active-listeners.js';
export type { ActiveListener, ActiveListenerTarget } from './active-listeners.js';

// Remote sandbox (slice 1) — the brand + minimal channel contract that
// lets `pyric-admin` recognize a Node-side handle onto the browser-hosted
// worker sandbox (constructed by `@pyric/cli`' `connectRemoteSandbox`)
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

// Full sandbox state: the whole sandbox as one JSON value, and the total
// replace that installs one. Firestore documents, the Realtime Database tree,
// Storage objects with their bytes and metadata, auth accounts, and the three
// rule sources. This is what a branch forks from and promotes onto.
export { captureFullState, applyFullState } from './full-state.js';
export type {
  AuthAccountsState,
  DatabaseRuleset,
  FullSandboxState,
  SandboxRuleSources,
  SandboxService,
  StorageObjectState,
} from './full-state.js';

// Branches — fork/apply/diff/promote/discard experiments built on top of
// `captureFullState()` + `applyFullState()`. A branch is an isolated
// in-memory sandbox seeded from a `FullSandboxState`, so it carries every
// service; `apply` re-issues captured writes onto it, `diff` walks the two
// states service by service (reuses `Divergence`), `promote` writes that
// same walk onto a target, `discard` drops it. Substrate for Studio's agent
// dry-run/accept, rules-edit branches, and time-travel.
export { apply, discard, diff, diffFullStates, fork, promote, promoteFullState } from './branches/index.js';
export type {
  Branch,
  BranchCandidateRules,
  BranchDivergence,
  DiffTarget,
  TreeChange,
} from './branches/index.js';

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
 * specific configuration (rules, seed data) happens through service-specific
 * sandbox controls — for example, `setRules(sandbox, source)` from
 * `pyric/sandbox/firestore`.
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
export function initializeSandbox(_config: SandboxConfig = {}): LocalSandbox {
  // `_config` is reserved for future service-agnostic options
  // (rules/documents bundled at init when the multi-service
  // architecture lands). Empty for now.
  return createSandboxRoot();
}
