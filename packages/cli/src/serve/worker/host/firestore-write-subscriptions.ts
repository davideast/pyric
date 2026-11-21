/**
 * SharedWorker host - Firestore committed-write stream subscription for
 * isolated Cloud Functions v2 document triggers (`service: 'firestore.writes'`).
 *
 * Delivers `{ kind: 'ready' }` upon subscription establishment (without
 * replaying `sandbox.history()` as trigger executions) and forwards live
 * `WriteSandboxEvent` mutations with preserved `createTime`/`updateTime`
 * continuity, `(groupId, path)` batch/transaction coalescing, and `actAs`/`auth`
 * attribution over JSON-safe `snap` frames.
 */
import type { AuthLens, SandboxEvent, WriteSandboxEvent } from 'pyric/sandbox';
import {
  DOC_VALUE_ENCODING,
  serializeDocData,
  type FirestoreWriteSubMessage,
  type ResponseDocValueEncoding,
  type SerializedDocData,
} from '../protocol.js';
import { post, type HostCtx, type PortLike } from '../host-context.js';

interface FirestoreSerializedTimestamp {
  readonly seconds: number;
  readonly nanoseconds: number;
}

export interface FirestoreWriteStreamVersionWire {
  readonly data: SerializedDocData;
  readonly createTime: FirestoreSerializedTimestamp;
  readonly updateTime: FirestoreSerializedTimestamp;
}

export interface FirestoreWriteStreamMutationWire {
  readonly database: string;
  readonly document: string;
  readonly before: FirestoreWriteStreamVersionWire | null;
  readonly after: FirestoreWriteStreamVersionWire | null;
  readonly timeMs: number;
  readonly requestTime: FirestoreSerializedTimestamp;
  readonly authUid: string | null;
  readonly admin: boolean;
  readonly authLensMode: AuthLens['mode'] | null;
  groupId?: string;
  groupKind?: 'batch' | 'transaction';
}

export type FirestoreWriteStreamSnapWire =
  | { readonly kind: 'ready' }
  | { readonly kind: 'mutation'; readonly mutation: FirestoreWriteStreamMutationWire };

interface DocTimestampEntry {
  readonly createTime: FirestoreSerializedTimestamp;
  readonly updateTime: FirestoreSerializedTimestamp;
}

interface PendingGroupedWrite {
  readonly database: string;
  readonly path: string;
  readonly firstPriorState: Record<string, unknown> | null;
  lastNextState: Record<string, unknown> | null;
  lastEvent: WriteSandboxEvent & { authLens?: AuthLens };
}

interface WriteStreamHub {
  readonly timestamps: Map<string, DocTimestampEntry>;
  readonly subscribers: Set<(mutation: RawCoalescedWrite) => void>;
}

interface RawCoalescedWrite {
  readonly database: string;
  readonly document: string;
  readonly priorState: Record<string, unknown> | null;
  readonly nextState: Record<string, unknown> | null;
  readonly beforeTimes: DocTimestampEntry | null;
  readonly afterTimes: DocTimestampEntry | null;
  readonly timeMs: number;
  readonly requestTime: FirestoreSerializedTimestamp;
  readonly authUid: string | null;
  readonly admin: boolean;
  readonly authLensMode: AuthLens['mode'] | null;
  groupId?: string;
  groupKind?: 'batch' | 'transaction';
}

const hubsByCtx = new WeakMap<HostCtx, WriteStreamHub>();

function docTimestampKey(database: string, path: string): string {
  return `${database}\u0000${path}`;
}

function eventDatabaseOf(event: WriteSandboxEvent): string {
  const detail = event.detail as
    | { readonly databaseId?: unknown; readonly database?: unknown }
    | undefined;
  if (typeof detail?.databaseId === 'string' && detail.databaseId.length > 0) {
    return detail.databaseId;
  }
  if (typeof detail?.database === 'string' && detail.database.length > 0) {
    return detail.database;
  }
  return '(default)';
}

function isWriteEvent(
  event: SandboxEvent,
): event is WriteSandboxEvent & { authLens?: AuthLens } {
  return event.kind === 'write';
}

function seedTimestampsFromHistory(
  ctx: HostCtx,
  timestamps: Map<string, DocTimestampEntry>,
): void {
  timestamps.clear();
  for (const rawEvent of ctx.sandbox.history()) {
    if (!isWriteEvent(rawEvent)) continue;
    const database = eventDatabaseOf(rawEvent);
    const key = docTimestampKey(database, rawEvent.path);
    if (rawEvent.nextState === null) {
      timestamps.delete(key);
    } else {
      const prior = timestamps.get(key);
      let createTime = rawEvent.requestTime;
      if (rawEvent.priorState !== null && prior !== undefined) {
        createTime = prior.createTime;
      }
      timestamps.set(key, {
        createTime,
        updateTime: rawEvent.requestTime,
      });
    }
  }
}

