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
// codec from `pyric/firestore/internal/value-codec` keeps the
// SharedWorker CLIENT bundle (every serve page) free of the rules/sandbox
// engine (~10 MB). The worker HOST (`entry.ts`/`host.ts`) still imports the
// full library — it IS the backend — but the client path stays lean.
import { rehydrateDocValue } from 'pyric/firestore/internal/value-codec';
// TYPE-ONLY (erased at build, so the leaf client bundle stays engine-free).
// The auth-lens contract and the cross-service event envelope are shared with
// the sandbox's event provenance — Studio's Action Center folds these verbatim.
import type { AuthLens, SandboxEvent, DenialContext } from 'pyric/sandbox';
// TYPE-ONLY (same rationale): the broker's own wire shapes for the
// `messaging.*` ops — all plain JSON, structured-clone-safe by construction.
import type {
  BrokerMessage,
  ClientVisibilityState,
  FcmErrorEnvelope,
} from 'pyric/messaging/internal';

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

// ─── Aggregate descriptors ─────────────────────────────────────────────────

/**
 * Aggregate-field descriptor for the `aggregate` op. Structurally identical
 * to `pyric/firestore`'s `AggregateField` (and to admin-compat's — the
 * `pyric-admin` remote arm's `Query.aggregate({ count/sum/average })`
 * surface), so specs cross the wire verbatim: plain JSON, no translation.
 * The host rebuilds the query and runs `getAggregateFromServer`; the reply
 * is `{ data: Record<alias, number | null> }` (empty-input `average` is
 * `null`, matching the SDKs).
 */
export type AggregateFieldDescriptor =
  | { kind: 'count' }
  | { kind: 'sum'; field: string }
  | { kind: 'average'; field: string };

/** Spec passed on the `aggregate` op — aliases become the result's keys. */
export type AggregateSpecDescriptor = Record<string, AggregateFieldDescriptor>;

// ─── AI wire shapes (cdd-deltas #98 — pyric/ai under pyric dev) ────────────

/**
 * JSON-safe engine config for the worker host's AiBroker — the wire form of
 * `pyric/ai`'s `EngineConfig` (cdd-deltas #98.4: engine choice + model mapping
 * are per-sandbox config on the ai mirror). Differences from the mirror type:
 *
 *   - `openai.baseUrl` is OPTIONAL here: absent means the serve default —
 *     the same-origin `/__pyric/ai-proxy` route (#98.2), so the browser
 *     openai engine reaches a localhost upstream with zero CORS setup.
 *   - `openai.fetch` (test injection) never crosses the port.
 *   - `scripted.script` entries are the PLAIN authoring shapes (string/regex
 *     matchers + JSON responds). Predicate matchers are functions and cannot
 *     cross the port — structured clone rejects them LOUDLY (DataCloneError),
 *     never silently. Author predicates host-side (ctx.aiEngine) instead.
 *
 * The config is honored on the FIRST ai op only (the broker is per-sandbox
 * and created once — mirroring `getAI`'s first-call-wins idempotence).
 */
export type AiEngineConfigWire =
  | { kind: 'scripted'; script?: Array<Record<string, unknown>> }
  | {
      kind: 'openai';
      /** OpenAI-compatible base URL. Absent ⇒ serve's `/__pyric/ai-proxy`. */
      baseUrl?: string;
      /** Catch-all upstream model when `modelMap` has no entry. */
      model?: string;
      /** Explicit Gemini-model-id → upstream-model mapping. */
      modelMap?: Record<string, string>;
    };

/**
 * Wire form of the Gemini error envelope an `AiBrokerError` carries
 * (`{ error: { code, message, status, details? } }` — every ai-error-*
 * capture). Rides on {@link SerializedError} so the client mirror can mint
 * the SAME `AIError('fetch-error', …)` the in-process plane would.
 */
