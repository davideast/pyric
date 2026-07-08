/**
 * SharedWorker protocol — message types + wire serialization.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * All traffic between an in-page client and the SharedWorker host travels
 * over a `MessagePort`. Structured clone handles the envelope (plain objects,
 * numbers, strings). Firestore's special scalar types (Timestamp, Bytes,
 * GeoPoint/LatLng) are NOT structured-cloneable as class instances — they
 * must be serialized to plain marker objects for the port crossing and
 * re-hydrated on the other side.
 *
 * We use the persistence serializer's codec for doc DATA:
 *   serialize:   JSON.stringify(data)  — toJSON() on each wrapper emits a
 *                marker shape ({ __type: 'timestamp', seconds, nanos } etc.)
 *   deserialize: JSON.parse → rehydrateDocValue (from pyric/sandbox) — walks
 *                the tree and reconstructs REAL class instances (Timestamp,
 *                Bytes, LatLng) so instanceof checks and method calls work.
 *
 * This is the SAME codec the sandbox uses for IndexedDB persistence, so the
 * wire format == the persistence format and values round-trip to real instances
 * on BOTH sides of the port.
 *
 * Sentinels (serverTimestamp, increment, arrayUnion, arrayRemove, deleteField)
 * are FieldValue objects that DO cross the port as plain marker objects that
 * the worker's sandbox resolves natively — the sandbox sentinel-capture code
 * recognizes them by shape.
 *
 * SURFACE SPLIT
 * -------------
 * Client-side only (never cross the port):
 *   doc, collection, collectionGroup, query, where, and, or, orderBy, limit,
 *   limitToLast, startAt, startAfter, endAt, endBefore
 *   → return plain RefDescriptor / QueryDescriptor objects.
 *   getFirestore → returns a ClientDb holding the MessagePort.
 *
 * Sentinels (client-side markers, resolved by the worker's sandbox):
 *   serverTimestamp, increment, arrayUnion, arrayRemove, deleteField
 *   → return SentinelMarker objects that embed in write data.
 *
 * Execution (RPC):
 *   getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
 *   onSnapshot, getCountFromServer, runTransaction, writeBatch().commit()
 */

// LEAF import — the value codec only, NOT `pyric/sandbox`. Importing the
// codec from the standalone `pyric/firestore-values` module keeps the
// SharedWorker CLIENT bundle (every serve page) free of the rules/sandbox
// engine (~10 MB). The worker HOST (`entry.ts`/`host.ts`) still imports the
// full library — it IS the backend — but the client path stays lean.
import { rehydrateDocValue } from 'pyric/firestore-values';
// TYPE-ONLY (erased at build, so the leaf client bundle stays engine-free).
// The auth-lens contract and the cross-service event envelope are shared with
// the sandbox's event provenance — Studio's Action Center folds these verbatim.
import type { AuthLens, SandboxEvent } from 'pyric/sandbox';

// ─── Ref descriptors (client-side, never cross the port directly) ──────────

/**
 * A serializable reference to a Firestore document path. Produced by
 * `doc()` on the client; embedded in op/sub messages for the worker to
 * resolve against the real sandbox.
 */
export interface DocRef {
  readonly __ref: 'doc';
  readonly path: string;
}

/**
 * A serializable reference to a collection path. Produced by `collection()`.
 */
export interface CollRef {
  readonly __ref: 'collection';
  readonly path: string;
}

/**
 * A serializable collectionGroup descriptor. Produced by `collectionGroup()`.
 */
export interface GroupRef {
  readonly __ref: 'group';
  readonly collectionId: string;
}

/**
 * A serializable query descriptor. Wraps a source ref with a constraint list.
 * Constraints encode `where`/`orderBy`/`limit`/`limitToLast`/`startAt`/
 * `startAfter`/`endAt`/`endBefore` as plain data so they can be rebuilt on
 * the worker side by calling the pyric/firestore constraint factories.
 */
export interface QueryDescriptor {
  readonly __ref: 'query';
  readonly source: DocRef | CollRef | GroupRef;
  readonly constraints: readonly QueryConstraintDescriptor[];
}

/**
 * Plain data representation of a FILTER constraint — the subset of
 * constraints valid at a query's top level AND inside composite `and`/`or`
 * filters (orderBy/limit/cursors are not filters). Mirrors the modular SDK's
 * `where()` / `and(...)` / `or(...)` composition: composites nest arbitrarily,
 * and the worker rebuilds them with the pyric/firestore `and`/`or` factories.
 */
