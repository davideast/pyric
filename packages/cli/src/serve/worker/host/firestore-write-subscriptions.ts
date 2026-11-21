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
  DocumentLifecycleTracker,
  type FirestoreDocumentTransition,
} from '../../../functions/firestore/document-change.js';
import { WriteGroupCoalescer } from '../../../functions/firestore/write-coalescer.js';
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

type FirestoreWriteStreamAuthType =
  | 'service_account'
  | 'api_key'
  | 'system'
  | 'unauthenticated'
  | 'unknown';

const VALID_WRITE_STREAM_AUTH_TYPES: ReadonlySet<string> = new Set([
  'service_account',
  'api_key',
  'system',
  'unauthenticated',
  'unknown',
]);

function isWriteStreamAuthType(value: unknown): value is FirestoreWriteStreamAuthType {
  return typeof value === 'string' && VALID_WRITE_STREAM_AUTH_TYPES.has(value);
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
  authType?: FirestoreWriteStreamAuthType;
  authId?: string;
  updateMask?: readonly string[];
  groupId?: string;
  groupKind?: 'batch' | 'transaction';
}

export type FirestoreWriteStreamSnapWire =
  | { readonly kind: 'ready' }
  | { readonly kind: 'mutation'; readonly mutation: FirestoreWriteStreamMutationWire };

interface RawWriteMeta {
  readonly timeMs: number;
  readonly requestTime: FirestoreSerializedTimestamp;
  readonly authUid: string | null;
  readonly admin: boolean;
  readonly authLensMode: AuthLens['mode'] | null;
  authType?: FirestoreWriteStreamAuthType;
  authId?: string;
  groupId?: string;
  groupKind?: 'batch' | 'transaction';
}

interface WriteStreamHub {
  readonly tracker: DocumentLifecycleTracker;
  readonly subscribers: Set<(mutation: RawCoalescedWrite) => void>;
}

interface RawCoalescedWrite {
  readonly transition: FirestoreDocumentTransition;
  readonly meta: RawWriteMeta;
}

const hubsByCtx = new WeakMap<HostCtx, WriteStreamHub>();

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
  tracker: DocumentLifecycleTracker,
): void {
  tracker.clear();
  for (const rawEvent of ctx.sandbox.history()) {
    if (!isWriteEvent(rawEvent)) continue;
    tracker.seedFromWrite(
      eventDatabaseOf(rawEvent),
      rawEvent.path,
      rawEvent.priorState,
      rawEvent.nextState,
      rawEvent.requestTime,
    );
  }
}

function ensureWriteStreamHub(ctx: HostCtx): WriteStreamHub {
  const existing = hubsByCtx.get(ctx);
  if (existing !== undefined) return existing;

  const tracker = new DocumentLifecycleTracker();
  seedTimestampsFromHistory(ctx, tracker);

  const hub: WriteStreamHub = {
    tracker,
    subscribers: new Set(),
  };
  hubsByCtx.set(ctx, hub);

  const coalescer = new WriteGroupCoalescer<RawWriteMeta>((commit) => {
    if (commit.meta === undefined) return;
    const transition = tracker.applyWrite(
      commit.database,
      commit.document,
      commit.before,
      commit.after,
      commit.commitTime,
    );
    if (transition === null) return;
    const coalesced: RawCoalescedWrite = {
      transition,
      meta: commit.meta,
    };
    for (const subscriber of hub.subscribers) {
      try {
        subscriber(coalesced);
      } catch {
        // Observational isolation: one broken subscriber cannot block others.
      }
    }
  });

  ctx.sandbox.onEvent((rawEvent) => {
    if (rawEvent.kind === 'session_boundary') {
      coalescer.reset();
      tracker.clear();
      return;
    }
    if (!isWriteEvent(rawEvent)) return;

    const lensMode = rawEvent.authLens?.mode ?? null;
    const isAdmin = rawEvent.detail?.admin === true || lensMode === 'admin';
    const authUid = rawEvent.auth !== null ? rawEvent.auth.uid : null;
    const detail = rawEvent.detail as
      | { readonly authType?: unknown; readonly authId?: unknown }
      | undefined;
    const meta: RawWriteMeta = {
      timeMs: rawEvent.at,
      requestTime: rawEvent.requestTime,
      authUid,
      admin: isAdmin,
      authLensMode: lensMode,
    };
    if (isWriteStreamAuthType(detail?.authType)) {
      meta.authType = detail.authType;
    }
    if (typeof detail?.authId === 'string' && detail.authId.length > 0) {
      meta.authId = detail.authId;
    }
    if (rawEvent.groupId !== undefined) {
      meta.groupId = rawEvent.groupId;
    }
    if (rawEvent.groupKind !== undefined) {
      meta.groupKind = rawEvent.groupKind;
    }

    coalescer.push({
      database: eventDatabaseOf(rawEvent),
      document: rawEvent.path,
      before: rawEvent.priorState,
      after: rawEvent.nextState,
      commitTime: rawEvent.requestTime,
      groupId: rawEvent.groupId,
      meta,
    });
  });

  return hub;
}

function toWireVersion(
  version: {
    readonly fields: Record<string, unknown>;
    readonly createTime: FirestoreSerializedTimestamp;
    readonly updateTime: FirestoreSerializedTimestamp;
  } | null,
  encoding: ResponseDocValueEncoding,
): FirestoreWriteStreamVersionWire | null {
  if (version === null) return null;
  return {
    data: serializeDocData(version.fields, encoding),
    createTime: version.createTime,
    updateTime: version.updateTime,
  };
}

/** Re-seed timestamp history after checkpoint restore or state import. */
export function refreshFirestoreWriteStreamTimestamps(ctx: HostCtx): void {
  const hub = hubsByCtx.get(ctx);
  if (hub === undefined) return;
  seedTimestampsFromHistory(ctx, hub.tracker);
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
    const { transition, meta } = raw;
    if (targetDatabase !== undefined && transition.database !== targetDatabase) {
      return;
    }
    const mutation: FirestoreWriteStreamMutationWire = {
      database: transition.database,
      document: transition.document,
      before: toWireVersion(transition.before, encoding),
      after: toWireVersion(transition.after, encoding),
      timeMs: meta.timeMs,
      requestTime: meta.requestTime,
      authUid: meta.authUid,
      admin: meta.admin,
      authLensMode: meta.authLensMode,
    };
    if (transition.updateMask.length > 0) {
      mutation.updateMask = transition.updateMask;
    }
    if (meta.authType !== undefined) {
      mutation.authType = meta.authType;
    }
    if (meta.authId !== undefined) {
      mutation.authId = meta.authId;
    }
    if (meta.groupId !== undefined) {
      mutation.groupId = meta.groupId;
    }
    if (meta.groupKind !== undefined) {
      mutation.groupKind = meta.groupKind;
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