export interface AiErrorEnvelopeWire {
  error: {
    code: number;
    message: string;
    status: string;
    details?: Array<Record<string, unknown>>;
  };
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

// ─── One-shot op messages (client → worker) ───────────────────────────────

/**
 * All one-shot operation messages share the `t:'op'` discriminator and a
 * correlation `id` that the worker echoes back in the `res` reply.
 */
export type OpMessage = (
  | {
      t: 'op';
      id: string;
      method: 'getDoc';
      path: string;
      activity?: { groupKind?: 'transaction' };
    }
  | { t: 'op'; id: string; method: 'getDocs'; source: TargetDescriptor }
  | { t: 'op'; id: string; method: 'setDoc'; path: string; data: unknown; options?: { merge?: boolean; mergeFields?: string[] } }
  | { t: 'op'; id: string; method: 'updateDoc'; path: string; data: unknown }
  | { t: 'op'; id: string; method: 'deleteDoc'; path: string }
  | { t: 'op'; id: string; method: 'addDoc'; collectionPath: string; data: unknown }
  | { t: 'op'; id: string; method: 'count'; source: TargetDescriptor }
  // Multi-field aggregates (count/sum/average — spike gap 2, needed for the
  // pyric-admin remote arm's `Query.aggregate` parity). `count` above stays
  // for existing senders; this is the general form. Reply:
  // `{ data: Record<alias, number | null> }`.
  | { t: 'op'; id: string; method: 'aggregate'; source: TargetDescriptor; spec: AggregateSpecDescriptor }
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
  // Sign-in provider config (Pyric Studio S-AUTH "Sign-in providers" section):
  // mirror `pyric/auth`'s `sandbox.{getAuthProviderConfig,setAuthProviderConfig}`
  // over the port. Reply for `getProviderConfig` is `Array<{providerId, enabled}>`.
  | { t: 'op'; id: string; method: 'auth.getProviderConfig' }
  | { t: 'op'; id: string; method: 'auth.setProviderConfig'; providerId: string; enabled: boolean }
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
  // ── AI ops (surface: 'ai' — cdd-deltas #98.3, exactly like rtdb.*/auth.*).
  // `request` is the plain Gemini-wire JSON the mirror already speaks (the
  // broker's GenerateContentRequest / CountTokensRequest — no class instances,
  // no codec round-trip). `model` is the model resource the mirror resolved
  // (e.g. `models/gemini-flash-lite-latest`). `engine` is honored on the FIRST
  // ai op only (broker creation — see AiEngineConfigWire). Replies:
  //   ai.generateContent → the complete WireResponse envelope (plain JSON)
  //   ai.countTokens     → the CountTokensResponse envelope (plain JSON)
  // Streaming is a SUBSCRIPTION, not an op — see AiStreamSubMessage.
  | { t: 'op'; id: string; method: 'ai.generateContent'; model: string; request: Record<string, unknown>; engine?: AiEngineConfigWire }
  | { t: 'op'; id: string; method: 'ai.countTokens'; model: string; request: Record<string, unknown>; engine?: AiEngineConfigWire }
  // Staleness guard: report the worker's baked build version so the page can
  // warn when a still-running OLD worker serves code older than what's served.
  | { t: 'op'; id: string; method: 'getRuntimeEpoch' }
  | { t: 'op'; id: string; method: 'retireRuntime'; targetEpoch: string }
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
  // Export the sandbox snapshot (Pyric Studio rules re-run): Studio forks it
  // locally to test a denied op against edited rules / re-issue as the user, all
  // on a throwaway branch (no live mutation). The reply is the serializable
  // `SandboxSnapshot` (the persistence format).
  | { t: 'op'; id: string; method: 'getSnapshot' }
  // Sandbox-owned full reset (issue #359): `sandbox.resetAll()` on the worker —
  // Firestore env + signed-in session + EVERY registered persistable service
  // (auth users, RTDB tree, storage objects). The reply is `{ errors }` once
  // every service finished clearing — per-service reset failures are listed
  // as `name: message` (empty array = clean wipe). Studio's Settings/Session reset rides this so
  // served mode wipes the same surface area as the in-process path.
  | { t: 'op'; id: string; method: 'resetAll' }
  // ── Messaging ops (surface: 'messaging'; host-capability gated) ──
  // The broker's documented worker-host seam (pyric/src/messaging/broker/
  // broker.ts header): each public broker method is one op here. All payloads
  // and replies are plain JSON. The host answers `messaging/disabled` unless
  // its ctx has `messagingEnabled: true`; normal serve producers set that
  // capability. NEVER lensed:
  // FCM has no rules identity; visibility (below) is the only routing input.
  //
  // `registrationId` names the page's service-worker registration (token
  // stability is keyed per registration — the captured contract); absent ⇒
  // the port-shared default registration.
  | { t: 'op'; id: string; method: 'messaging.getToken'; registrationId?: string }
  | { t: 'op'; id: string; method: 'messaging.deleteToken'; registrationId?: string }
  // Send-plane intake (the admin mirror's `send` crossing the transport).
  // Reply: the broker's `AcceptedSend` (name/messageId/target/validateOnly).
  // Rejections carry the captured google.rpc envelope on `error.envelope`.
  | { t: 'op'; id: string; method: 'messaging.send'; message: BrokerMessage; validateOnly?: boolean }
  | { t: 'op'; id: string; method: 'messaging.subscribeToTopic'; tokens: string[]; topic: string }
  | { t: 'op'; id: string; method: 'messaging.unsubscribeFromTopic'; tokens: string[]; topic: string }
  // Test/Studio delivery driver — injects straight into the client plane.
  | { t: 'op'; id: string; method: 'messaging.deliver'; spec: MessagingDeliverSpec }
  // THE captured routing rule crossing the transport: each port that reports
  // visibility is ONE window client in the broker (`setClientVisibility(portId,
  // state)`); a hidden tab's port marks its client not-visible, and routing is
  // foreground iff ANY visible client. Pages send this on `visibilitychange`.
  | { t: 'op'; id: string; method: 'messaging.setVisibility'; state: ClientVisibilityState }
  // ── Connected-page presence (#227) ──────────────────────────────────────
  // Ephemeral, worker-lifetime logical-page registry — NOT port/subscription/
  // auth-session counts. Pages register with a clientId, renew a short lease
  // via heartbeat, and disconnect on pagehide. Studio subscribes (target:
  // 'presence') for the authoritative snapshot. See host/presence.ts.
  | {
      t: 'op';
      id: string;
      method: 'presence.register';
      clientId: string;
      kind: PresenceClientKind;
      route: string;
      visibility: PresenceVisibility;
    }
  | { t: 'op'; id: string; method: 'presence.heartbeat'; clientId: string }
  | {
      t: 'op';
      id: string;
      method: 'presence.update';
      clientId: string;
      route?: string;
      visibility?: PresenceVisibility;
    }
  | { t: 'op'; id: string; method: 'presence.disconnect'; clientId: string }
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
  /**
   * MECHANICAL op provenance (Pyric Studio traffic attribution): the
   * client that CONSTRUCTS this op declares who issued it. The host maps
   * it onto the unified event stream's `actor` field (`{ kind: 'studio' }`)
   * via the sandbox's ambient-provenance window, so Traffic can filter
   * Studio's own viewer/editor noise out of the app's stream.
   *
   * Declared at the issuing call site, never inferred: Studio's worker
   * client stamps it on every op it builds (see `setOpIssuer` in
   * `client.ts`); the bridge relay (`relayWorkerOp`) clears that issuer and
   * marks remote frames separately, so a user's own admin-SDK traffic
   * through the remote bridge — which also rides this port when Studio
   * holds the peer slot — is never mislabeled as Studio's. Additive:
   * existing senders omit it.
   */
  issuer?: 'studio';
  /** Marks traffic relayed from a remote Node/agent consumer, never page app activity. */
  relaySource?: 'remote';
};

/**
 * Wire form of the broker's `deliver` spec (`messaging.deliver`) — the
 * headless stand-in for "a push arrives". Mirrors
 * `MessagingBroker.deliver`'s parameter exactly; plain JSON throughout.
 */
export interface MessagingDeliverSpec {
  /**
   * Simulated visibility of THIS port's window client at delivery time — the
   * transport twin of the in-page driver's `DeliverSpec.visibilityState`. When
   * present the host sets the delivering port's client visibility before
   * routing (`visible` → foreground/`onMessage`, `hidden` →
   * background/`onBackgroundMessage`); absent leaves the last-reported
   * visibility untouched.
   */
  visibilityState?: ClientVisibilityState;
  data?: Record<string, string>;
  notification?: { title?: string; body?: string; image?: string };
  from?: string;
  messageId?: string;
}

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
  /** Mechanical op provenance — see the field's doc on {@link OpMessage}.
   *  Tags the listener's REGISTRATION events (the initial rules eval); the
   *  listener's deferred re-evals stay attributed to the app (they fire on
   *  the microtask drain, outside any provenance window). */
  issuer?: 'studio';
  /** Marks traffic relayed from a remote Node/agent consumer, never page app activity. */
  relaySource?: 'remote';
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
  /** Mechanical op provenance — see the field's doc on {@link OpMessage}. */
  issuer?: 'studio';
  /** Marks traffic relayed from a remote Node/agent consumer. */
  relaySource?: 'remote';
}

