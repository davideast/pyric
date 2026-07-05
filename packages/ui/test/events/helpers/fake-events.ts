import type {
  ActivityRequestEvent,
  ActivityServiceMutationEvent,
  ActivitySource,
  ActivityWriteEvent,
  AnyActivityEvent,
} from '../../../src/events/types.js';

/**
 * A manually-driven `ActivitySource` for hook tests — no sandbox
 * dependency. `emit` pushes an event to the subscribed callback;
 * `unsubscribed` reports whether the hook cleaned up. Mirrors the
 * traffic area's `makeFakeSource`.
 */
export function makeFakeSource() {
  let cb: ((event: AnyActivityEvent) => void) | null = null;
  let unsubscribed = false;

  const source: ActivitySource = (callback) => {
    cb = callback;
    unsubscribed = false;
    return () => {
      unsubscribed = true;
      cb = null;
    };
  };

  return {
    source,
    emit(event: AnyActivityEvent) {
      cb?.(event);
    },
    get unsubscribed() {
      return unsubscribed;
    },
    get attached() {
      return cb !== null;
    },
  };
}

let seq = 0;
/** A monotonic timestamp so default-built events sort deterministically. */
function nextAt(): number {
  seq += 1;
  return 1_700_000_000_000 + seq * 1000;
}

export function reqEvent(
  overrides: Partial<ActivityRequestEvent> = {},
): ActivityRequestEvent {
  return {
    kind: 'request',
    id: `req-${++seq}`,
    at: nextAt(),
    method: 'create',
    path: 'notes/n1',
    auth: { uid: 'alice' },
    result: 'allow',
    reasons: [],
    origin: 'user',
    ...overrides,
  };
}

export function writeEvent(
  overrides: Partial<ActivityWriteEvent> = {},
): ActivityWriteEvent {
  return {
    kind: 'write',
    id: `wr-${++seq}`,
    at: nextAt(),
    method: 'create',
    path: 'notes/n1',
    auth: { uid: 'alice' },
    priorState: null,
    nextState: { title: 'Untitled' },
    ...overrides,
  };
}

export function svcEvent(
  overrides: Partial<ActivityServiceMutationEvent> = {},
): ActivityServiceMutationEvent {
  return {
    kind: 'service_mutation',
    id: `svc-${++seq}`,
    at: nextAt(),
    service: 'auth',
    op: 'sign_in',
    path: 'alice',
    auth: { uid: 'alice' },
    ...overrides,
  };
}

/** An unmodelled event the digest must skip (e.g. a listener attach). */
export function unmodelledEvent(): AnyActivityEvent {
  return {
    kind: 'listener_attach',
    id: `lst-${++seq}`,
    at: nextAt(),
    listenerId: 'l1',
  };
}
