/**
 * Public type surface for `pyric/sandbox`.
 *
 * Kept service-agnostic on purpose: `/app` is the host the rest of the
 * library plugs into. Service modules (`/firestore`, future `/storage`,
 * `/auth`, `/database`) depend on these types; they don't ship from
 * here. See design rationale for the dependency-direction
 * argument.
 *
 * Split by subsystem (auth-state, errors, persistence, events, service,
 * context) so parallel work on one subsystem's types doesn't collide with
 * another's. This barrel is a computed re-export — the package export
 * contract (`sandbox/index.ts`) imports from here; every other consumer
 * in this package imports directly from the concept file it needs.
 */

export type { AuthState } from './auth-state.js';

export type {
  DenialContext,
  SandboxErrorCode,
  SandboxErrorOptions,
} from './errors.js';
export { SandboxError } from './errors.js';

export type { PersistableService, SandboxSnapshot } from './persistence.js';

export {
  MUTATION_EVENT_SERVICES,
  SERVICE_EVENT_RECORDS,
} from './service-event-records.js';

export type {
  DenialEvent,
  ListenerLifecycleEvent,
  ListenerOwner,
  MutationEventService,
  RequestEvent,
  SandboxCommitEvent,
  SandboxEvent,
  SandboxListenerEvent,
  SandboxOperationEvent,
  SandboxRuntimeErrorEvent,
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
} from './events.js';
export type {
  ActivityEventProvenance,
  AuthLens,
  EventActor,
  EventProvenance,
  EventService,
  OperationContext,
  RulesDisposition,
} from './operation.js';

export type {
  LocalSandbox,
  Sandbox,
  SandboxAdmin,
  SandboxConfig,
} from './service.js';

export type { SandboxContext } from './context.js';
