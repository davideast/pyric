/**
 * SharedWorker host — shared resolution layer (host/core.ts).
 *
 * The helpers every firestore-touching family module leans on:
 *   - the auth-lens → live-handle resolvers (`lensDb`/`lensRtdb`/`sessionDb`/…),
 *     the single place a per-op `actAs` lens or a port session becomes a live
 *     Firestore/RTDB handle;
 *   - descriptor → live ref/query resolution (`resolveTarget`/`resolveConstraint`),
 *     used by both the read ops and the subscription handlers;
 *   - cross-port snapshot serialization (`serializeDocSnap`);
 *   - `opProvenance`, the issue-time provenance both the ambient-provenance
 *     window (dispatch) and the storage ops (explicit thread) read.
 *
 * Genuinely-shared STATE lives on `HostCtx` (host-context.ts) — the dependency
 * root. This module adds the shared FUNCTIONS that resolve against that state;
 * it imports the pyric firestore/database engine, so it is deliberately kept
 * out of host-context.ts (which stays engine-free).
 */

import {
  getFirestore as pyricGetFirestore,
  getAdminFirestore as pyricGetAdminFirestore,
  doc as pyricDoc,
  collection as pyricCollection,
  collectionGroup as pyricCollectionGroup,
  query as pyricQuery,
  where as pyricWhere,
  and as pyricAnd,
  or as pyricOr,
  orderBy as pyricOrderBy,
  limit as pyricLimit,
  limitToLast as pyricLimitToLast,
  startAt as pyricStartAt,
  startAfter as pyricStartAfter,
  endAt as pyricEndAt,
  endBefore as pyricEndBefore,
  type Firestore,
  type DocumentReference,
  type CollectionReference,
  type Query,
} from 'pyric/firestore';
import { rehydrateDocValue } from 'pyric/firestore/internal/value-codec';
import {
  getDatabase as pyricGetDatabase,
  getAdminDatabase as pyricGetAdminDatabase,
  type Database,
} from 'pyric/database';
import type { AuthLens, EventProvenance } from 'pyric/sandbox';
import type { MintedSession } from 'pyric/auth';

import type {
  InboundMessage,
  TargetDescriptor,
  QueryConstraintDescriptor,
} from '../protocol.js';
import { serializeDocData } from '../protocol.js';
import { type HostCtx, type PortLike } from '../host-context.js';
import { portSession } from '../host-auth.js';

// ─── Descriptor → live ref resolution ───────────────────────────────────

/**
 * Resolve a TargetDescriptor into a live pyric ref or query.
 *
 * WHY WE RESOLVE ON THE WORKER
 * The client never holds live pyric refs — it holds plain `DocRef`/
 * `CollRef`/`GroupRef`/`QueryDescriptor` objects that serialize cleanly
 * across the MessagePort. On every op the worker rebuilds the live ref
 * from these descriptors. This keeps the client completely stateless with
 * respect to sandbox internals and makes retries trivially correct.
 */
export function resolveTarget(
  db: Firestore,
  target: TargetDescriptor,
): DocumentReference | CollectionReference | Query {
  if (target.__ref === 'doc') {
    return pyricDoc(db, target.path);
  }
  if (target.__ref === 'collection') {
    return pyricCollection(db, target.path);
  }
  if (target.__ref === 'group') {
    return pyricCollectionGroup(db, target.collectionId);
  }
  // query descriptor
  const source = resolveTarget(db, target.source) as CollectionReference | Query;
  const constraints = target.constraints.map((c) => resolveConstraint(c));
  return pyricQuery(source, ...constraints);
}