export type FilterConstraintDescriptor =
  | { kind: 'where'; field: string; op: string; value: unknown }
  | { kind: 'and'; filters: readonly FilterConstraintDescriptor[] }
  | { kind: 'or'; filters: readonly FilterConstraintDescriptor[] };

/** Plain data representation of a query constraint. */
export type QueryConstraintDescriptor =
  | FilterConstraintDescriptor
  | { kind: 'orderBy'; field: string; direction?: 'asc' | 'desc' }
  | { kind: 'limit'; n: number }
  | { kind: 'limitToLast'; n: number }
  | { kind: 'startAt'; values: unknown[]; isSnapshot?: false }
  | { kind: 'startAfter'; values: unknown[]; isSnapshot?: false }
  | { kind: 'endAt'; values: unknown[]; isSnapshot?: false }
  | { kind: 'endBefore'; values: unknown[]; isSnapshot?: false };

export type TargetDescriptor = DocRef | CollRef | GroupRef | QueryDescriptor;

// ─── Sentinel markers (cross the port embedded in write data) ─────────────

/**
 * Wire representation of a FieldValue sentinel. The worker's sandbox
 * resolves these via FieldValue factories before writing — the sentinel
 * objects themselves are structurally identical to what `pyric/sandbox/
 * admin-compat`'s FieldValue class produces, so they round-trip naturally.
 *
 * We use a `__sentinel` discriminator instead of relying on class identity
 * (class instances aren't reliably transferred across message ports as class
 * instances — the structured clone algorithm produces plain objects).
 */
export type SentinelMarker =
  | { readonly __sentinel: 'serverTimestamp' }
  | { readonly __sentinel: 'increment'; readonly n: number }
  | { readonly __sentinel: 'arrayUnion'; readonly values: unknown[] }
  | { readonly __sentinel: 'arrayRemove'; readonly values: unknown[] }
  | { readonly __sentinel: 'deleteField' };

export function isSentinelMarker(v: unknown): v is SentinelMarker {
  return (
    v !== null &&
    typeof v === 'object' &&
    '__sentinel' in (v as object) &&
    typeof (v as { __sentinel: unknown }).__sentinel === 'string'
  );
}

// ─── Write descriptors for batch + transaction ────────────────────────────

export type WriteDescriptor =
  | { method: 'set'; path: string; data: unknown; options?: { merge?: boolean; mergeFields?: string[] } }
  | { method: 'update'; path: string; data: unknown }
  | { method: 'delete'; path: string };

/**
 * One entry in the read-set sent by the client on `txnCommit`.
 *
 * The client records every doc it read during `updateFn` (via `txn.get`)
 * along with the serialized data it saw at read time (`data` is the
 * `SerializedDocData` the worker returned, or `null` if the doc didn't
 * exist). The worker re-reads each path inside a real sandbox transaction
 * and deep-compares by re-serializing the current state to the same JSON
 * form — any mismatch means another tab wrote the doc between our read and
 * commit, so we abort and let the client retry `updateFn`.
 */
export interface TxnReadEntry {
  /** Firestore path of the document that was read. */
  path: string;
  /**
   * The serialized doc data seen by the client at read time.
   * `null` means the document did not exist when the client read it.
   */
  data: SerializedDocData | null;
}

// ─── Serialized auth user (crosses the port) ──────────────────────────────

/**
 * Wire representation of a signed-in `User`. The real `pyric/auth` `User`
 * carries methods (`getIdToken`, `getIdTokenResult`) that don't survive
 * structured clone, so the worker flattens the fields the client mirror
 * needs into a plain object. Token accessors on the client re-RPC to the
 * worker (the worker holds the one real user).
 *
 * `null` means "signed out" — there is no current user.
 */
export interface SerializedUser {
  readonly uid: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly displayName: string | null;
  readonly photoURL: string | null;
  readonly phoneNumber: string | null;
  readonly isAnonymous: boolean;
  readonly providerId: string | null;
  readonly providerData: ReadonlyArray<{
    readonly displayName: string | null;
    readonly email: string | null;
    readonly phoneNumber: string | null;
    readonly photoURL: string | null;
    readonly providerId: string;
    readonly uid: string;
  }>;
}

/**
 * A provider identity resolved IN-PAGE (by the `ServeAuthHelper`'s
 * popup/redirect picker) and handed to the worker for sign-in. Provider flows
 * (`signInWithPopup`/`signInWithRedirect`) can't cross the worker port — the
 * `AuthFlowResolver` lives in-page — so the page resolves the picked identity
 * and bridges it here; the worker seeds it + `restoreSession`s it (no password
 * — provider users never sign in with one). See `auth.acceptIdentity`.
 */
