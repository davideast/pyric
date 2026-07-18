/** Cross-service operation identity and Security Rules disposition. */

/** Which sandbox service emitted an event. */
export type EventService = 'firestore' | 'auth' | 'storage' | 'rtdb' | 'messaging' | 'ai';

/** Who initiated the operation behind an event. Missing source is represented
 * explicitly as `unattributed`; it is never silently promoted to app traffic. */
export type EventActor =
  | { kind: 'app'; journeyId?: string }
  | { kind: 'studio' }
  | { kind: 'agent'; name: string }
  | { kind: 'app-builder' }
  | { kind: 'unattributed' };

/** The identity/rules lens an operation actually ran under. */
export type AuthLens =
  | { mode: 'admin' }
  | { mode: 'as'; uid: string; token?: Record<string, unknown> }
  | { mode: 'app-session' }
  | { mode: 'anon' };

/** Immutable operation provenance, bound where an operation is issued.
 * Source and auth lens are deliberately orthogonal: Studio may evaluate rules
 * as a user, while an app or agent may use an admin lens. */
export interface OperationContext {
  readonly source: EventActor;
  readonly authLens: AuthLens;
  readonly planId?: string;
}

/** What happened at the Security Rules seam. Admin is a lens; `bypassed` is
 * the rules disposition. */
export type RulesDisposition =
  | { kind: 'evaluated'; verdict: 'allow' | 'deny' }
  | { kind: 'bypassed'; reason: 'admin' }
  | {
      kind: 'not-evaluated';
      reason: 'no-rules' | 'unsupported' | 'not-a-rules-operation' | 'runtime-error';
    };

/** Provenance consumed only by the firestore activity diagnostics. Bundled in
 * one optional record so the shared operation type carries a single
 * activity-owned seam rather than loose per-feature fields. */
export interface ActivityEventProvenance {
  /** Stable host subscription identity used only by activity diagnostics. */
  listenerId?: string;
  /** Marks lifecycle caused by transparent auth reauthorization, not app code. */
  listenerLifecycle?: 'reauthorize';
  /** Marks worker-split operations that belong to a transaction for activity diagnostics. */
  groupKind?: 'transaction';
}

/** Compatibility provenance carried by sandbox events while producers and
 * consumers migrate to the canonical `operationContext`. */
export interface EventProvenance {
  service?: EventService;
  actor?: EventActor;
  authLens?: AuthLens;
  operationContext?: OperationContext;
  /** Set when the op is part of an agent plan. */
  planId?: string;
  /** Firestore activity-diagnostics provenance; absent outside that flow. */
  activity?: ActivityEventProvenance;
}
