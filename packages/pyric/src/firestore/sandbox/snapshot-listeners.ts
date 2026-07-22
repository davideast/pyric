/**
 * Snapshot-listener types — Slices 1–3 of `onSnapshot`.
 *
 * Slice 1 added the registry; Slice 2 added Web-SDK-shaped snapshot
 * types and the initial-fire wiring (in local-environment.ts); Slice 3
 * adds change detection — recompute on writes, diff against the prior
 * snapshot, suppress no-ops, fire surviving callbacks. See
 * the design rationale for the slice plan and
 * the design rationale for the production
 * patterns these types are adapted from (firebase-js-sdk 4.14.1, section 3,
 * section 4, section 5).
 */
import type { DocumentData } from './local-state.js';
import type { Operation } from './local-environment.js';
// FS-B10 — translate the listener read path so `snap.data()` exposes the
// SAME compat-shaped values (`Timestamp` `{seconds, nanoseconds}`, `Bytes`,
// `GeoPoint`) a one-shot `getDoc`/`getDocs` returns. Without this the
// listener leaked the rules-internal `Timestamp` (`{seconds, nanos}`, with a
// `typeName` field and no `nanoseconds`). `read-translation.ts` carries no
// admin-compat-surface dependency, so importing it here is cycle-free.
import { translateReadData } from './admin-compat/read-translation.js';
import type { QueryExecutionSpec } from './query-execution.js';
import type { QueryConstraints } from './list-query-proof.js';
import {
  getSnapshotField,
  type SnapshotFieldPath,
} from './admin-compat/field-path.js';

/**
 * A query's `where` / `orderBy` / cursor / `limit` constraints as a
 * immutable structural execution plan (FS-B2). `addSnapshotListener` threads this in
 * from the chainable `QueryImpl.snapshotConstraints()` so a filtered
 * `onSnapshot(query(...))` delivers the same membership as a one-shot
 * `getDocs(query(...))`. Bare collection references carry an empty execution
 * plan; `undefined` is reserved for foreign query implementations that expose
 * no plan at all.
 *
 * RULES-B11 — `RulesReadEngine` derives its proof projection from this same
 * execution plan, so authorization and row selection cannot diverge.
 */
export interface QueryConstraintPlan {
  readonly execution: QueryExecutionSpec;
  /** Complete query identity for diagnostics, separate from executable data. */
  readonly activityQuery?: unknown;
}

/**
 * @deprecated The callable listener seam cannot guarantee that rules proof and
 * execution describe the same rows. Kept source-compatible for consumers that
 * still name the type; passing one as a target now fails closed with an
 * `invalid-argument` stream error. Build a {@link QueryConstraintPlan} instead.
 */
export interface QueryConstraintApplier {
  (rows: { path: string; data: DocumentData }[]): { path: string; data: DocumentData }[];
  structured?: QueryConstraints;
  activityQuery?: unknown;
}

export type QueryConstraintInput = QueryConstraintPlan | QueryConstraintApplier;

/**
 * What a listener is watching. Query targets carry their `where` /
 * `orderBy` / `limit` constraints via {@link SnapshotTarget.constraints}
 * (FS-B2) so the listener delivers a filtered/ordered/limited view
 * rather than the whole collection.
 */
export type SnapshotTarget =
  | { kind: 'doc'; path: string }
  | { kind: 'query'; collection: string; constraints?: QueryConstraintInput };

/**
 * Mirrors `SnapshotListenOptions` from the Web SDK. `source: 'cache'` has
 * no analog in the sandbox (no offline cache) — accepted but treated as
 * `'default'`.
 *
 * `includeMetadataChanges` is now observable (item 3 / COMPAT firestore#85):
 * a local write echoes to every listener with `hasPendingWrites: true`, and
 * `includeMetadataChanges` listeners additionally receive the server-ack
 * fire (`hasPendingWrites: false`) that default listeners never see. See
 * `LocalEnvironment.notifyDocListener` / `notifyQueryListener`. `fromCache`
 * remains constant `false` — the sandbox has no offline cache to serve from.
 */