/**
 * Stream a `generateContent` call as a SUBSCRIPTION (cdd-deltas #98.3:
 * "chunks over the existing subscription/event mechanism"). Unlike the
 * persistent listeners above, this sub is FINITE — it AUTO-UNSUBSCRIBES on a
 * terminal `done` snap:
 *
 *   { t:'snap', subId, value: { chunk } }   — one per streamed WireChunk,
 *                                             delivered in order
 *   { t:'snap', subId, value: { done: true } } — terminal; the host has
 *                                             already dropped the sub
 *   { t:'snap', subId, value: { __error } }  — terminal failure (the shared
 *                                             snap-error convention)
 *
 * A client MAY still send `unsub` (early consumer abandonment); the host
 * treats an unknown subId as a no-op, so the done/unsub race is benign.
 */
export interface AiStreamSubMessage {
  t: 'sub';
  subId: string;
  target: { service: 'ai'; op: 'streamGenerateContent' };
  /** Model resource, as on the `ai.generateContent` op. */
  model: string;
  /** Plain Gemini-wire GenerateContentRequest JSON. */
  request: Record<string, unknown>;
  /** First-op engine config — see {@link AiEngineConfigWire}. */
  engine?: AiEngineConfigWire;
}

/**
 * Register a MESSAGING delivery listener (the receive plane crossing the
 * transport — host-capability gated like the `messaging.*` ops).
 *
 * `target: 'messaging.foreground'` mirrors the client mirror's `onMessage`;
 * `target: 'messaging.background'` mirrors the sw mirror's
 * `onBackgroundMessage`. The host registers ONE real broker handler per sub
 * and forwards each `DeliveredPayload` (plain JSON — no codec needed) as a
 * `{ t:'snap', subId, value }` to the subscribing port. Which of the two
 * targets fires for a given delivery is the broker's captured visibility
 * rule — see the `messaging.setVisibility` op.
 */
