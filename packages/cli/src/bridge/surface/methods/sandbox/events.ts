/**
 * Page through the sandbox's operation log.
 *
 * A cursor is an event id, so it means something only against the log that
 * handed it out. A restore or a reset replaces that log, and a cursor from
 * before it names no event. Starting from the top in that case reads like a
 * continuation and is not one, so a cursor the log does not carry is refused.
 */
import { z } from 'zod';
import {
  toListenerRecord,
  toOperationRecord,
  type AuthState,
  type ListenerLifecycleEvent,
  type OperationRecord,
  type RequestEvent,
  type SandboxEvent,
  type SandboxListenerEvent,
  type SandboxObservationGapEvent,
  type SandboxOperationEvent,
} from 'pyric/sandbox';
import { storageDeniedWrites, type RecordedStorageDeniedWrite } from 'pyric/storage/internal';
import { operationFailure } from '../../sandbox-context.js';
import type { MethodRecord } from '../../method-types.js';

/** Methods the log carries that read state rather than change it. */
const READ_METHODS = new Set(['get', 'list', 'query', 'read', 'download', 'listen']);

type DetailedOperationRecord = OperationRecord & {
  readonly request?: unknown;
  readonly resourceBefore?: unknown;
  readonly resourceAfter?: unknown;
};

type ObservationGapRecord = Readonly<{
  kind: 'observation_gap';
  id: string;
  at: number;
  reason: SandboxObservationGapEvent['reason'];
  omittedCount: number;
  omittedDenials?: number;
  firstEventId: string;
  lastEventId: string;
}>;

type SandboxEventsEntry = DetailedOperationRecord | ObservationGapRecord;

function toObservationGapRecord(event: SandboxObservationGapEvent): ObservationGapRecord {
  const copy: { -readonly [Key in keyof ObservationGapRecord]: ObservationGapRecord[Key] } = {
    kind: 'observation_gap',
    id: event.id,
    at: event.at,
    reason: event.reason,
    omittedCount: event.omittedCount,
    firstEventId: event.firstEventId,
    lastEventId: event.lastEventId,
  };
  if (event.omittedDenials !== undefined) {
    copy.omittedDenials = event.omittedDenials;
  }
  return Object.freeze(copy);
}

function gapAppliesToKind(event: SandboxObservationGapEvent, kind: string): boolean {
  if (kind !== 'denials') return true;
  return event.omittedDenials === undefined || event.omittedDenials > 0;
}

function isObservationGapRecord(entry: SandboxEventsEntry): entry is ObservationGapRecord {
  return 'kind' in entry && entry.kind === 'observation_gap';
}

function formatEventsSummary(events: readonly SandboxEventsEntry[]): string {
  let opCount = 0;
  let gapCount = 0;
  let omittedCount = 0;
  let omittedDenials = 0;
  let hasUntrackedDenials = false;
  for (const entry of events) {
    if (isObservationGapRecord(entry)) {
      gapCount += 1;
      omittedCount += entry.omittedCount;
      if (entry.omittedDenials === undefined) {
        hasUntrackedDenials = true;
      } else {
        omittedDenials += entry.omittedDenials;
      }
    } else {
      opCount += 1;
    }
  }
  if (gapCount === 0) {
    return `${events.length} event(s).`;
  }
  const gapLabel = gapCount === 1 ? 'observation gap' : 'observation gaps';
  if (omittedDenials > 0 && !hasUntrackedDenials) {
    return `${opCount} event(s), ${gapCount} ${gapLabel} (${omittedCount} omitted, including ${omittedDenials} denial(s)).`;
  }
  if (omittedDenials > 0) {
    return `${opCount} event(s), ${gapCount} ${gapLabel} (${omittedCount} omitted, including at least ${omittedDenials} denial(s)).`;
  }
  return `${opCount} event(s), ${gapCount} ${gapLabel} (${omittedCount} omitted).`;
}

function isWrite(record: OperationRecord): boolean {
  return !READ_METHODS.has(record.method);
}