export interface ResolvedIdentity {
  readonly uid: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly customClaims: Record<string, unknown>;
  readonly providerId: string;
}

/** Wire form of a `UserCredential` returned by the sign-in/create ops. */
export interface SerializedUserCredential {
  readonly user: SerializedUser;
  readonly providerId: string | null;
  readonly operationType: 'signIn' | 'reauthenticate' | 'link';
}

/** Wire form of `getIdTokenResult()`. */
export interface SerializedIdTokenResult {
  readonly token: string;
  readonly claims: Record<string, unknown>;
  readonly expirationTime: string;
  readonly issuedAtTime: string;
  readonly authTime: string;
  readonly signInProvider: string | null;
}

/**
 * Flatten a live `pyric/auth` `User` (or `null`) into its wire form.
 * Methods are dropped; only the structured fields cross the port.
 */
export function serializeUser(
  user: {
    uid: string;
    email: string | null;
    emailVerified?: boolean;
    displayName: string | null;
    photoURL?: string | null;
    phoneNumber?: string | null;
    isAnonymous: boolean;
    providerId?: string;
    providerData?: ReadonlyArray<{
      displayName: string | null;
      email: string | null;
      phoneNumber: string | null;
      photoURL: string | null;
      providerId: string;
      uid: string;
    }>;
  } | null,
): SerializedUser | null {
  if (!user) return null;
  return {
    uid: user.uid,
    email: user.email,
    emailVerified: user.emailVerified ?? false,
    displayName: user.displayName,
    photoURL: user.photoURL ?? null,
    phoneNumber: user.phoneNumber ?? null,
    isAnonymous: user.isAnonymous,
    providerId: user.providerId ?? null,
    providerData: (user.providerData ?? []).map((p) => ({
      displayName: p.displayName,
      email: p.email,
      phoneNumber: p.phoneNumber,
      photoURL: p.photoURL,
      providerId: p.providerId,
      uid: p.uid,
    })),
  };
}

/**
 * Persistence mode for the worker's shared auth session.
 * Mirrors `pyric/auth`'s `Persistence.type`. `'NONE'` (inMemoryPersistence)
 * disables the IndexedDB session record so a full close does NOT keep the
 * user signed in; `'LOCAL'` and `'SESSION'` both persist the session in
 * this single-backend model (see SESSION/LOCAL collapse note in host.ts).
 */
export type AuthPersistenceMode = 'LOCAL' | 'SESSION' | 'NONE';

// ─── Runtime confirm-policy (Pyric Studio F3 — permission dial) ────────────

/**
 * The four `ConfirmPolicy` levels the bridge's governance engine recognises.
 * Mirrors `pyric-tools/src/bridge/server/confirm-policy.ts`'s `ConfirmPolicy`
 * and Studio's `permission-dial/policy.ts` — kept structurally identical so a
 * `PolicyRequest` produced by the dial crosses the port without translation.
 */
export type ConfirmPolicy = 'never' | 'session' | 'always' | 'deny';

/**
 * Per-tool override knobs. Structurally identical to the bridge's
 * `PolicyOverrides` (confirm-policy.ts) so `buildPolicyMap(base, overrides)`
 * consumes a wire `PolicyRequest.overrides` verbatim.
 */
export interface PolicyOverrides {
  autoApprove?: string[];
  requireConfirm?: string[];
  requireConfirmAll?: boolean;
  fallback?: ConfirmPolicy;
}

/**
 * The confirm-policy descriptor the permission dial pushes (Pyric Studio F3).
 *
 * Structurally identical to `@pyric/studio`'s `permission-dial/policy.ts`
 * `PolicyRequest` — that module's `toPolicyRequest(mode)` produces exactly this
 * shape, and it crosses the MessagePort unchanged (all plain JSON, no class
 * instances). The worker stores the latest one (see the `set-policy` op + the
 * host's runtime policy store) so a consumer can read back the active governance
 * the served sandbox/agent runtime should honour.
 *
 * HONEST SCOPE NOTE (bridge-process limitation):
 * The interactive confirm-policy that gates AGENT TOOL CALLS lives in the bridge
 * — a SEPARATE node process (the MCP server), built once at bridge startup and
 * held in a closure (`createInteractiveConfirmHandler`). The SharedWorker is
 * browser-resident and does NOT host that handler, so `set-policy` here updates a
 * WORKER-SIDE store (the source of truth Studio reflects + a future in-worker
 * agent runtime would consult); it does NOT reach into a running bridge process.
 * Pushing a live policy to an already-running bridge is a separate transport
 * (an HTTP control route on `pyric dev`, or a bridge restart) and is out of
 * scope for the worker data-plane. This store is the additive, honest seam.
 */