export interface SnapshotListenerOptions {
  includeMetadataChanges?: boolean;
  source?: 'default' | 'cache';
}

/**
 * Callback shape is a placeholder until Slice 2 introduces the public
 * `QuerySnapshot` / `DocumentSnapshot` types. Typed as `unknown` here so
 * Slice 1 does not lock in a snapshot shape that survey item section 4 says
 * needs careful construction (lazy `docs`, cached `docChanges()`).
 */
export type SnapshotCallback = (snapshot: unknown) => void;

/**
 * Stream errors. Per findings section 9, listener errors are stream-level —
 * once delivered, the listener is silently terminated (no further
 * snapshots). Slice 7 wires this end-to-end; the field exists in the
 * record now so Slice 1 doesn't have to re-shape it later.
 */
export type SnapshotErrorCallback = (error: unknown) => void;

/**
 * The fork's auth context at registration time — captured per
 * `addSnapshotListener` call rather than re-read at notification time.
 *
 * Why per-listener capture (write-time filtering): when a write by bob
 * triggers a fan-out, alice's listener must re-read under ALICE's auth,
 * not bob's. Re-reading "whatever auth is current" would let one user's
 * write leak through another user's listener. So each listener pins the
 * auth it subscribed with for write-driven re-evaluation. KEEP THIS.
 *
 * Why it ALSO re-captures (live listeners only): production doesn't just
 * read auth once at listen-establishment — it RE-ESTABLISHES the listen
 * stream when the session's own auth changes (sign-out/sign-in), so an
 * auth-gated listener gets a permission-denied on sign-out. Capturing
 * once was therefore INCOMPLETE. Live (`followsCurrentUser`) listeners
 * re-capture their `auth` when the sandbox's `currentUser` changes (see
 * {@link followsCurrentUser} + `LocalEnvironment.reevaluateLiveListeners`),
 * matching that re-establishment. Frozen-ctx listeners
 * (`followsCurrentUser === false`) stay pinned by design — that's the
 * admin/testing use case where identity is chosen explicitly per handle.
 */
export type ListenerAuth = Operation['auth'];

