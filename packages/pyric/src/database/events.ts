/**
 * What the Realtime Database surface puts on the sandbox event stream as a
 * cross-service mutation. The surface's rich typed `operation`, `commit`, and
 * `listener` events are declared on the event union itself; this record covers
 * the generic mutation envelope only.
 */
import type { ServiceEventRecord } from '../sandbox/types/service-event-record.js';

export const RTDB_EVENT_RECORD = {
  service: 'rtdb',
  operations: ['set', 'update', 'remove', 'transaction', 'setPriority'],
  target: {
    name: 'path',
    description: 'The database path the call targeted, e.g. /rooms/r1/messages.',
    always: true,
  },
} as const satisfies ServiceEventRecord;

/** Every mutation operation the Realtime Database surface emits. */
export type RtdbEventOperation = (typeof RTDB_EVENT_RECORD)['operations'][number];
