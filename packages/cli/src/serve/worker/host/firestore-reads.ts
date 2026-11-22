/**
 * SharedWorker host — Firestore read + aggregate + keyspace ops.
 *
 * The rule-gated read surface: `getDoc`/`getDocs`, the `count`/`aggregate`
 * server aggregations, and the lens-independent keyspace enumeration
 * (`listRootCollections`/`listSubcollections`, the Pyric Studio data browse).
 *
 * Routed here by the host dispatcher (host/dispatch.ts) with the op's resolved
 * Firestore handle (`db` — already lens/session-resolved). This module never
 * imports the dispatcher; it leans only on host-context + host/core.
 */

import {
  doc as pyricDoc,
  getDoc,
  getDocs,
  getCountFromServer,
  getAggregateFromServer,
  type AggregateSpec,
  type Firestore,
  type Query,
} from 'pyric/firestore';
import {
  getDatabaseEnv,
  isFirestoreDatabaseDeclared,
  missingFirestoreDatabaseNotFoundMessage,
} from 'pyric/firestore/internal';
import { SandboxError } from 'pyric/sandbox';
import { sdkActivity } from 'pyric/sandbox/internal';

import { encodeAggregateData, type OpMessage } from '../protocol.js';
import { requestDatabaseId } from '../request-database-id.js';
import { hostProjectId, type HostCtx, type PortLike, ok, fail } from '../host-context.js';
import { resolveTarget, serializeDocSnap } from './core.js';
import { getOrCreatePinnedTxnSnapshot } from './firestore-txn-snapshots.js';

/** The read/aggregate/keyspace op methods routed to {@link handleFirestoreReadOp}. */
const READ_METHODS = new Set<string>([
  'getDoc',
  'getDocs',
  'count',
  'aggregate',
  'listRootCollections',
  'listSubcollections',
]);

export function isFirestoreReadOp(method: OpMessage['method']): boolean {
  return READ_METHODS.has(method);
}

export async function handleFirestoreReadOp(
  ctx: HostCtx,
  port: PortLike,
  msg: OpMessage,
  db: Firestore,
): Promise<void> {
  const { sandbox } = ctx;
  const dbId = requestDatabaseId(msg);
  switch (msg.method) {
    case 'getDoc': {
      try {
        const ref = pyricDoc(db, msg.path);
        const canPin =
          typeof msg.txnId === 'string' &&
          msg.txnId.length > 0 &&
          isFirestoreDatabaseDeclared(sandbox, dbId);
        let snapPromise: Promise<unknown>;
        if (canPin) {
          snapPromise = getDatabaseEnv(sandbox, dbId).withPinnedSnapshot(
            getOrCreatePinnedTxnSnapshot(sandbox, msg.txnId!, dbId),
            () => sdkActivity.silence(() => getDoc(ref)),
          );
        } else {
          snapPromise = sdkActivity.silence(() => getDoc(ref));
        }
        const snap = await snapPromise;
        ok(port, msg.id, serializeDocSnap(snap as Parameters<typeof serializeDocSnap>[0], msg.docValueEncoding));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'getDocs': {
      try {
        const source = resolveTarget(db, msg.source);
        const canPin =
          typeof msg.txnId === 'string' &&
          msg.txnId.length > 0 &&
          isFirestoreDatabaseDeclared(sandbox, dbId);
        let snapPromise: Promise<Awaited<ReturnType<typeof getDocs>>>;
        if (canPin) {
          snapPromise = getDatabaseEnv(sandbox, dbId).withPinnedSnapshot(
            getOrCreatePinnedTxnSnapshot(sandbox, msg.txnId!, dbId),
            () => sdkActivity.silence(() => getDocs(source as Query)),
          );
        } else {
          snapPromise = sdkActivity.silence(() => getDocs(source as Query));
        }
        const snap = await snapPromise;
        const docs = snap.docs.map((d) =>
          serializeDocSnap(d as Parameters<typeof serializeDocSnap>[0], msg.docValueEncoding),
        );
        ok(port, msg.id, { docs });
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'count': {
      try {
        const source = resolveTarget(db, msg.source);
        const snap = await sdkActivity.silence(() => getCountFromServer(source as Query));
        ok(port, msg.id, { count: snap.data().count });
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'aggregate': {
      // Multi-field aggregates (count/sum/average). The wire spec is
      // structurally pyric/firestore's AggregateSpec, so it passes straight
      // through; the reply data is plain numbers / null (empty-input average).
      try {
        const source = resolveTarget(db, msg.source);
        const snap = await sdkActivity.silence(() => getAggregateFromServer(source as Query, msg.spec as AggregateSpec));
        // The sandbox's error-translation adapter wraps result objects in a Proxy.
        // Copy numeric aggregate fields into a cloneable wire result, plus an
        // encoded sidecar when non-finite or -0 values must cross JSON sockets.
        const data = { ...snap.data() };
        const encodedData = encodeAggregateData(data);
        if (encodedData === undefined) {
          ok(port, msg.id, { data });
        } else {
          ok(port, msg.id, { data, encodedData });
        }
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'listRootCollections': {
      try {
        if (dbId !== undefined && !isFirestoreDatabaseDeclared(sandbox, dbId)) {
          throw new SandboxError(
            'not-found',
            missingFirestoreDatabaseNotFoundMessage(dbId, hostProjectId(ctx) ?? 'demo-project'),
          );
        }
        ok(port, msg.id, { ids: getDatabaseEnv(sandbox, dbId).listRootCollections() });
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'listSubcollections': {
      try {
        if (dbId !== undefined && !isFirestoreDatabaseDeclared(sandbox, dbId)) {
          throw new SandboxError(
            'not-found',
            missingFirestoreDatabaseNotFoundMessage(dbId, hostProjectId(ctx) ?? 'demo-project'),
          );
        }
        ok(port, msg.id, { ids: getDatabaseEnv(sandbox, dbId).listSubcollections(msg.docPath) });
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    default: {
      fail(port, msg.id, new Error(`Unknown method: ${String((msg as { method: unknown }).method)}`));
    }
  }
}
