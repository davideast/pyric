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
  type ListenerLifecycleEvent,
  type OperationRecord,
  type RequestEvent,
  type SandboxEvent,
  type SandboxListenerEvent,
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

function isWrite(record: OperationRecord): boolean {
  return !READ_METHODS.has(record.method);
}

function matchesKind(record: OperationRecord, kind: string): boolean {
  if (kind === 'all') return true;
  if (kind === 'denials') return record.result === 'deny';
  return isWrite(record);
}

function authUid(auth: SandboxEvent extends { auth?: infer A } ? A : unknown): string | null {
  if (auth !== null && typeof auth === 'object' && 'uid' in auth && typeof auth.uid === 'string') {
    return auth.uid;
  }
  return null;
}

/**
 * Find the denied Firestore listener `RequestEvent` immediately preceding one
 * `listener_errored` event, without crossing a session reset boundary.
 */
function findPairedFirestoreListenerRequest(
  history: readonly SandboxEvent[],
  index: number,
  event: ListenerLifecycleEvent,
  claimed: Set<number>,
): RequestEvent | null {
  let targetPath: string;
  let expectedMethod: 'get' | 'list';
  if (event.target.kind === 'doc') {
    targetPath = event.target.path;
    expectedMethod = 'get';
  } else {
    targetPath = event.target.collection;
    expectedMethod = 'list';
  }
  const uid = authUid(event.auth);
  for (let j = index - 1; j >= 0; j--) {
    const candidate = history[j];
    if (candidate === undefined) continue;
    if (candidate.kind === 'session_boundary') break;
    if (claimed.has(j)) continue;
    const matchesRequest =
      candidate.kind === 'request' &&
      candidate.origin === 'listener' &&
      candidate.result === 'deny' &&
      candidate.method === expectedMethod &&
      candidate.path === targetPath &&
      authUid(candidate.auth) === uid;
    if (matchesRequest) {
      claimed.add(j);
      return candidate;
    }
  }
  return null;
}

/**
 * Find the denied RTDB `listen` operation event preceding one errored RTDB
 * listener event so `detail: true` can carry its request payload when present.
 */
function findPairedRtdbListenerOperation(
  history: readonly SandboxEvent[],
  index: number,
  event: SandboxListenerEvent,
  claimed: Set<number>,
): SandboxOperationEvent | null {
  const targetPath = event.target.path;
  if (targetPath === undefined) return null;
  const uid = authUid(event.auth);
  for (let j = index - 1; j >= 0; j--) {
    const candidate = history[j];
    if (candidate === undefined) continue;
    if (candidate.kind === 'session_boundary') break;
    if (claimed.has(j)) continue;
    const matchesOp =
      candidate.kind === 'operation' &&
      candidate.service === 'rtdb' &&
      candidate.origin === 'listener' &&
      candidate.method === 'listen' &&
      candidate.result === 'deny' &&
      candidate.path === targetPath &&
      authUid(candidate.auth) === uid;
    if (matchesOp) {
      claimed.add(j);
      return candidate;
    }
  }
  return null;
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

/** Opt-in attachment of request/resource payloads when `detail: true`. */
function attachEventDetail(
  record: OperationRecord,
  sourceEvent: SandboxEvent,
  storageDeniedById: ReadonlyMap<string, RecordedStorageDeniedWrite> | null,
): DetailedOperationRecord {
  const detailed: {
    -readonly [Key in keyof DetailedOperationRecord]: DetailedOperationRecord[Key];
  } = { ...record };
  if (sourceEvent.kind === 'request' || sourceEvent.kind === 'operation') {
    if (sourceEvent.request !== undefined) detailed.request = sourceEvent.request;
    if (sourceEvent.resourceBefore !== undefined) {
      detailed.resourceBefore = sourceEvent.resourceBefore;
    }
    if (sourceEvent.resourceAfter !== undefined) {
      detailed.resourceAfter = sourceEvent.resourceAfter;
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
        detailed.request = { resourceData: recorded.requestResource };
      }
      if (detailed.resourceBefore === undefined && recorded.resource !== undefined) {
        detailed.resourceBefore = { data: recorded.resource, exists: true };
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
): DetailedOperationRecord | null {
  const event = history[index];
  if (event === undefined) return null;
  if (kind === 'listeners') {
    let record = toListenerRecord(event);
    if (record === null) return null;
    let payloadSource: SandboxEvent = event;
    if (event.kind === 'listener_errored') {
      const paired = findPairedFirestoreListenerRequest(history, index, event, claimed);
      if (paired !== null) {
        record = enrichFirestoreListenerRecord(record, paired);
        payloadSource = paired;
      }
    } else if (event.kind === 'listener' && event.phase === 'errored' && event.service === 'rtdb') {
      const paired = findPairedRtdbListenerOperation(history, index, event, claimed);
      if (paired !== null) payloadSource = paired;
    }
    if (!includeDetail) return record;
    return attachEventDetail(record, payloadSource, storageDeniedById);
  }
  const record = toOperationRecord(event);
  if (record === null) return null;
  if (!matchesKind(record, kind)) return null;
  if (!includeDetail) return record;
  let payloadSource: SandboxEvent = event;
  if (event.kind === 'listener' && event.phase === 'errored' && event.service === 'rtdb') {
    const paired = findPairedRtdbListenerOperation(history, index, event, claimed);
    if (paired !== null) payloadSource = paired;
  }
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
    const events: DetailedOperationRecord[] = [];
    let lastIndex = startIndex - 1;
    for (let i = startIndex; i < history.length && events.length < limit; i++) {
      lastIndex = i;
      const record = recordForKind(history, i, kind, includeDetail, claimed, storageDeniedById);
      if (record === null) continue;
      events.push(record);
    }
    const hasMore = lastIndex < history.length - 1;
    const nextCursor = hasMore ? history[lastIndex]!.id : null;

    return {
      ok: true,
      summary: `${events.length} event(s).`,
      data: { events, nextCursor },
    };
  },
} satisfies MethodRecord;