export interface PolicyRequest {
  /** Which bridge mode the policy runs under. Studio v1 only emits `sandbox`. */
  bridgeMode: 'sandbox' | 'prod';
  /** Which base map the bridge builds from. */
  base: 'sandbox' | 'prod-defaults';
  /** Overrides merged onto the base. */
  overrides: PolicyOverrides;
  /** Fallback policy for tools not in the base map. */
  fallback: ConfirmPolicy;
}

// ─── One-shot op messages (client → worker) ───────────────────────────────

/**
 * All one-shot operation messages share the `t:'op'` discriminator and a
 * correlation `id` that the worker echoes back in the `res` reply.
 */
export type OpMessage = (
  | { t: 'op'; id: string; method: 'getDoc'; path: string }
  | { t: 'op'; id: string; method: 'getDocs'; source: TargetDescriptor }
  | { t: 'op'; id: string; method: 'setDoc'; path: string; data: unknown; options?: { merge?: boolean; mergeFields?: string[] } }
  | { t: 'op'; id: string; method: 'updateDoc'; path: string; data: unknown }
  | { t: 'op'; id: string; method: 'deleteDoc'; path: string }
  | { t: 'op'; id: string; method: 'addDoc'; collectionPath: string; data: unknown }
  | { t: 'op'; id: string; method: 'count'; source: TargetDescriptor }
  | { t: 'op'; id: string; method: 'batchCommit'; writes: WriteDescriptor[] }
  | { t: 'op'; id: string; method: 'txnCommit'; reads: TxnReadEntry[]; writes: WriteDescriptor[] }
  | { t: 'op'; id: string; method: 'setRules'; source: string }
  | { t: 'op'; id: string; method: 'setFirestoreRules'; source: string }
  | { t: 'op'; id: string; method: 'setDatabaseRules'; source: unknown }
  | { t: 'op'; id: string; method: 'getActiveRules'; service?: 'firestore' | 'database' }
  | { t: 'op'; id: string; method: 'getRulesStatus'; service?: 'firestore' | 'database' }
  | { t: 'op'; id: string; method: 'admin.getDocument'; path: string }
  | { t: 'op'; id: string; method: 'admin.listDocuments'; path: string }
  | { t: 'op'; id: string; method: 'admin.setDocument'; path: string; data: unknown }
  | { t: 'op'; id: string; method: 'admin.deleteDocument'; path: string }
  | { t: 'op'; id: string; method: 'admin.readState'; path?: string; maxDepth?: number }
  | { t: 'op'; id: string; method: 'rtdb.get'; path: string }
  | { t: 'op'; id: string; method: 'rtdb.set'; path: string; value: unknown }
  | { t: 'op'; id: string; method: 'rtdb.update'; path: string; values: Record<string, unknown> }
  | { t: 'op'; id: string; method: 'rtdb.remove'; path: string }
  | { t: 'op'; id: string; method: 'rtdb.push'; path: string; key: string; value?: unknown }
  | { t: 'op'; id: string; method: 'rtdb.adminSnapshot' }
  // Collection enumeration (Pyric Studio data browse): the modular SDK has no
  // client `listCollections`, so the host enumerates the sandbox keyspace via
  // `getInternalEnv(sandbox)`. Reply: `{ ids: string[] }`.
  | { t: 'op'; id: string; method: 'listRootCollections' }
  | { t: 'op'; id: string; method: 'listSubcollections'; docPath: string }
  // ── Auth ops (surface: 'auth') ──────────────────────────────────────────
  | { t: 'op'; id: string; method: 'auth.createUser'; email: string; password: string }
  | { t: 'op'; id: string; method: 'auth.signInEmail'; email: string; password: string }
  | { t: 'op'; id: string; method: 'auth.signInAnonymously' }
  | { t: 'op'; id: string; method: 'auth.signOut' }
  | { t: 'op'; id: string; method: 'auth.getIdToken'; forceRefresh?: boolean }
  | { t: 'op'; id: string; method: 'auth.getIdTokenResult'; forceRefresh?: boolean }
  | { t: 'op'; id: string; method: 'auth.setPersistence'; mode: AuthPersistenceMode }
  | { t: 'op'; id: string; method: 'auth.getCurrentUser' }
  // Update THIS PORT's signed-in user's profile (displayName / photoURL).
  // Mirrors `firebase/auth`'s `updateProfile(user, profile)`. `null` clears a
  // field, an absent field leaves it untouched. Reply: the updated
  // SerializedUser (so the client mirror stays consistent).
  | { t: 'op'; id: string; method: 'auth.updateProfile'; displayName?: string | null; photoURL?: string | null }
  // Per-tab session restore (#754): re-establish THIS PORT's session for an
  // existing identity (the uid the page persisted in web storage). Soft — the
  // reply value is the serialized user, or null when the uid no longer
  // resolves (deleted / disabled), so a stale record just means signed out.
  | { t: 'op'; id: string; method: 'auth.restorePortSession'; uid: string }
  // Provider sign-in bridge: identity resolved in-page, signed in on the worker.
  | { t: 'op'; id: string; method: 'auth.acceptIdentity'; identity: ResolvedIdentity }
  // Admin user-DB ops (Pyric Studio data browse): mirror `pyric/auth`'s
  // `sandbox.{listUsers,createUser,updateUser,deleteUser,clearUsers}` over the
  // port. Records are plain JSON (AuthUserRecord); requests are plain objects.
  | { t: 'op'; id: string; method: 'auth.listUsers' }
  | { t: 'op'; id: string; method: 'auth.adminCreateUser'; request: Record<string, unknown> }
  | { t: 'op'; id: string; method: 'auth.adminUpdateUser'; uid: string; request: Record<string, unknown> }
  | { t: 'op'; id: string; method: 'auth.adminDeleteUser'; uid: string }
  | { t: 'op'; id: string; method: 'auth.adminClearUsers' }
  // Storage ops (Pyric Studio data browse + pyric-admin remote arm): mirror
  // `pyric/storage` over the port. The ref is a path; `listAll` replies with
  // plain `{ fullPath, name }` entries, `getMetadata` with the plain
  // `FullMetadata`, and `getBlob` with a structured-cloneable browser Blob.
  // All storage ops honor the shared `actAs` lens (admin ⇒ rules bypass via
  // `pyric/storage/internal`'s admin plane; `{ as: uid }` ⇒ rules evaluate as
  // that uid; absent ⇒ the worker's anonymous page handle).
  | { t: 'op'; id: string; method: 'storage.listAll'; path: string }
  | { t: 'op'; id: string; method: 'storage.getMetadata'; path: string }
  | { t: 'op'; id: string; method: 'storage.getBlob'; path: string }
  // Byte-carrying storage ops (remote sandbox, slice 2). Bytes travel as
  // BASE64 STRINGS (`dataB64`) inside the op payload/result so ONE encoding
  // survives both the MessagePort (structured clone) and the two JSON WS
  // relay legs verbatim — Blob/ArrayBuffer/TypedArray silently corrupt under
  // `JSON.stringify` ({} / index-keyed objects), which is why `getBlob` must
  // NEVER be relayed (see the bridge client's binary-payload guard). Raw
  // payloads are capped at {@link MAX_STORAGE_OP_BYTES} on BOTH the encode
  // and decode ends. `metadata` carries `pyric/storage` `SettableMetadata`
  // fields (contentType/cacheControl/…/customMetadata); GCS-style nested
  // custom maps (`metadata.metadata`) are folded into `customMetadata`.
  | { t: 'op'; id: string; method: 'storage.putBytes'; path: string; dataB64: string; contentType?: string; metadata?: Record<string, unknown> }
  | { t: 'op'; id: string; method: 'storage.getBytes'; path: string }
  | { t: 'op'; id: string; method: 'storage.deleteObject'; path: string }
  // Staleness guard: report the worker's baked build version so the page can
  // warn when a still-running OLD worker serves code older than what's served.
  | { t: 'op'; id: string; method: 'getVersion' }
  // ── Phase 2 (transfer): export/import the FULL sandbox state as a bundle
  // string (the chunk format the persist layer uses). importState CLOBBERS. ──
  | { t: 'op'; id: string; method: 'exportState' }
  | { t: 'op'; id: string; method: 'importState'; bundle: string }
  // ── Phase 3 (named branches): save/list/switch/delete named state bundles.
  // switchBranch CLOBBERS the live sandbox with the branch's state. ──
  | { t: 'op'; id: string; method: 'saveBranch'; name: string }
  | { t: 'op'; id: string; method: 'listBranches' }
  | { t: 'op'; id: string; method: 'switchBranch'; name: string }
  | { t: 'op'; id: string; method: 'deleteBranch'; name: string }
  // ── Runtime confirm-policy (Pyric Studio F3 — permission dial) ───────────
  // set-policy stores the dial's `PolicyRequest` in the worker-side policy
  // store (the host's runtime governance the served sandbox/agent consults);
  // get-policy reads the active one back (or null when the dial hasn't set one).
  // NEVER lensed — these operate worker control state, not data. See the
  // bridge-process limitation note on `PolicyRequest`.
  | { t: 'op'; id: string; method: 'setPolicy'; policy: PolicyRequest }
  | { t: 'op'; id: string; method: 'getPolicy' }
  // Export the sandbox snapshot (Pyric Studio rules re-run): Studio forks it
  // locally to test a denied op against edited rules / re-issue as the user, all
  // on a throwaway branch (no live mutation). The reply is the serializable
  // `SandboxSnapshot` (the persistence format).
  | { t: 'op'; id: string; method: 'getSnapshot' }
) & {
  /**
   * Per-op auth lens (Pyric Studio): `admin` bypasses rules, `{ as: uid }`
   * evaluates rules as that user (impersonation), `anon` runs genuinely
   * UNAUTHENTICATED (`withAuth(null)` — the remote arm's "no auth", which an
   * absent lens does NOT mean: absent ⇒ the app's session, i.e. whoever the
   * browser tab is signed in as). The host resolves the data handle from
   * this — see `lensDb` in `host.ts`. Additive: existing senders omit it.
   * Plain tagged union → structured-clones.
   */
  actAs?: AuthLens;
};