export interface ListenerRecord {
  /** Stable id used to look up the record on unsubscribe. */
  id: string;
  target: SnapshotTarget;
  callback: SnapshotCallback;
  errorCallback?: SnapshotErrorCallback;
  /** Captured at registration; see {@link ListenerAuth}. */
  auth: ListenerAuth;
  /** `true` for the Studio/admin lens. Rules stay bypassed for the initial
   * snapshot and every write- or rules-driven re-evaluation. */
  bypassRules: boolean;
  /**
   * `true` when this listener was registered through a `sandbox-live`
   * Firestore handle (`getFirestore(sandbox)`), whose identity follows
   * `sandbox.currentUser`. Such listeners re-capture their `auth` and
   * re-evaluate when `currentUser` changes — matching production, which
   * re-establishes the listen stream on a session auth change (an
   * auth-gated listener loses access on sign-out). `false` for
   * frozen-ctx listeners (`getFirestore(ctx)`), which stay pinned to the
   * identity chosen at handle-construction time (admin/testing path).
   */
  followsCurrentUser: boolean;
  /** Identity of the app session this live listener follows. Undefined is
   * the sandbox's ambient/default session. */
  authScope?: object;
  options: SnapshotListenerOptions;
  /**
   * Last snapshot delivered to the callback. Slice 2 populates this on
   * the initial fire; Slice 3 uses {@link currentDocData} /
   * {@link currentDocs} as the diff baseline (raw data is cheaper than
   * unwrapping the snapshot accessor on every write).
   */
  currentSnapshot: unknown;
  /**
   * Diff baseline for `kind: 'doc'` listeners. `null` means the doc
   * does not exist; `undefined` means no snapshot has fired yet.
   * Slice 3 reads this to detect modified-vs-no-op fires.
   */
  currentDocData?: DocumentData | null;
  /**
   * Diff baseline for `kind: 'query'` listeners. The previous list of
   * docs the listener saw, in the same order Slice 2's
   * `silentReadCollection` returns them (path-ordered). Slice 3 passes
   * this to `buildQuerySnapshot` so `oldIndex` and the `removed`
   * change list are computed against the right baseline.
   */
  currentDocs?: { path: string; data: DocumentData }[];
  /**
   * Set when an error has been delivered. Per findings section 9 — once true,
   * the dispatch loop must skip this record. Slice 7 wires the flip.
   */
  errored: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// Public snapshot data shapes — Slice 2.
//
// Web-SDK-shaped (per firebase-js-sdk 4.14.1, source-survey section 4). These
// are intentionally distinct from the Admin-shaped types in
// `admin-compat/types.ts` — `metadata`, `query`, `docChanges()`, and
// `exists()` as a method are Web-SDK conventions agent code expects
// when calling `onSnapshot` regardless of which adapter shipped the
// handle.
// ─────────────────────────────────────────────────────────────────────

/**
 * Mirrors `firebase/firestore`'s `SnapshotMetadata`. `fromCache` is always
 * `false` (the sandbox has no offline cache). `hasPendingWrites` transitions
 * (item 3): a local write's optimistic echo carries `true`, and the server
 * ack carries `false` — so `includeMetadataChanges` has an observable effect
 * matching prod (COMPAT firestore#85).
 */
export interface SnapshotMetadata {
  readonly hasPendingWrites: boolean;
  readonly fromCache: false;
}

/**
 * Minimal `DocumentReference` shape exposed on snapshots — `id` and
 * `path` are all the production type guarantees for read-side use. The
 * Web SDK adapter (Slice 4) supplies a richer ref to its own callers;
 * this interface is the contract this module promises.
 */
export interface SnapshotDocRef {
  readonly id: string;
  readonly path: string;
}

/**
 * Minimal `Query` shape exposed on `QuerySnapshot.query` — production
 * exposes the original `Query` object. For our purposes the listener's
 * `SnapshotTarget` is enough handle for round-tripping.
 */
export interface SnapshotQueryRef {
  readonly path: string;
}

export type DocumentChangeType = 'added' | 'modified' | 'removed';

export interface DocumentSnapshot {
  readonly id: string;
  readonly ref: SnapshotDocRef;
  readonly metadata: SnapshotMetadata;
  exists(): boolean;
  data(): DocumentData | undefined;
  /**
   * Field accessor mirroring `firebase/firestore`'s `DocumentSnapshot.get(fieldPath)`.
   * Dotted paths supported. Missing intermediate keys yield `undefined`
   * — production behavior; agents commonly chain optional reads.
   */
  get(fieldPath: SnapshotFieldPath): unknown;
}

/**
 * Production narrows `data()` to non-undefined here. We follow suit so
 * that agent code calling `snap.data().foo` doesn't need a guard for
 * the items inside a `QuerySnapshot.docs` array.
 */
export interface QueryDocumentSnapshot extends DocumentSnapshot {
  data(): DocumentData;
}

export interface DocumentChange {
  readonly type: DocumentChangeType;
  readonly doc: QueryDocumentSnapshot;
  /** -1 for `added`. */
  readonly oldIndex: number;
  /** -1 for `removed`. */
  readonly newIndex: number;
}

/** Options for `QuerySnapshot.docChanges`. Mirrors Web SDK shape. */
export interface DocChangesOptions {
  includeMetadataChanges?: boolean;
}

export interface QuerySnapshot {
  readonly query: SnapshotQueryRef;
  readonly metadata: SnapshotMetadata;
  readonly size: number;
  readonly empty: boolean;
  readonly docs: QueryDocumentSnapshot[];
  forEach(callback: (snap: QueryDocumentSnapshot) => void): void;
  /**
   * Per findings section 4: cached by `includeMetadataChanges` value; throws if
   * called with `true` when the listener did not subscribe with
   * `includeMetadataChanges: true`. The Slice 2 implementation produces
   * "all docs added" on the first fire — Slice 3 supplies real diffs.
   */
  docChanges(options?: DocChangesOptions): DocumentChange[];
}

// ─── Snapshot constants ──────────────────────────────────────────────

/**
 * Settled metadata — `hasPendingWrites: false`. Used for the initial fire,
 * the server-ack fire (item 3), and every re-eval that reflects a durable
 * server read (rules redeploy, live-listener auth change). Shared frozen
 * instance to save allocations on the common settled path.
 */
export const SANDBOX_METADATA: SnapshotMetadata = Object.freeze({
  hasPendingWrites: false as const,
  fromCache: false as const,
});

/**
 * Pending metadata — `hasPendingWrites: true`. Stamped on the local write
 * echo (item 3): the optimistic fire a write produces before the (sandbox-
 * synchronous) server ack. Mirrors prod, where a `setDoc` echoes locally
 * with `hasPendingWrites: true`. COMPAT firestore#85.
 */
export const SANDBOX_METADATA_PENDING: SnapshotMetadata = Object.freeze({
  hasPendingWrites: true as const,
  fromCache: false as const,
});

// ─── Snapshot construction helpers ───────────────────────────────────

function lastSegment(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * Build a Web-SDK-shaped `DocumentSnapshot` for a single doc path.
 * `data === null` indicates the doc does not exist (`exists() === false`,
 * `data() === undefined`).
 */
export function buildDocumentSnapshot(
  path: string,
  data: DocumentData | null,
  metadata: SnapshotMetadata = SANDBOX_METADATA,
): DocumentSnapshot {
  const ref: SnapshotDocRef = { id: lastSegment(path), path };
  const exists = data !== null;
  // FS-B10 — translate to the same compat shape `getDoc` returns, so a
  // listener's `snap.data().createdAt` is a `{seconds, nanoseconds}`
  // Timestamp, not the rules-internal `{seconds, nanos}` wrapper.
  const translated = exists ? translateReadData(data as DocumentData) : undefined;
  return {
    id: ref.id,
    ref,
    metadata,
    exists: () => exists,
    data: () => translated,
    get: (fieldPath) => getSnapshotField(translated, fieldPath),
  };
}

function buildQueryDocumentSnapshot(
  path: string,
  data: DocumentData,
  metadata: SnapshotMetadata = SANDBOX_METADATA,
): QueryDocumentSnapshot {
  const ref: SnapshotDocRef = { id: lastSegment(path), path };
  // FS-B10 — same read-path translation as the single-doc + getDocs paths.
  const translated = translateReadData(data);
  return {
    id: ref.id,
    ref,
    metadata,
    exists: () => true,
    data: () => translated,
    get: (fieldPath) => getSnapshotField(translated, fieldPath),
  };
}

/**
 * Build a Web-SDK-shaped `QuerySnapshot`.
 *
 * `docList` carries the docs in their query-order (the caller is
 * responsible for ordering — for Slice 2 the order is whatever
 * `LocalState.list` returns, which is a path-ordered scan).
 *
 * `prevDocs` is the previous snapshot's docs, used to compute
 * `oldIndex`. Pass `undefined` for an initial snapshot — every doc
 * surfaces as `added` with `oldIndex === -1`. Slice 3 will pass the
 * previous list to compute `modified` / `removed` entries.
 *
 * The returned `docChanges()` is cached by `includeMetadataChanges`
 * and throws on flag-mismatch when the listener didn't subscribe with
 * the option (per findings section 4) — that throw is wired by passing
 * `excludesMetadataChanges: !options.includeMetadataChanges` from the
 * listener record, which Slice 3 hooks into the dispatch path.
 */
export function buildQuerySnapshot(
  query: SnapshotQueryRef,
  docList: { path: string; data: DocumentData }[],
  options: { excludesMetadataChanges: boolean },
  prevDocs?: { path: string; data: DocumentData }[],
  metadata: SnapshotMetadata = SANDBOX_METADATA,
): QuerySnapshot {
  const docs = docList.map((d) => buildQueryDocumentSnapshot(d.path, d.data, metadata));

  // Pre-compute the no-metadata-change view (Slice 2 semantics):
  // initial fire → every current doc is `added`. Slice 3 will replace
  // this with proper diffing against `prevDocs`.
  const baseChanges: DocumentChange[] = prevDocs
    ? computeChanges(prevDocs, docList, docs, metadata)
    : docs.map((doc, newIndex) => ({ type: 'added' as const, doc, oldIndex: -1, newIndex }));

  let cachedNoMetaChanges: DocumentChange[] | null = null;
  let cachedWithMetaChanges: DocumentChange[] | null = null;

  return {
    query,
    metadata,
    size: docs.length,
    empty: docs.length === 0,
    docs,
    forEach(cb) {
      for (const d of docs) cb(d);
    },
    docChanges(opts?: DocChangesOptions) {
      const wantMeta = !!opts?.includeMetadataChanges;
      if (wantMeta && options.excludesMetadataChanges) {
        // Production throws `FirestoreError(invalid-argument)` here. We
        // throw a plain Error in the simulator core; the Web SDK adapter
        // (Slice 4) re-tags this into a `FirestoreError` shape so agent
        // code can pattern-match on `.code`.
        throw new Error(
          'To include metadata changes with your document changes, you must also pass ' +
            '{ includeMetadataChanges: true } to onSnapshot().',
        );
      }
      // Sandbox metadata never transitions (findings section 6) so the two
      // cached arrays are identical in practice — keeping the cache key
      // separate matches production's contract verbatim and lets us add
      // distinct semantics later without breaking call sites.
      if (wantMeta) {
        if (!cachedWithMetaChanges) cachedWithMetaChanges = baseChanges.slice();
        return cachedWithMetaChanges;
      }
      if (!cachedNoMetaChanges) cachedNoMetaChanges = baseChanges.slice();
      return cachedNoMetaChanges;
    },
  };
}

/**
 * Diff `prev` against `curr` to produce `DocumentChange[]`. Slice 3
 * uses this from the notification path; Slice 2 only invokes it when
 * `prevDocs` is supplied (i.e. never on the initial fire).
 *
 * `oldIndex`/`newIndex` follow production's contract (-1 for added /
 * removed). Comparison uses path identity for membership and a shallow
 * `JSON.stringify` for "modified" detection — good enough for the
 * sandbox's data shapes (all `DocumentData` values are JSON-serialisable
 * after sentinel resolution). A deep-equal helper can land in Slice 3
 * if a probe surfaces a divergence.
 */
function computeChanges(
  prev: { path: string; data: DocumentData }[],
  curr: { path: string; data: DocumentData }[],
  currSnaps: QueryDocumentSnapshot[],
  metadata: SnapshotMetadata = SANDBOX_METADATA,
): DocumentChange[] {
  const prevIndex = new Map<string, number>();
  prev.forEach((d, i) => prevIndex.set(d.path, i));
  const currIndex = new Map<string, number>();
  curr.forEach((d, i) => currIndex.set(d.path, i));

  const out: DocumentChange[] = [];
  // Removed (in prev, not in curr) — keep `oldIndex` from prev.
  for (let i = 0; i < prev.length; i++) {
    const p = prev[i]!;
    if (!currIndex.has(p.path)) {
      out.push({
        type: 'removed',
        doc: buildQueryDocumentSnapshot(p.path, p.data, metadata),
        oldIndex: i,
        newIndex: -1,
      });
    }
  }
  // Added or modified (every curr entry).
  for (let i = 0; i < curr.length; i++) {
    const c = curr[i]!;
    const oldI = prevIndex.get(c.path);
    if (oldI === undefined) {
      out.push({ type: 'added', doc: currSnaps[i]!, oldIndex: -1, newIndex: i });
    } else {
      const prevData = prev[oldI]!.data;
      if (JSON.stringify(prevData) !== JSON.stringify(c.data)) {
        out.push({ type: 'modified', doc: currSnaps[i]!, oldIndex: oldI, newIndex: i });
      }
    }
  }
  return out;
}
