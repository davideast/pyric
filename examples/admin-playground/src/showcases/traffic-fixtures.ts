import type { TrafficEvent, TrafficSource } from '@pyric/ui/traffic';

/**
 * A hand-built traffic buffer for the showcase — a realistic mix of
 * user ops, a batch group, a listener re-eval run, allows + denies,
 * and varied matched rules so every traffic component has something
 * to render.
 */
const BASE = 1_715_000_000_000;
let n = 0;
function mk(e: Partial<TrafficEvent> & Pick<TrafficEvent, 'method' | 'path' | 'result'>): TrafficEvent {
  n += 1;
  return {
    id: `fixture-${n}`,
    at: BASE + n * 1100,
    evalMs: 1 + Math.random() * 3,
    auth: { uid: 'alice_uid' },
    reasons: [],
    origin: 'user',
    ...e,
  };
}

export const TRAFFIC_FIXTURE: TrafficEvent[] = [
  mk({
    method: 'get',
    path: 'events/zEQ93H91qc788',
    result: 'allow',
    matchedRule: { ruleIndex: 0, operations: ['read'] },
    reasons: ['Rule #0 (read) → ALLOW'],
    resourceBefore: { data: { name: 'Launch party', capacity: 50 }, exists: true },
  }),
  mk({
    method: 'update',
    path: 'events/zEQ93H91qc788',
    result: 'deny',
    matchedRule: { ruleIndex: 2, operations: ['update'] },
    reasons: ['Rule #2 (update) → deny'],
    request: { resourceData: { attendeeCount: 2 } },
    resourceBefore: { data: { name: 'Launch party', attendeeCount: 1 }, exists: true },
    resourceAfter: { data: { name: 'Launch party', attendeeCount: 2 }, exists: true },
  }),
  mk({
    method: 'create',
    path: 'rsvps/zEQ93H91qc788_alice_uid',
    result: 'allow',
    matchedRule: { ruleIndex: 4, operations: ['create'] },
    reasons: ['Rule #4 (create) → ALLOW'],
    request: { resourceData: { uid: 'alice_uid', status: 'going' } },
  }),
  mk({
    method: 'set',
    path: 'events/zEQ93H91qc788',
    result: 'allow',
    matchedRule: { ruleIndex: 1, operations: ['write'] },
    reasons: ['Rule #1 (write) → ALLOW'],
  }),
  // A batch group — three sub-ops sharing a groupId.
  mk({
    method: 'create',
    path: 'events/DyDVlDJAmFV7',
    result: 'allow',
    origin: 'batch',
    groupId: 'batch-7f3',
    matchedRule: { ruleIndex: 4, operations: ['create'] },
    reasons: ['Rule #4 (create) → ALLOW'],
  }),
  mk({
    method: 'create',
    path: 'rsvps/DyDVlDJAmFV7_alice_uid',
    result: 'allow',
    origin: 'batch',
    groupId: 'batch-7f3',
    matchedRule: { ruleIndex: 4, operations: ['create'] },
    reasons: ['Rule #4 (create) → ALLOW'],
  }),
  mk({
    method: 'update',
    path: 'events/DyDVlDJAmFV7',
    result: 'deny',
    origin: 'batch',
    groupId: 'batch-7f3',
    matchedRule: { ruleIndex: 2, operations: ['update'] },
    reasons: ['Rule #2 (update) → deny'],
  }),
  // A listener re-eval run — five re-evals from one originating write.
  ...Array.from({ length: 5 }, (_, i) =>
    mk({
      method: 'get',
      path: `events/seed-${i}`,
      result: 'allow',
      origin: 'listener',
      matchedRule: { ruleIndex: 0, operations: ['read'] },
      reasons: ['Rule #0 (read) → ALLOW'],
      triggeredBy: { method: 'create', path: 'events/DyDVlDJAmFV7' },
    }),
  ),
  mk({
    method: 'get',
    path: 'events/poMz0HGOqZcBwxY7',
    result: 'allow',
    matchedRule: { ruleIndex: 0, operations: ['read'] },
    reasons: ['Rule #0 (read) → ALLOW'],
  }),
  mk({
    method: 'update',
    path: 'rsvps/poMz0HGOqZcBwxY7_alice_uid',
    result: 'deny',
    matchedRule: { ruleIndex: 5, operations: ['update'] },
    reasons: ['Rule #5 (update) → deny'],
    request: { resourceData: { status: 'maybe' } },
  }),
  mk({
    method: 'update',
    path: 'events/poMz0HGOqZcBwxY7',
    result: 'deny',
    matchedRule: { ruleIndex: 2, operations: ['update'] },
    reasons: ['Rule #2 (update) → deny'],
  }),
  mk({
    method: 'create',
    path: 'rsvps/poMz0HGOqZcBwxY7_alice_uid',
    result: 'allow',
    matchedRule: { ruleIndex: 4, operations: ['create'] },
    reasons: ['Rule #4 (create) → ALLOW'],
  }),
  mk({
    method: 'delete',
    path: 'rsvps/poMz0HGOqZcBwxY7_alice_uid',
    result: 'unsupported',
    reasons: ['simulator hit an unmodelled feature'],
  }),
];

/**
 * A `TrafficSource` that replays the fixture buffer on an interval —
 * lets the showcase demonstrate `useTrafficMonitor`'s live buffering,
 * pause/resume, and counts. Loops forever.
 */
export function makeReplaySource(intervalMs = 700): TrafficSource {
  return (cb) => {
    let i = 0;
    const timer = setInterval(() => {
      const event = TRAFFIC_FIXTURE[i % TRAFFIC_FIXTURE.length];
      // Fresh id + timestamp each loop so the buffer keeps growing.
      cb({ ...event, id: `${event.id}-${i}`, at: Date.now() });
      i += 1;
    }, intervalMs);
    return () => clearInterval(timer);
  };
}