// ─── Subscription messages (client → worker) ─────────────────────────────

/** Register a Firestore snapshot listener for a doc or query. The worker
 *  fires `{ t:'snap', subId, value }` immediately (initial) and on each
 *  update. */
export interface FirestoreSubMessage {
  t: 'sub';
  subId: string;
  target: TargetDescriptor;
  /**
   * Per-subscription auth lens (Pyric Studio F4 — "watch as user"). Mirrors
   * the per-op `actAs` on {@link OpMessage}: `{ mode: 'as', uid }` registers the
   * listener through the impersonation data handle so the snapshot's initial
   * fire AND every re-eval evaluate security rules AS that uid; `{ mode: 'admin' }`
   * watches through the rule-bypass handle; `{ mode: 'anon' }` watches genuinely
   * unauthenticated (`withAuth(null)`); absent / `{ mode: 'app-session' }`
   * watches as the app's own session (the unchanged default).
   *
   * The host resolves the listener's data handle from this via the SAME
   * `lensDb` path ops use (`host.ts`), so "re-run a denied watch as the user who
   * hit it" reuses the impersonation seam. Additive: existing senders omit it,
   * so the wire message is byte-identical and existing subs don't regress.
   */
  actAs?: AuthLens;
}

/**
 * Register an AUTH listener (cross-tab auth — the headline of Phase 2).
 *
 * `target: 'authState'` mirrors `onAuthStateChanged`; `target: 'idToken'`
 * mirrors `onIdTokenChanged`. The worker registers ONE real sandbox auth
 * listener and fans out the new current user to EVERY subscribed port —
 * so a sign-in on any tab updates every tab live. The `snap.value` is a
 * `SerializedUser | null` (signed-out → null).
 */