function matchesKind(record: OperationRecord, kind: string): boolean {
  if (kind === 'all') return true;
  if (kind === 'denials') return record.result === 'deny';
  return isWrite(record);
}

function isEvaluatedRulesDenial(record: OperationRecord): boolean {
  return record.rules.kind === 'evaluated' && record.rules.verdict === 'deny';
}

function defineOwnField(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function cloneAndFreezeRecord(source: object): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    defineOwnField(clone, key, cloneAndFreezeValue(entry));
  }
  return Object.freeze(clone);
}

/** Deep-clone and recursively freeze payloads so callers cannot alias live history. */
function cloneAndFreezeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneAndFreezeValue));
  }
  if (value instanceof Date) {
    return Object.freeze(new Date(value.getTime()));
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  return cloneAndFreezeRecord(value);
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!valuesEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aEntries = Object.entries(a);
  const bKeys = Object.keys(b);
  if (aEntries.length !== bKeys.length) return false;
  for (const [key, aVal] of aEntries) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!valuesEqual(aVal, Reflect.get(b, key))) return false;
  }
  return true;
}

function authMatches(a: AuthState | undefined, b: AuthState | undefined): boolean {
  if (a === null || a === undefined) {
    return b === null || b === undefined;
  }
  if (b === null || b === undefined) return false;
  if (a.uid !== b.uid) return false;
  return valuesEqual(a.token, b.token);
}

function firestoreListenerTarget(event: ListenerLifecycleEvent): {
  path: string;
  method: 'get' | 'list';
} {
  if (event.target.kind === 'doc') {
    return { path: event.target.path, method: 'get' };
  }
  return { path: event.target.collection, method: 'list' };
}

/**
 * Find the denied Firestore listener `RequestEvent` immediately preceding one
 * denied `listener_errored` event, without crossing a session boundary, the
 * listener's own attach, a prior errored event, or a non-deny listener read.
 */
function findPairedFirestoreListenerRequest(
  history: readonly SandboxEvent[],
  index: number,
  event: ListenerLifecycleEvent,
  claimed: Set<number>,
): RequestEvent | null {
  const target = firestoreListenerTarget(event);
  for (let j = index - 1; j >= 0; j--) {
    const candidate = history[j];
    if (candidate === undefined) continue;
    if (candidate.kind === 'session_boundary') break;
    if (candidate.kind === 'listener_attach' && candidate.listenerId === event.listenerId) {
      break;
    }
    if (candidate.kind === 'listener_errored') {
      const candidateTarget = firestoreListenerTarget(candidate);
      const sameTarget =
        candidateTarget.path === target.path &&
        candidateTarget.method === target.method &&
        authMatches(candidate.auth, event.auth);
      if (candidate.listenerId === event.listenerId || sameTarget) break;
      continue;
    }
    const sameListenerRequest =
      candidate.kind === 'request' &&
      candidate.origin === 'listener' &&
      candidate.method === target.method &&
      candidate.path === target.path &&
      authMatches(candidate.auth, event.auth);
    if (!sameListenerRequest) continue;
    if (claimed.has(j) || candidate.result !== 'deny') break;
    claimed.add(j);
    return candidate;
  }
  return null;
}

/**
 * Find the denied RTDB `listen` operation event preceding one denied errored
 * RTDB listener event so `detail: true` can carry its request payload.
 */
