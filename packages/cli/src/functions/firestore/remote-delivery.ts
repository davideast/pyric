/**
 * Remote worker-channel delivery adapter subscribing to `service: 'firestore.writes'`
 * for isolated Cloud Functions v2 Firestore triggers.
 */
import type { RemoteSandboxChannel } from '../../remote/index.js';
import type {
  FirestoreWriteStreamMutationWire,
  FirestoreWriteStreamSnapWire,
  FirestoreWriteStreamVersionWire,
} from '../../serve/worker/host/firestore-write-subscriptions.js';
import {
  DOC_VALUE_ENCODING,
  deserializeDocData,
} from '../../serve/worker/protocol.js';
import type {
  FirestoreDeliveryCallbacks,
  FirestoreMutationRecord,
  FirestoreTriggerDelivery,
} from './delivery.js';
import type {
  FirestoreDocumentVersion,
  FirestoreTriggerAuthType,
} from './event.js';
import {
  FirestoreReferenceValue,
  type FirestoreTimestampProto,
} from './proto-encoder.js';

function toTimestampProto(raw: {
  readonly seconds: number;
  readonly nanoseconds: number;
}): FirestoreTimestampProto {
  return {
    seconds: raw.seconds,
    nanos: raw.nanoseconds,
  };
}

function formatTimestampIso(ts: {
  readonly seconds: number;
  readonly nanoseconds: number;
}): string {
  const baseIso = new Date(ts.seconds * 1_000).toISOString();
  const prefix = baseIso.slice(0, 19);
  if (ts.nanoseconds === 0) {
    return `${prefix}.000Z`;
  }
  const paddedNanos = String(ts.nanoseconds).padStart(9, '0');
  const trimmedNanos = paddedNanos.replace(/0+$/, '');
  const fractional = trimmedNanos.length < 3 ? trimmedNanos.padEnd(3, '0') : trimmedNanos;
  return `${prefix}.${fractional}Z`;
}

function decodeWireVersion(
  wire: FirestoreWriteStreamVersionWire | null,
  database: string,
): FirestoreDocumentVersion | null {
  if (wire === null) return null;
  const decoded = deserializeDocData(wire.data, {
    create: (path, databaseId) => new FirestoreReferenceValue(path, databaseId ?? database),
  });
  let fields: Record<string, unknown> = {};
  if (typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded)) {
    fields = decoded as Record<string, unknown>;
  }
  return {
    fields,
    createTime: toTimestampProto(wire.createTime),
    updateTime: toTimestampProto(wire.updateTime),
  };
}

function resolveMutationAuth(wire: FirestoreWriteStreamMutationWire): {
  authType: FirestoreTriggerAuthType;
  authId?: string;
} {
  if (wire.admin) {
    return { authType: 'service_account' };
  }
  if (wire.authUid !== null) {
    return { authType: 'unknown', authId: wire.authUid };
  }
  if (wire.authLensMode === 'anon') {
    return { authType: 'unauthenticated' };
  }
  return { authType: 'unauthenticated' };
}

function isWriteStreamSnap(value: unknown): value is FirestoreWriteStreamSnapWire {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'ready' || kind === 'mutation';
}

export class RemoteFirestoreTriggerDelivery implements FirestoreTriggerDelivery {
  readonly #channel: Pick<RemoteSandboxChannel, 'subscribe'>;

  constructor(channel: Pick<RemoteSandboxChannel, 'subscribe'>) {
    this.#channel = channel;
  }

  subscribe(database: string, callbacks: FirestoreDeliveryCallbacks): () => void {
    let readyReported = false;
    return this.#channel.subscribe(
      {
        target: { service: 'firestore.writes', database },
        actAs: { mode: 'admin' },
        docValueEncoding: DOC_VALUE_ENCODING,
      },
      (rawSnap) => {
        if (!isWriteStreamSnap(rawSnap)) return;
        if (rawSnap.kind === 'ready') {
          if (!readyReported) {
            readyReported = true;
            callbacks.onReady?.();
          }
          return;
        }
        const wire = rawSnap.mutation;
        const auth = resolveMutationAuth(wire);
        const record: FirestoreMutationRecord = {
          database: wire.database,
          document: wire.document,
          before: decodeWireVersion(wire.before, wire.database),
          after: decodeWireVersion(wire.after, wire.database),
          time: formatTimestampIso(wire.requestTime),
          authType: auth.authType,
        };
        if (auth.authId !== undefined) {
          record.authId = auth.authId;
        }
        callbacks.onMutation(record);
      },
      (error) => {
        callbacks.onError?.(error);
      },
    );
  }
}