function finalizeCoalescedWrite(
  hub: WriteStreamHub,
  database: string,
  path: string,
  priorState: Record<string, unknown> | null,
  nextState: Record<string, unknown> | null,
  sourceEvent: WriteSandboxEvent & { authLens?: AuthLens },
): void {
  if (priorState === null && nextState === null) {
    return;
  }
  const key = docTimestampKey(database, path);
  const existingTimes = hub.timestamps.get(key);
  let beforeTimes: DocTimestampEntry | null = null;
  if (priorState !== null) {
    beforeTimes = existingTimes ?? {
      createTime: sourceEvent.requestTime,
      updateTime: sourceEvent.requestTime,
    };
  }

  let afterTimes: DocTimestampEntry | null = null;
  if (nextState !== null) {
    let createTime = sourceEvent.requestTime;
    if (priorState !== null && existingTimes !== undefined) {
      createTime = existingTimes.createTime;
    }
    afterTimes = {
      createTime,
      updateTime: sourceEvent.requestTime,
    };
    hub.timestamps.set(key, afterTimes);
  } else {
    hub.timestamps.delete(key);
  }

  const lensMode = sourceEvent.authLens?.mode ?? null;
  const isAdmin = sourceEvent.detail?.admin === true || lensMode === 'admin';
  const authUid = sourceEvent.auth !== null ? sourceEvent.auth.uid : null;

  const coalesced: RawCoalescedWrite = {
    database,
    document: path,
    priorState,
    nextState,
    beforeTimes,
    afterTimes,
    timeMs: sourceEvent.at,
    requestTime: sourceEvent.requestTime,
    authUid,
    admin: isAdmin,
    authLensMode: lensMode,
    groupId: sourceEvent.groupId,
    groupKind: sourceEvent.groupKind,
  };

  for (const subscriber of hub.subscribers) {
    try {
      subscriber(coalesced);
    } catch {
      // Observational isolation: one broken subscriber cannot block others.
    }
  }
}

function ensureWriteStreamHub(ctx: HostCtx): WriteStreamHub {
  const existing = hubsByCtx.get(ctx);
  if (existing !== undefined) return existing;

  const timestamps = new Map<string, DocTimestampEntry>();
  seedTimestampsFromHistory(ctx, timestamps);

  const hub: WriteStreamHub = {
    timestamps,
    subscribers: new Set(),
  };
  hubsByCtx.set(ctx, hub);

  const pendingGroups = new Map<string, Map<string, PendingGroupedWrite>>();

  ctx.sandbox.onEvent((rawEvent) => {
    if (rawEvent.kind === 'session_boundary') {
      pendingGroups.clear();
      timestamps.clear();
      return;
    }
    if (!isWriteEvent(rawEvent)) return;

    const database = eventDatabaseOf(rawEvent);
    const groupId = rawEvent.groupId;
    if (groupId === undefined) {
      finalizeCoalescedWrite(
        hub,
        database,
        rawEvent.path,
        rawEvent.priorState,
        rawEvent.nextState,
        rawEvent,
      );
      return;
    }

    let groupEntries = pendingGroups.get(groupId);
    if (groupEntries === undefined) {
      groupEntries = new Map<string, PendingGroupedWrite>();
      pendingGroups.set(groupId, groupEntries);
      queueMicrotask(() => {
        const flushed = pendingGroups.get(groupId);
        pendingGroups.delete(groupId);
        if (flushed === undefined) return;
        for (const entry of flushed.values()) {
          finalizeCoalescedWrite(
            hub,
            entry.database,
            entry.path,
            entry.firstPriorState,
            entry.lastNextState,
            entry.lastEvent,
          );
        }
      });
    }

    const docKey = docTimestampKey(database, rawEvent.path);
    const priorPending = groupEntries.get(docKey);
    if (priorPending === undefined) {
      groupEntries.set(docKey, {
        database,
        path: rawEvent.path,
        firstPriorState: rawEvent.priorState,
        lastNextState: rawEvent.nextState,
        lastEvent: rawEvent,
      });
    } else {
      priorPending.lastNextState = rawEvent.nextState;
      priorPending.lastEvent = rawEvent;
    }
  });

  return hub;
}

function toWireVersion(
  state: Record<string, unknown> | null,
  times: DocTimestampEntry | null,
  encoding: ResponseDocValueEncoding,
): FirestoreWriteStreamVersionWire | null {
  if (state === null || times === null) return null;
  return {
    data: serializeDocData(state, encoding),
    createTime: times.createTime,
    updateTime: times.updateTime,
  };
}

/** Re-seed timestamp history after checkpoint restore or state import. */
export function refreshFirestoreWriteStreamTimestamps(ctx: HostCtx): void {
  const hub = hubsByCtx.get(ctx);
  if (hub === undefined) return;
  seedTimestampsFromHistory(ctx, hub.timestamps);
}

/** Register a `firestore.writes` subscription on `port`. */
export function registerFirestoreWriteSubscription(
  ctx: HostCtx,
  port: PortLike,
  msg: FirestoreWriteSubMessage,
): () => void {
  const hub = ensureWriteStreamHub(ctx);
  const encoding: ResponseDocValueEncoding = msg.docValueEncoding ?? DOC_VALUE_ENCODING;
  const targetDatabase = msg.target.database;

  const listener = (raw: RawCoalescedWrite): void => {
    if (targetDatabase !== undefined && raw.database !== targetDatabase) {
      return;
    }
    const mutation: FirestoreWriteStreamMutationWire = {
      database: raw.database,
      document: raw.document,
      before: toWireVersion(raw.priorState, raw.beforeTimes, encoding),
      after: toWireVersion(raw.nextState, raw.afterTimes, encoding),
      timeMs: raw.timeMs,
      requestTime: raw.requestTime,
      authUid: raw.authUid,
      admin: raw.admin,
      authLensMode: raw.authLensMode,
    };
    if (raw.groupId !== undefined) {
      mutation.groupId = raw.groupId;
    }
    if (raw.groupKind !== undefined) {
      mutation.groupKind = raw.groupKind;
    }
    const snapValue: FirestoreWriteStreamSnapWire = {
      kind: 'mutation',
      mutation,
    };
    post(port, { t: 'snap', subId: msg.subId, value: snapValue });
  };

  hub.subscribers.add(listener);
  const readyFrame: FirestoreWriteStreamSnapWire = { kind: 'ready' };
  post(port, { t: 'snap', subId: msg.subId, value: readyFrame });

  return () => {
    hub.subscribers.delete(listener);
  };
}