export interface AuthSubMessage {
  t: 'sub';
  subId: string;
  target: 'authState' | 'idToken';
}

/**
 * Subscribe to the sandbox's unified cross-service EVENT STREAM (Pyric Studio
 * keystone — Action Center / traffic / rules-debug denial feed).
 *
 * `target: 'events'` mirrors `sandbox.onEvent(cb)`. On subscribe the host
 * immediately delivers `sandbox.history()` (every event so far) as ONE
 * `{ t:'event', subId, events: [...] }` batch, then streams each subsequent
 * `SandboxEvent` as a single-element batch. Multiple Studio/app ports may
 * subscribe; the host owns the ONE sandbox + ONE `onEvent` subscription and
 * fans out to every subscribed port (same pattern as auth fan-out).
 *
 * Every `SandboxEvent` is plain JSON (provenance-stamped, marker-shaped doc
 * data — no class instances), so it structured-clones across the port verbatim;
 * no codec round-trip is needed (unlike Firestore doc data).
 */
export interface EventSubMessage {
  t: 'sub';
  subId: string;
  target: 'events';
}

export interface RtdbValueSubMessage {
  t: 'sub';
  subId: string;
  target: { service: 'rtdb'; path: string };
  /** Mirrors Firestore subscriptions: absent/app-session uses this port's session. */
  actAs?: AuthLens;
}

export type SubMessage = FirestoreSubMessage | AuthSubMessage | EventSubMessage | RtdbValueSubMessage;

/** Type guard: is this an auth subscription (vs a Firestore / event one)? */
export function isAuthSub(msg: SubMessage): msg is AuthSubMessage {
  return msg.target === 'authState' || msg.target === 'idToken';
}

