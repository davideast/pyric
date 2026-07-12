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
import { getInternalEnv } from 'pyric/sandbox/internal';

import type { OpMessage } from '../protocol.js';
import { type HostCtx, type PortLike, ok, fail } from '../host-context.js';
import { resolveTarget, serializeDocSnap } from './core.js';

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
  switch (msg.method) {
    case 'getDoc': {
      try {
        const ref = pyricDoc(db, msg.path);
        const snap = await getDoc(ref);
        ok(port, msg.id, serializeDocSnap(snap as Parameters<typeof serializeDocSnap>[0]));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'getDocs': {
      try {
        const source = resolveTarget(db, msg.source);
        // CollectionReference is always also queryable — getDocs accepts Query<T>
        // and CollectionReference is structurally compatible at runtime even though
        // the type system doesn't know that (CollectionReference has no `_isQuery`
        // brand). Cast through Query to satisfy the type checker.
        const snap = await getDocs(source as Query);
        const docs = snap.docs.map((d) =>
          serializeDocSnap(d as Parameters<typeof serializeDocSnap>[0]),
        );
        ok(port, msg.id, { docs });
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'count': {
      try {
        const source = resolveTarget(db, msg.source);
        const snap = await getCountFromServer(source as Query);
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
        const snap = await getAggregateFromServer(source as Query, msg.spec as AggregateSpec);
        ok(port, msg.id, { data: snap.data() });
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'listRootCollections': {
      // Keyspace enumeration (Pyric Studio data browse). Lens-independent: it
      // lists the collection ids present, not rule-gated reads.
      try {
        ok(port, msg.id, { ids: getInternalEnv(sandbox).listRootCollections() });
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'listSubcollections': {
      try {
        ok(port, msg.id, { ids: getInternalEnv(sandbox).listSubcollections(msg.docPath) });
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    default: {
      fail(port, msg.id, new Error(`Unknown method: ${String((msg as { method: unknown }).method)}`));
    }
  }
}