function resolveConstraint(c: QueryConstraintDescriptor): ReturnType<typeof pyricWhere> {
  switch (c.kind) {
    case 'where':
      // Rehydrate the comparison value (same rationale as prepareWriteData,
      // spike gap 4, applied to READ inputs): over the JSON relay legs a
      // Node-side Timestamp/Bytes/GeoPoint arrives as its marker shape;
      // without rehydration the comparison would see a plain map and the
      // filter would silently mismatch typed stored values.
      return pyricWhere(c.field, c.op as Parameters<typeof pyricWhere>[1], rehydrateDocValue(c.value));
    // Composite filters rebuild through the modular `and`/`or` factories,
    // which validate operands: an empty composite or a nested non-filter
    // throws the same TypeError the in-page SDK raises (surfaces as an
    // error res / snap-error, never a crash).
    case 'and':
      return pyricAnd(...c.filters.map(resolveConstraint));
    case 'or':
      return pyricOr(...c.filters.map(resolveConstraint));
    case 'orderBy':
      return pyricOrderBy(c.field, c.direction);
    case 'limit':
      return pyricLimit(c.n);
    case 'limitToLast':
      return pyricLimitToLast(c.n);
    // Cursor values rehydrate for the same reason as `where` values —
    // `startAfter(<timestamp>)` must position against real Timestamps.
    case 'startAt':
      return pyricStartAt(...c.values.map(rehydrateDocValue));
    case 'startAfter':
      return pyricStartAfter(...c.values.map(rehydrateDocValue));
    case 'endAt':
      return pyricEndAt(...c.values.map(rehydrateDocValue));
    case 'endBefore':
      return pyricEndBefore(...c.values.map(rehydrateDocValue));
  }
}

// ─── Snapshot serialization ───────────────────────────────────────────────

/**
 * Serialize a document snapshot to cross-port form.
 * Uses JSON-via-serializeDocData so Timestamp/Bytes/LatLng survive.
 */
export function serializeDocSnap(snap: {
  id: string;
  path?: string;
  ref?: { path?: string };
  exists: boolean | (() => boolean);
  data(): Record<string, unknown> | undefined;
}): { id: string; path?: string; exists: boolean; data?: { json: string } } {
  const existsBool = typeof snap.exists === 'function' ? snap.exists() : snap.exists;
  const data = existsBool ? snap.data() : undefined;
  return {
    id: snap.id,
    // Doc snapshots carry a top-level `path`; QUERY doc snapshots carry it on
    // `.ref.path`. Read both so query rows serialize their FULL path (Studio's
    // browse resolves the document detail from it).
    path: snap.path ?? snap.ref?.path,
    exists: existsBool,
    data: data ? serializeDocData(data) : undefined,
  };
}

// ─── Auth lens (Pyric Studio) ─────────────────────────────────────────────

/**
 * Resolve the Firestore handle an op runs against, given its `actAs` lens
 * (Pyric Studio auth lens, T2 — implements the C2 protocol seam).
 *
 * Resolution by `actAs.mode` (absent ⇒ the app's session):
 *
 *   - `app-session` (and `actAs` absent): `ctx.db` — the shared sandbox-live
 *     handle. Reads `sandbox.currentUser` per op, so rules evaluate under
 *     whoever the served app is signed in as. This is the unchanged default
 *     and the ONLY lens the app itself ever uses.
 *
 *   - `{ mode: 'as', uid }` (impersonation — the rules-debugging primitive):
 *     a FROZEN-identity `getFirestore(sandbox.withAuth({ uid }))` handle.
 *     Security rules APPLY and evaluate as that user — `request.auth.uid`
 *     resolves to `uid`. This lets Studio "re-run this denied op as the user
 *     who attempted it" (Wave-2 rules-debugging, F4). Handles are cached
 *     per-uid on `ctx.lensHandles`.
 *
 *   - `{ mode: 'admin' }` (rule bypass): a modular `getAdminFirestore(sandbox)`
 *     handle (pyric Gap #2) whose ops skip security-rule evaluation while still
 *     reading/writing the same store and emitting events. This is Studio's
 *     "edit anything as admin" surface (F2). Cached on `ctx.adminDb`.
 *
 *   - `{ mode: 'anon' }` (explicitly unauthenticated): a frozen
 *     `getFirestore(sandbox.withAuth(null))` handle — rules apply with
 *     `request.auth == null`. The remote arm's `withAuth(null)`; distinct from
 *     an ABSENT lens, which resolves to the port's session. Cached on
 *     `ctx.anonDb`.
 *
 * WRITE-IMPERSONATION GATING (open micro-decision #1, honoured): the resolver
 * itself is symmetric — an `{ mode: 'as', uid }` lens applies to BOTH reads and
 * writes (a write-as-user is denied/allowed exactly as that user's rules say).
 * The POLICY decision — "read-as-user always; write-as-user only on an explicit
 * reproduce path" — is enforced at the CALLER (the Studio client / UI chooses
 * when to attach a write op's `actAs`), NOT here. Default behaviour stays admin/
 * app-session unless a caller sets `actAs`; no UI is added by T2.
 */
