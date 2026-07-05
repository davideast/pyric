import type { TrafficEvent, TrafficSource } from '../../../src/traffic/types.js';

/**
 * A manually-driven `TrafficSource` for hook tests — no sandbox
 * dependency. `emit` pushes an event to the subscribed callback;
 * `unsubscribed` reports whether the hook cleaned up.
 */
export function makeFakeSource() {
  let cb: ((event: TrafficEvent) => void) | null = null;
  let unsubscribed = false;

  const source: TrafficSource = (callback) => {
    cb = callback;
    unsubscribed = false;
    return () => {
      unsubscribed = true;
      cb = null;
    };
  };

  return {
    source,
    emit(event: TrafficEvent) {
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

/** Build a `TrafficEvent` with sensible defaults; override per test. */
export function evt(overrides: Partial<TrafficEvent> = {}): TrafficEvent {
  seq += 1;
  return {
    id: `evt-${seq}`,
    at: 1_700_000_000_000 + seq,
    evalMs: 1,
    method: 'get',
    path: 'users/alice',
    auth: { uid: 'alice' },
    result: 'allow',
    reasons: [],
    origin: 'user',
    ...overrides,
  };
}