/** Type guard: is this an event-stream subscription? */
export function isEventSub(msg: SubMessage): msg is EventSubMessage {
  return msg.target === 'events';
}

export function isRtdbSub(msg: SubMessage): msg is RtdbValueSubMessage {
  return (
    typeof msg.target === 'object' &&
    msg.target !== null &&
    'service' in msg.target &&
    msg.target.service === 'rtdb'
  );
}

/** Tear down a previously registered snapshot listener. */
export interface UnsubMessage {
  t: 'unsub';
  subId: string;
}

/**
 * Agent tool-call, forwarded by the bridge peer to the worker so the agent
 * executes against the SAME sandbox the app + Studio use (no separate in-page
 * backend). The worker host runs the canonical sandbox tool dispatcher and
 * replies with a `ResMessage` whose `value` is the `{ ok, summary, data }`
 * dispatch result. Keeps app, Studio, and agent on one authoritative instance.
 */
export interface ToolMessage {
  t: 'tool';
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type InboundMessage = OpMessage | SubMessage | UnsubMessage | ToolMessage;

// ─── Worker → client messages ─────────────────────────────────────────────

/**
 * Reply to a one-shot op. `value` is present on success; `error` on failure.
 *
 * `value` shapes by method:
 *   getDoc   → { id, path, exists, data?: SerializedDocData }
 *   getDocs  → { docs: Array<{ id, path, data: SerializedDocData }> }
 *   setDoc / updateDoc / deleteDoc / setRules → null (ack)
 *   addDoc   → { id, path }   (the minted document id + full path)
 *   count    → { count: number }
 *   batchCommit / txnCommit → null (ack)
 */
export type ResMessage =
  | { t: 'res'; id: string; ok: true; value: unknown }
  | { t: 'res'; id: string; ok: false; error: { code: string; message: string } };

/**
 * Streamed snapshot delivery. `value` is the same shape as `getDoc`/`getDocs`
 * result above but always present (not null) — listeners always fire with data.
 *
 * For a doc listener: `{ id, path, exists, data?: SerializedDocData }`
 * For a query listener: `{ docs: Array<{ id, path, data: SerializedDocData }> }`
 */
export interface SnapMessage {
  t: 'snap';
  subId: string;
  value: unknown;
}

/**
 * Streamed delivery for an event-stream subscription ({@link EventSubMessage}).
 *
 * Carries a BATCH of `SandboxEvent`s for the given `subId`:
 *   - the FIRST message after subscribe is the initial `sandbox.history()`
 *     snapshot (possibly empty);
 *   - each subsequent message is a single live event (`events.length === 1`).
 *
 * A batch keeps the initial history one structured-clone instead of N, and lets
 * the client fold history then stream uniformly. Events are plain JSON — no
 * rehydration needed (see {@link EventSubMessage}).
 */
export interface EventStreamMessage {
  t: 'event';
  subId: string;
  events: readonly SandboxEvent[];
}

export type OutboundMessage = ResMessage | SnapMessage | EventStreamMessage;

// ─── Serialized document data ─────────────────────────────────────────────

/**
 * Document data as it crosses the port: Timestamp/Bytes/LatLng/etc. are
 * serialized to their JSON marker shapes so they survive structured clone,
 * then rehydrated back to REAL class instances on the receiving side.
 *
 * Wire format == persistence format: we use the same codec the sandbox uses
 * for IndexedDB persistence (`serializeSnapshot` / `deserializeSnapshot` in
 * `pyric/sandbox`). Concretely:
 *
 *   serialize:   JSON.stringify(data)  — each wrapper's toJSON() emits a
 *                marker shape ({ __type: 'timestamp', seconds, nanos } etc.)
 *   deserialize: JSON.parse → rehydrateDocValue — re-wraps every marker
 *                shape into a real class instance (Timestamp, Bytes, LatLng).
 *
 * WHY REAL INSTANCES MATTER:
 * Consumer code does `snap.data().createdAt.toDate()`, `instanceof Timestamp`,
 * `bytes.data`, etc. Plain marker objects don't have those methods/prototype.
 * The persistence serializer's `rehydrateDocValue` is the canonical codec that
 * the sandbox already relies on — reusing it here ensures the wire format and
 * the persistence format are identical and don't drift.
 *
 * WHY JSON AND NOT STRUCTURED CLONE FOR DATA:
 * Structured clone can transfer Uint8Arrays, but class instances of pyric's
 * Timestamp/Bytes/LatLng are NOT in the structured clone spec — they'd arrive
 * as plain objects and lose their prototype chain, breaking instanceof checks.
 */
export interface SerializedDocData {
  /** JSON string of the document data (Timestamp/Bytes/LatLng serialized via toJSON). */
  json: string;
}

/**
 * Serialize document data to cross-port form.
 *
 * Uses `JSON.stringify` which calls `toJSON()` on each Timestamp, Bytes,
 * LatLng, etc., producing the canonical marker shapes. This is identical to
 * what `serializeSnapshot` does for the Firestore state before IDB writes.
 */
export function serializeDocData(data: Record<string, unknown>): SerializedDocData {
  return { json: JSON.stringify(data) };
}

/**
 * Deserialize document data from cross-port form.
 *
 * Parses the JSON string and walks the result with `rehydrateDocValue`
 * (from `pyric/sandbox`) to restore REAL class instances — the same codec
 * `deserializeSnapshot` uses when restoring from IDB. After this call,
 * Timestamp values are real `Timestamp` instances with `.seconds`/`.nanos`,
 * Bytes values have `.data` (Uint8Array), LatLng values have `.lat`/`.lng`.
 *
 * Disambiguation: a plain user object `{ seconds: 1, nanoseconds: 0 }` is
 * NOT mistaken for a Timestamp because the marker-based codec requires the
 * `__type: 'timestamp'` discriminator emitted by `Timestamp.toJSON()`. Raw
 * plain objects that happen to have numeric fields are passed through as-is.
 */
export function deserializeDocData(serialized: SerializedDocData): unknown {
  return rehydrateDocValue(JSON.parse(serialized.json));
}

// ─── Storage byte payloads (base64 + size cap) ────────────────────────────

/**
 * Maximum RAW byte size a single storage op may carry (`storage.putBytes`
 * payloads and `storage.getBytes` results). 8 MiB raw ≈ 11 MiB base64 —
 * comfortably under `ws`'s 100 MiB default `maxPayload` while keeping the
 * four-hop whole-object buffering (Node → bridge → page → worker and back)
 * sane. Enforced on BOTH ends: the Node conveniences / pyric-admin remote
 * arm reject before sending, and the worker host rejects oversized inputs
 * and results so a big browser-side object can't blow up the relay. Bigger
 * objects need the (unshipped) streaming story — do not raise the cap.
 */
export const MAX_STORAGE_OP_BYTES = 8 * 1024 * 1024;

/** Base64 length ceiling for a payload within {@link MAX_STORAGE_OP_BYTES} —
 *  a cheap pre-decode gate so an oversized `dataB64` is rejected without
 *  materializing its bytes first. */
export const MAX_STORAGE_OP_B64_LENGTH = Math.ceil(MAX_STORAGE_OP_BYTES / 3) * 4;

/** Build the canonical over-cap error (`code: 'payload-too-large'`). */
export function storagePayloadTooLarge(
  sizeBytes: number,
  what: string,
): Error & { code: string } {
  const err = new Error(
    `${what} is ${sizeBytes} bytes — over the ${MAX_STORAGE_OP_BYTES / (1024 * 1024)} MiB ` +
      'storage op cap (MAX_STORAGE_OP_BYTES). Streaming/resumable transfers are not ' +
      'supported on the sandbox backend; split the object or keep it under the cap.',
  ) as Error & { code: string };
  err.code = 'payload-too-large';
  return err;
}

/**
 * Encode bytes to standard base64. Chunked `String.fromCharCode` so a
 * multi-MiB payload doesn't overflow the argument-spread limit. `btoa` is
 * available in browsers, workers, Node ≥ 16, and Bun.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return btoa(binary);
}

/** Decode standard base64 to bytes (inverse of {@link bytesToBase64}). */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ─── Error serialization ──────────────────────────────────────────────────

/**
 * Serialize any thrown value to a `{ code, message }` pair suitable for
 * structured-clone across the MessagePort.
 *
 * SandboxError (from pyric/sandbox) carries `.code` (e.g. 'permission-denied')
 * and `.message`. All other errors get `code: 'unknown'`. Plain strings get
 * `code: 'unknown'` and `message: String(err)`.
 *
 * Class instances don't survive structured clone as their original class —
 * the receiver sees a plain object. We normalize to `{ code, message }` so
 * the client can reconstruct a typed error with `.code` attached.
 */
export function serializeError(err: unknown): { code: string; message: string } {
  if (err !== null && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown };
    if (typeof e.code === 'string' && typeof e.message === 'string') {
      return { code: e.code, message: e.message };
    }
    if (err instanceof Error) {
      return { code: 'unknown', message: err.message };
    }
  }
  return { code: 'unknown', message: String(err) };
}