function findPairedRtdbListenerOperation(
  history: readonly SandboxEvent[],
  index: number,
  event: SandboxListenerEvent,
  claimed: Set<number>,
): SandboxOperationEvent | null {
  const targetPath = event.target.path;
  if (targetPath === undefined) return null;
  for (let j = index - 1; j >= 0; j--) {
    const candidate = history[j];
    if (candidate === undefined) continue;
    if (candidate.kind === 'session_boundary') break;
    if (
      candidate.kind === 'listener' &&
      candidate.service === 'rtdb' &&
      candidate.phase === 'errored' &&
      candidate.target.path === targetPath &&
      candidate.instance === event.instance &&
      authMatches(candidate.auth, event.auth)
    ) {
      break;
    }
    const sameListenerOp =
      candidate.kind === 'operation' &&
      candidate.service === 'rtdb' &&
      candidate.origin === 'listener' &&
      candidate.method === 'listen' &&
      candidate.path === targetPath &&
      candidate.instance === event.instance &&
      authMatches(candidate.auth, event.auth);
    if (!sameListenerOp) continue;
    if (claimed.has(j) || candidate.result !== 'deny') break;
    claimed.add(j);
    return candidate;
  }
  return null;
}

function resolveRtdbDetailSource(
  history: readonly SandboxEvent[],
  index: number,
  event: SandboxEvent,
  record: OperationRecord,
  claimed: Set<number>,
): SandboxEvent {
  const isDeniedRtdbListener =
    event.kind === 'listener' &&
    event.phase === 'errored' &&
    event.service === 'rtdb' &&
    event.result === 'deny' &&
    record.denial !== undefined;
  if (!isDeniedRtdbListener) return event;
  const paired = findPairedRtdbListenerOperation(history, index, event, claimed);
  if (paired !== null) return paired;
  return event;
}

/** Merge correlated Firestore denial metadata onto an errored listener record. */
function enrichFirestoreListenerRecord(
  record: OperationRecord,
  pairedRequest: RequestEvent,
): OperationRecord {
  const pairedRecord = toOperationRecord(pairedRequest);
  if (pairedRecord === null) return record;
  const next: { -readonly [Key in keyof OperationRecord]: OperationRecord[Key] } = { ...record };
  if (pairedRecord.denial !== undefined) next.denial = pairedRecord.denial;
  if (next.queryProof === undefined && pairedRecord.queryProof !== undefined) {
    next.queryProof = pairedRecord.queryProof;
  }
  return Object.freeze(next);
}

/** Opt-in attachment of deep-cloned, frozen request/resource payloads when `detail: true`. */
function attachEventDetail(
  record: OperationRecord,
  sourceEvent: SandboxEvent,
  storageDeniedById: ReadonlyMap<string, RecordedStorageDeniedWrite> | null,
): DetailedOperationRecord {
  const detailed: {
    -readonly [Key in keyof DetailedOperationRecord]: DetailedOperationRecord[Key];
  } = { ...record };
  if (sourceEvent.kind === 'request' || sourceEvent.kind === 'operation') {
    if (sourceEvent.request !== undefined) {
      detailed.request = cloneAndFreezeValue(sourceEvent.request);
    }
    if (sourceEvent.resourceBefore !== undefined) {
      detailed.resourceBefore = cloneAndFreezeValue(sourceEvent.resourceBefore);
    }
    if (sourceEvent.resourceAfter !== undefined) {
      detailed.resourceAfter = cloneAndFreezeValue(sourceEvent.resourceAfter);
    }
  }
  if (
    storageDeniedById !== null &&
    sourceEvent.kind === 'operation' &&
    sourceEvent.service === 'storage'
  ) {
    const recorded = storageDeniedById.get(sourceEvent.id);
    if (recorded !== undefined) {
      if (detailed.request === undefined && recorded.requestResource !== undefined) {
        detailed.request = cloneAndFreezeValue({ resourceData: recorded.requestResource });
      }
      if (detailed.resourceBefore === undefined && recorded.resource !== undefined) {
        detailed.resourceBefore = cloneAndFreezeValue({ data: recorded.resource, exists: true });
      }
    }
  }
  return Object.freeze(detailed);
}

/**
 * The record one event contributes to the requested page, or `null` when the
 * event belongs to a different page. `listeners` reads the lifecycle stream
 * (attach, detach, delivery, suppressed, errored) and nothing else; every
 * other kind reads the operation stream, where lifecycle never appeared.
 */