export interface MessagingSubMessage {
  t: 'sub';
  subId: string;
  target: 'messaging.foreground' | 'messaging.background';
}

/**
 * Subscribe to connected-page presence (#227). On subscribe the host delivers
 * the current {@link PresenceSnapshot} as `{ t:'snap', subId, value }`, then
 * re-snaps on every registry change (register / heartbeat / update /
 * disconnect / lease expiry). Studio renders the worker's snapshot — it does
 * not implement a second client-side expiry policy.
 */
export interface PresenceSubMessage {
  t: 'sub';
  subId: string;
  target: 'presence';
}

/** Logical page kind for presence (#227). */
export type PresenceClientKind = 'app' | 'studio';

/** Page Visibility API state carried on presence records. */
export type PresenceVisibility = 'visible' | 'hidden';

/** One logical connected page in a presence snapshot. */
export interface PresenceClientRecord {
  clientId: string;
  kind: PresenceClientKind;
  route: string;
  visibility: PresenceVisibility;
  /** Epoch ms when this clientId first registered in this worker lifetime. */
  connectedAt: number;
  /** Epoch ms of the most recent register / heartbeat / update. */
  lastSeen: number;
}

/** Authoritative presence snapshot owned by the SharedWorker host. */
export interface PresenceSnapshot {
  clients: PresenceClientRecord[];
}

export type SubMessage =
  | FirestoreSubMessage
  | AuthSubMessage
  | EventSubMessage
  | RtdbValueSubMessage
  | AiStreamSubMessage
  | MessagingSubMessage
  | PresenceSubMessage;

/** Type guard: is this an auth subscription (vs a Firestore / event one)? */
export function isAuthSub(msg: SubMessage): msg is AuthSubMessage {
  return msg.target === 'authState' || msg.target === 'idToken';
}

/** Type guard: is this an event-stream subscription? */
export function isEventSub(msg: SubMessage): msg is EventSubMessage {
  return msg.target === 'events';
}

/** Type guard: is this a messaging delivery subscription? */
export function isMessagingSub(msg: SubMessage): msg is MessagingSubMessage {
  return msg.target === 'messaging.foreground' || msg.target === 'messaging.background';
}

/** Type guard: is this a connected-page presence subscription? */
export function isPresenceSub(msg: SubMessage): msg is PresenceSubMessage {
  return msg.target === 'presence';
}

export function isRtdbSub(msg: SubMessage): msg is RtdbValueSubMessage {
  return (
    typeof msg.target === 'object' &&
    msg.target !== null &&
    'service' in msg.target &&
    msg.target.service === 'rtdb'
  );
}

/** Type guard: is this an AI stream subscription (finite, auto-unsubs on done)? */
export function isAiSub(msg: SubMessage): msg is AiStreamSubMessage {
  return (
    typeof msg.target === 'object' &&
    msg.target !== null &&
    'service' in msg.target &&
    msg.target.service === 'ai'
  );
}

/** Tear down a previously registered snapshot listener. */
export interface UnsubMessage {
  t: 'unsub';
  subId: string;
}