export function lensDb(ctx: HostCtx, actAs?: AuthLens): Firestore {
  // Absent / app-session → the app's live session handle.
  if (!actAs || actAs.mode === 'app-session') {
    return ctx.db;
  }

  // { mode: 'admin' } → a modular rules-bypass handle (cached per ctx).
  if (actAs.mode === 'admin') {
    return (ctx.adminDb ??= pyricGetAdminFirestore(ctx.sandbox));
  }

  // { mode: 'anon' } → a genuinely UNAUTHENTICATED handle
  // (`withAuth(null)` — `request.auth == null` in rules). NOT the same as an
  // absent lens, which resolves to the PORT'S SESSION: a relayed op that
  // means "no auth" must pin this lens or it silently runs as whoever the
  // browser tab is signed in as.
  if (actAs.mode === 'anon') {
    return (ctx.anonDb ??= pyricGetFirestore(ctx.sandbox.withAuth(null)));
  }

  // { mode: 'as', uid } → a frozen-identity handle; rules evaluate as `uid`.
  const handles = (ctx.lensHandles ??= new Map());
  const key = lensCacheKey(actAs);
  let handle = handles.get(key);
  if (!handle) {
    handle = pyricGetFirestore(ctx.sandbox.withAuth(authStateForLens(actAs)));
    handles.set(key, handle);
  }
  return handle;
}

export function authStateForLens(actAs: Extract<AuthLens, { mode: 'as' }>): { uid: string; token?: Record<string, unknown> } {
  return actAs.token === undefined
    ? { uid: actAs.uid }
    : { uid: actAs.uid, token: actAs.token };
}

export function lensCacheKey(actAs: Extract<AuthLens, { mode: 'as' }>): string {
  return actAs.token === undefined
    ? actAs.uid
    : `${actAs.uid}:${JSON.stringify(actAs.token)}`;
}

/** Cache key for a real port session; claims are part of authorization identity. */
export function sessionCacheKey(session: MintedSession): string {
  return session.state.token === undefined
    ? session.user.uid
    : `${session.user.uid}:${JSON.stringify(session.state.token)}`;
}

/**
 * Normalise a per-op `actAs` lens to the {@link AuthLens} provenance shape that
 * the unified sandbox event stream stamps on each event's `authLens` field.
 *
 * Absent ⇒ `{ mode: 'app-session' }` (the app's own session) — matching how
 * `EventProvenance.authLens` reads when omitted. C1 added the field to events;
 * T1 owns the EMIT path that actually writes it. T2's job is to thread the lens
 * THROUGH the host so T1 has the value at emit time: see the call in `handleOp`
 * where the resolved lens is passed to the sandbox via `withLens` when that
 * emit seam exists. Today the sandbox event emitters infer `authLens` from the
 * acting identity (the impersonation handle's frozen `auth` is `{ uid }`, so a
 * rules eval already carries that uid); this helper exists so the host has a
 * single canonical normaliser when the explicit emit-time stamp lands.
 */
export function lensProvenance(actAs?: AuthLens): AuthLens {
  return actAs ?? { mode: 'app-session' };
}

/**
 * Resolve the data handle for an op/sub carrying NO explicit lens: the
 * PORT'S SESSION (#754). A signed-in port gets a per-session-token cached
 * `getFirestore(sandbox.withAuth(session.state))` handle — rules evaluate
 * under its uid + custom claims, exactly like a globally signed-in user. A
 * signed-out port falls back to `ctx.db` (sandbox-live; `currentUser` is
 * never set in served mode, so that is the unauthenticated view).
 *
 * This is NOT the impersonation lens: the session was minted by validated
 * sign-in on this port (`sandbox.mintSession`), so both reads and writes
 * legitimately run as that user — the write-impersonation gate on the
 * Studio `as` lens does not apply to a port's own session.
 *
 * Claim changes become visible when the client forces an ID-token refresh;
 * host-auth updates the port session, clears all session-bound service
 * caches, and re-establishes that port's listeners under the new token.
 */
export function sessionDb(ctx: HostCtx, port: PortLike): Firestore {
  const session = portSession(ctx, port);
  if (!session) return ctx.db;
  const cache = (ctx.sessionDbs ??= new Map());
  const key = sessionCacheKey(session);
  let handle = cache.get(key);
  if (!handle) {
    handle = pyricGetFirestore(ctx.sandbox.withAuth(session.state));
    cache.set(key, handle);
  }
  return handle;
}

