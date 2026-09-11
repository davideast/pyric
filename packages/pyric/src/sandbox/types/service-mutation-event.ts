/**
 * The cross-service mutation envelope: the one event shape every non-Firestore
 * service uses to report a state change.
 *
 * Firestore's existing kinds are tightly coupled to the rules simulator:
 * `RequestEvent` carries `result`, `evalMs`, the simulator's `reasons[]`, and
 * `matchedRule`; `WriteSandboxEvent` carries Firestore-specific `sentinels`,
 * `autoId`, and a Firestore `requestTime`. An auth user-DB mutation has no
 * path and no rule evaluation, a storage put and an RTDB tree write have
 * neither sentinels nor auto-ids, and bending them into the Firestore shapes
 * would either synthesize a fake `result` or pollute the Firestore consumer
 * contract. So this is one small additive variant those services share;
 * Firestore consumers filter on their existing kinds and never see it.
 *
 * The `service` and `op` fields are derived from the per-service records in
 * `service-event-records.ts`, so a service joins this envelope by declaring
 * an event record beside its own code and no other way.
 */
import type { AuthState } from './auth-state.js';
import type {
  MutationEventService,
  ServiceEventOperation,
} from './service-event-records.js';

/**
 * One state change one service reported.
 *
 * `before` and `after` are best-effort serializable snapshots, omitted when
 * there is nothing meaningful to carry (a create has no before, a sign-out no
 * after). Studio's data grids and Action Center render `service`, `op`, and
 * `path` directly and diff `before` against `after` when both are present.
 */
export interface ServiceMutationEventOf<Service extends MutationEventService> {
  kind: 'service_mutation';
  id: string;
  at: number;
  /**
   * Which service performed the mutation. Always one of the non-Firestore
   * services; Firestore rides its own `request`/`write` path. The provenance
   * `service` field on the stamped event mirrors this, set redundantly here so
   * a consumer matching purely on `kind` still gets the discriminator without
   * reaching into provenance.
   */
  service: Service;
  /**
   * Service-scoped operation name, drawn from the operations that service's
   * own record declares. A service adds an operation by adding it there.
   */
  op: ServiceEventOperation<Service>;
  /**
   * The thing mutated, in the service's own addressing scheme:
   *   - auth:    the user `uid` (or `'*'` for a clear-all). Absent for a
   *              sign-out with no prior user.
   *   - storage: the object `fullPath` (e.g. `avatars/alice.png`).
   *   - rtdb:    the database path (e.g. `/rooms/r1/messages`), or for a
   *              multi-path `update` the ref path the call targeted.
   */
  path?: string;
  /** Identity in effect when the op ran (the service's `request.auth`
   *  equivalent). `null` for admin/anonymous-driven mutations (e.g.
   *  `sandbox.createUser`, an unauthenticated RTDB write). */
  auth: AuthState;
  /** Best-effort serializable snapshot of the state BEFORE the mutation.
   *  Absent when there was no prior state (a create) or it isn't cheap to
   *  capture. */
  before?: unknown;
  /** Best-effort serializable snapshot of the state AFTER the mutation.
   *  Absent on deletes / sign-outs (nothing remains). */
  after?: unknown;
  /** Free-form, service-specific extras a consumer may surface without
   *  re-deriving (e.g. storage `{ size, contentType }`, rtdb
   *  `{ committed }` for a transaction). Kept loose on purpose — it's a
   *  display hint, not a contract. */
  detail?: Record<string, unknown>;
}

/**
 * The cross-service mutation envelope, as the union over every service that
 * declared an event record. Narrowing on `service` narrows `op` to that
 * service's own operations.
 */
export type ServiceMutationEvent = {
  [Service in MutationEventService]: ServiceMutationEventOf<Service>;
}[MutationEventService];

/**
 * The fields a caller supplies to build a {@link ServiceMutationEvent}; `kind`
 * and `id` are the emitter's. Distributed per service so `op` stays bound to
 * the `service` beside it.
 */
export type ServiceMutationEventFields = {
  [Service in MutationEventService]: Omit<ServiceMutationEventOf<Service>, 'kind' | 'id'>;
}[MutationEventService];