/** Explicit app-port teardown; MessagePort close events are unreliable in Chrome. */
export interface DisconnectMessage {
  t: 'disconnect';
  id: string;
}

/**
 * Bind an app-owned port to the worker's one Firebase configuration.
 *
 * This control frame is deliberately response-free: it is posted immediately
 * after opening the port, and MessagePort FIFO ordering guarantees the worker
 * evaluates it before any service op/sub posted through that port. A conflict
 * tombstones the port; subsequent operations receive
 * `app/multiple-configs-not-supported` instead of touching the shared backend.
 */
export interface AppConfigMessage {
  t: 'appConfig';
  options: Record<string, unknown>;
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

export type InboundMessage =
  | OpMessage
  | SubMessage
  | UnsubMessage
  | DisconnectMessage
  | AppConfigMessage
  | ToolMessage;

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
  | { t: 'res'; id: string; ok: false; error: SerializedError };

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

/** The retiring worker tells every connected page to reload after it drains. */
export interface RuntimeReloadMessage {
  t: 'runtime-reload';
  epoch: string;
}

export type OutboundMessage =
  | ResMessage
  | SnapMessage
  | EventStreamMessage
  | RuntimeReloadMessage;

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
 * Wire form of a thrown error. `denialContext` (spike gap 6) is the
 * structured "why did this deny" frame `SandboxError` carries on
 * `permission-denied` — plain JSON end to end (rule line/expression, auth
 * state, simulator reasons, eval-time request shape), so it survives both
 * structured clone AND the JSON WS relay legs verbatim. Receivers re-attach
 * it to the reconstructed error so remote `SandboxError`s match local ones.
 */
export interface SerializedError {
  code: string;
  message: string;
  denialContext?: DenialContext;
  /**
   * The Gemini wire error envelope when the thrown value was an
   * `AiBrokerError` (pyric/ai) — plain JSON end to end, so the client
   * mirror can mint the SAME `AIError('fetch-error', …)` decoration the
   * in-process plane applies. `code` is `ai/<STATUS>` in that case.
   */
  aiEnvelope?: AiErrorEnvelopeWire;
  /**
   * Messaging send-plane rejection: the broker's captured google.rpc
   * envelope, carried VERBATIM (the seam doc: rejections cross the wire as
   * the `BrokerSendError.envelope` value — plain JSON, structured-clone-
   * safe). Present only on `messaging.*` op failures whose cause is a
   * `BrokerSendError`; a client mirror rebuilds the typed error from it.
   */
  envelope?: FcmErrorEnvelope;
}

/**
 * Serialize any thrown value to a `{ code, message, denialContext? }` shape
 * suitable for structured-clone across the MessagePort (and the JSON relay).
 *
 * SandboxError (from pyric/sandbox) carries `.code` (e.g. 'permission-denied')
 * and `.message`, plus `.denialContext` on rule denials — carried through
 * whenever present. All other errors get `code: 'unknown'`. Plain strings get
 * `code: 'unknown'` and `message: String(err)`.
 *
 * Class instances don't survive structured clone as their original class —
 * the receiver sees a plain object. We normalize so the client can
 * reconstruct a typed error with `.code` (and `.denialContext`) attached.
 */
export function serializeError(err: unknown): SerializedError {
  if (err !== null && typeof err === 'object') {
    // AiBrokerError (pyric/ai): detected STRUCTURALLY (the class is not
    // exported from `pyric/ai`'s public surface) by the wire envelope it
    // carries. The envelope rides whole so the receiving mirror re-mints the
    // exact SDK error; `code` is synthesized from the wire `status`.
    const envelope = (err as { envelope?: AiErrorEnvelopeWire }).envelope;
    if (
      envelope !== null &&
      typeof envelope === 'object' &&
      typeof envelope.error?.code === 'number' &&
      typeof envelope.error?.message === 'string' &&
      typeof envelope.error?.status === 'string'
    ) {
      return {
        code: `ai/${envelope.error.status}`,
        message: envelope.error.message,
        aiEnvelope: envelope,
      };
    }
    const e = err as { code?: unknown; message?: unknown; denialContext?: unknown };
    if (typeof e.code === 'string' && typeof e.message === 'string') {
      return e.denialContext !== null && typeof e.denialContext === 'object'
        ? { code: e.code, message: e.message, denialContext: e.denialContext as DenialContext }
        : { code: e.code, message: e.message };
    }
    if (err instanceof Error) {
      return { code: 'unknown', message: err.message };
    }
  }
  return { code: 'unknown', message: String(err) };
}