function sessionRtdb(ctx: HostCtx, port: PortLike): Database {
  const session = portSession(ctx, port);
  if (!session) return ensureRtdb(ctx);
  const cache = (ctx.sessionRtdbs ??= new Map());
  const key = sessionCacheKey(session);
  let handle = cache.get(key);
  if (!handle) {
    handle = pyricGetDatabase(ctx.sandbox.withAuth(session.state));
    cache.set(key, handle);
  }
  return handle;
}

export function lensRtdb(ctx: HostCtx, actAs: AuthLens | undefined, port: PortLike): Database {
  if (!actAs || actAs.mode === 'app-session') {
    return sessionRtdb(ctx, port);
  }
  if (actAs.mode === 'admin') {
    return (ctx.adminRtdb ??= pyricGetAdminDatabase(ctx.sandbox));
  }
  // Genuinely unauthenticated — see the `anon` note on lensDb.
  if (actAs.mode === 'anon') {
    return (ctx.anonRtdb ??= pyricGetDatabase(ctx.sandbox.withAuth(null)));
  }

  const handles = (ctx.lensRtdbs ??= new Map());
  const key = lensCacheKey(actAs);
  let handle = handles.get(key);
  if (!handle) {
    handle = pyricGetDatabase(ctx.sandbox.withAuth(authStateForLens(actAs)));
    handles.set(key, handle);
  }
  return handle;
}

export function ensureRtdb(ctx: HostCtx): Database {
  return (ctx.rtdb ??= pyricGetDatabase(ctx.sandbox));
}

// ─── Op provenance ─────────────────────────────────────────────────────────

/**
 * Op provenance from an inbound message, bound at ISSUE time. This is the
 * source of truth for both the synchronous ambient window used by immediate
 * emitters and the operation-scoped Storage handle used across awaits.
 *
 *   - `actor`: a client that DECLARED itself the issuer (`issuer: 'studio'`,
 *     stamped by Studio's worker client — `setOpIssuer` in client.ts) gets
 *     `actor: { kind: 'studio' }`. Bridge-relayed frames are forwarded
 *     with the stamp cleared (client.ts `relayWorkerOp`), so remote traffic
 *     carries `relaySource: 'remote'` and remains unattributed rather than
 *     being silently promoted to either Studio or page app traffic.
 *   - `authLens`: the op's EFFECTIVE lens (`msg.actAs`) whenever present —
 *     independent of issuer, because admin is admin regardless of who asked
 *     (an agent tool relay's admin op must classify as a rules BYPASS in
 *     Traffic, not a rules allow).
 *
 * Plain served-app operations get provenance from their service handles.
 * Firestore subscription registration is the exception: listener lifecycle
 * envelopes originate below that handle, so a normal worker subscription is
 * stamped here as app/app-session. Its later unattributed detach can then be
 * correlated to the accepted registration by the activity monitor.
 */
export function opProvenance(
  msg: InboundMessage,
  activityJourneyId?: string,
): EventProvenance | undefined {
  const issuer = (msg as { issuer?: 'studio' }).issuer;
  const relaySource = (msg as { relaySource?: 'remote' }).relaySource;
  const actAs = (msg as { actAs?: AuthLens }).actAs;
  const target = msg.t === 'sub' ? msg.target : undefined;
  const isAppFirestoreSubscription = issuer !== 'studio'
    && relaySource !== 'remote'
    && target !== null
    && typeof target === 'object'
    && '__ref' in target;
  if (
    issuer !== 'studio'
    && relaySource !== 'remote'
    && !actAs
    && !isAppFirestoreSubscription
    && activityJourneyId === undefined
  ) return undefined;
  return {
    actor: relaySource === 'remote'
      ? { kind: 'unattributed' }
      : issuer === 'studio'
        ? { kind: 'studio' }
        : { kind: 'app', ...(activityJourneyId ? { journeyId: activityJourneyId } : {}) },
    authLens: actAs ?? { mode: 'app-session' },
    ...(isAppFirestoreSubscription
      ? { activity: { listenerId: (msg as { subId: string }).subId } }
      : {}),
    ...(msg.t === 'op' && msg.method === 'getDoc' && msg.activity?.groupKind
      ? { activity: { groupKind: msg.activity.groupKind } }
      : {}),
  };
}