function recordForKind(
  history: readonly SandboxEvent[],
  index: number,
  kind: string,
  includeDetail: boolean,
  claimed: Set<number>,
  storageDeniedById: ReadonlyMap<string, RecordedStorageDeniedWrite> | null,
): SandboxEventsEntry | null {
  const event = history[index];
  if (event === undefined) return null;
  if (event.kind === 'observation_gap') {
    if (!gapAppliesToKind(event, kind)) return null;
    return toObservationGapRecord(event);
  }
  if (kind === 'listeners') {
    let record = toListenerRecord(event);
    if (record === null) return null;
    let payloadSource: SandboxEvent = event;
    if (event.kind === 'listener_errored' && isEvaluatedRulesDenial(record)) {
      const paired = findPairedFirestoreListenerRequest(history, index, event, claimed);
      if (paired !== null) {
        record = enrichFirestoreListenerRecord(record, paired);
        payloadSource = paired;
      }
    }
    if (!includeDetail) return record;
    if (payloadSource === event) {
      payloadSource = resolveRtdbDetailSource(history, index, event, record, claimed);
    }
    return attachEventDetail(record, payloadSource, storageDeniedById);
  }
  const record = toOperationRecord(event);
  if (record === null) return null;
  if (!matchesKind(record, kind)) return null;
  if (!includeDetail) return record;
  const payloadSource = resolveRtdbDetailSource(history, index, event, record, claimed);
  return attachEventDetail(record, payloadSource, storageDeniedById);
}

export default {
  tool: 'sandbox',
  method: 'events',
  runsIn: 'sandbox',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'events(since?, limit?, kind?: all|denials|writes|listeners, detail?)',
  description: 'Page operation log (since is nextCursor; detail adds payloads). See pyric serve denials.',
  args: z.object({
    since: z.string().optional().describe('The nextCursor a prior call returned.'),
    limit: z.number().int().positive().max(500).optional().describe('Default 50, maximum 500.'),
    kind: z.enum(['all', 'denials', 'writes', 'listeners']).optional(),
    detail: z
      .boolean()
      .optional()
      .describe('Include request, resourceBefore, and resourceAfter payloads. Default false.'),
  }),
  operation: 'list_sandbox_events',
  example: { limit: 20, kind: 'denials' },
  async handler(args, ctx) {
    const since = typeof args.since === 'string' ? args.since : undefined;
    const limit = typeof args.limit === 'number' ? Math.min(args.limit, 500) : 50;
    const kind = typeof args.kind === 'string' ? args.kind : 'all';
    const includeDetail = args.detail === true;

    const history = ctx.sandbox.history();
    let startIndex = 0;
    if (since !== undefined) {
      const at = history.findIndex((event) => event.id === since);
      if (at === -1) {
        return operationFailure(
          `The operation log carries no event '${since}'. Either the log was replaced, by a restore or a reset, or the cursor is not one this sandbox handed out. Call events without 'since' to read the log the sandbox holds now.`,
        );
      }
      startIndex = at + 1;
    }

    let storageDeniedById: ReadonlyMap<string, RecordedStorageDeniedWrite> | null = null;
    if (includeDetail) {
      storageDeniedById = storageDeniedWrites(ctx.sandbox);
    }
    const claimed = new Set<number>();
    const events: SandboxEventsEntry[] = [];
    let lastIndex = startIndex - 1;
    for (let i = startIndex; i < history.length && events.length < limit; i++) {
      lastIndex = i;
      const record = recordForKind(history, i, kind, includeDetail, claimed, storageDeniedById);
      if (record === null) continue;
      events.push(record);
    }
    let nextCursor: string | null = null;
    if (lastIndex >= 0 && lastIndex < history.length - 1) {
      const lastEvent = history[lastIndex];
      if (lastEvent !== undefined) {
        nextCursor = lastEvent.id;
      }
    }

    return {
      ok: true,
      summary: formatEventsSummary(events),
      data: { events, nextCursor },
    };
  },
} satisfies MethodRecord;
