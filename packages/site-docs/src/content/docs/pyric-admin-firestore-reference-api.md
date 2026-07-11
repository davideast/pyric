---
title: "API reference: pyric-admin/firestore"
navLabel: "API reference"
group: "pyric-admin / firestore"
section: "Reference"
order: 20008
---
# API reference: `pyric-admin/firestore`

Every public export of the subpath, grouped by purpose. This page is the map; the sibling pages carry the depth ([`onSnapshot` overloads](../pyric-admin-firestore-reference-onsnapshot/), [`SandboxFirestore` surface](../pyric-admin-firestore-reference-sandbox-firestore/), [Re-exported types](../pyric-admin-firestore-reference-re-exported-types/)).

One arm difference to know before anything else: unlike `pyric-admin/{auth,database,storage}`, this subpath has **no production arm**. It runs against a sandbox, local or remote. A prod app throws with a pointer to use `firebase-admin/firestore` directly, which already covers production.

---

## Entry points

### `getFirestore(target?)`
```ts
function getFirestore(target?: SandboxContext | PyricAdminApp): SandboxFirestore;
```
Resolve the rules-applied Firestore handle. Three input shapes:

- **`getFirestore(ctx)`** with a `SandboxContext`: the load-bearing form. Operations run under the context's captured identity. Anonymous is `sandbox.withAuth(null)`, written explicitly, so every call site states identity. Idempotent: repeat calls with the same context return the same handle (cached in a `WeakMap`).
- **`getFirestore(app)`** with a `PyricAdminApp`: resolves the app's sandbox as `sandbox.withAuth(null)`. The resulting handle is **anonymous**. For a specific identity, use the context form. A prod app throws: the in-process backend does not model firebase-admin's real Firestore; use `firebase-admin/firestore` directly for production.
- **`getFirestore()`**: resolves the `'[DEFAULT]'` app from `pyric-admin/app`'s registry (throws `app/no-app` when nothing is initialized), then behaves like the app form.

**Remote arm.** A remote-branded sandbox (a Node handle onto the browser-hosted worker sandbox) gets a channel-backed handle instead of the in-process engine. The context's frozen auth pins the per-operation lens: `withAuth(null)` pins `{ mode: 'anon' }`, and a signed identity pins `{ mode: 'as', uid, token? }` with the full claims token, so custom claims evaluate in rules exactly as on the local arm.

**Reset semantics.** Operations pick up a `sandbox.reset()` on the next call, but refs already in hand (`DocumentReference`, `Query`) stay bound to the environment that was live when they were obtained. Re-acquire refs after a reset.

**Errors.** Operations, and every object they return, re-throw failures as `SandboxError` with structured `denialContext` on permission denials. See [error translation](../pyric-admin-firestore-explanation-error-translation/).

### `getAdminFirestore(target)`
```ts
function getAdminFirestore(ctx: SandboxContext): SandboxFirestore;
function getAdminFirestore(sandbox: Sandbox): SandboxFirestore;
```
Resolve a **rules-bypassing** handle: same chainable `SandboxFirestore` surface, but every operation it issues (reads, writes, queries, batches, transactions) skips security-rule evaluation and is treated as allow. A bare `Sandbox` is accepted because the bypass is identity-agnostic; no rule reads `request.auth` on this path.

Storage preconditions still apply (a `create` on an existing doc still fails `already-exists`, matching real Firestore admin behavior), and the same `request`/`write` events fire and listeners wake, so bypass writes show up live and on the traffic log stamped as admin-bypass.

On a remote sandbox, the bypass rides the worker's `{ mode: 'admin' }` lens, the same lens Studio's admin surface uses.

Use it for "edit anything as admin" surfaces. For rules-applied impersonation, use `getFirestore(sandbox.withAuth({ uid }))` instead.

### `onSnapshot(refOrQuery, ...)`
```ts
function onSnapshot(reference: DocumentReference, observer: SnapshotObserver<DocumentSnapshot>): Unsubscribe;
function onSnapshot(reference: Query | CollectionReference, observer: SnapshotObserver<QuerySnapshot>): Unsubscribe;
// plus (options, observer), (onNext, onError?), and (options, onNext, onError?) forms of each
```
Web-SDK-shaped streaming reads. Four overload groups per target kind mirror `firebase/firestore`'s `onSnapshot`, so call sites copied from production typecheck unchanged. Full overload list and rationale: [`onSnapshot` overloads](../pyric-admin-firestore-reference-onsnapshot/).

Behavior notes verified against source:

- Query-shaped refs deliver a filtered, ordered, limited view matching `getDocs` of the same query (the query's constraints ride into the listener).
- The registering context's auth is captured at register time; notifications evaluate rules under the identity that subscribed, not whatever identity is active when a write triggers dispatch.
- An observer carrying only `error` registers and receives denials. Only a fully empty observer (no `next` and no `error`) throws.
- `complete`/`onCompletion` is accepted but never fires: the local stream has no terminal state.
- Refs minted by a remote handle register through the worker subscription with the handle's lens pinned; error callbacks receive `SandboxError`s with `denialContext` when the worker carried one.
- The chainable form (`db.collection('x').where(...).onSnapshot(cb)`) works at runtime on both arms but is no longer typed; the free function is the typed surface.

### `FOLLOWS_CURRENT_USER`
```ts
const FOLLOWS_CURRENT_USER: unique symbol;
```
Internal wiring, exported for one consumer: the modular `pyric/firestore` layer stamps this symbol onto the options object it forwards to mark a listener as live (identity follows `sandbox.currentUser`) rather than frozen. `onSnapshot` here reads and strips it. Direct callers never need it; absent means frozen, the safe default. On a remote sandbox, a live-marked listener throws (`SandboxError` code `unimplemented`): remote listeners are frozen to the identity of the context that created the ref.

---

## The chainable surface

`SandboxFirestore` extends the production-shaped `Firestore`, so admin-style code chains the way it does against `firebase-admin/firestore`:
```ts
await db.collection('notes').doc('n1').set({ title: 'hello' });
const snap = await db.collection('notes').where('done', '==', false).get();
```
The shapes, as implemented by the compat layer:

- `db.collection(path)`, `db.doc(path)`, `db.collectionGroup(collectionId)`, `db.batch()`, `db.runTransaction(fn, opts?)`.
- `DocumentReference`: `id`, `path`, `parent`, `collection(name)`, `get()`, `set(data, { merge?, mergeFields? })`, `update(data)`, `delete()`.
- `CollectionReference extends Query`: `id`, `path`, `doc(id?)`, `add(data)`.
- `Query`: `where(field, op, value)`, `applyFilter(filter)` (the `Filter` OR/AND tree), `orderBy(field, direction?)`, `limit(n)`, `limitToLast(n)`, cursor builders (`startCursor`, `endCursor`, `startCursorFromSnapshot`, `endCursorFromSnapshot`), `get()`, `aggregate(spec)` (count, sum, average).
- `WriteBatch`: `set`, `update`, `delete`, `commit()`.
- `Transaction`: `get(ref)` / `get(query)`, `set`, `update`, `delete`.

Detailed per-method behavior: [`SandboxFirestore` surface](../pyric-admin-firestore-reference-sandbox-firestore/), [How to write a batch](../pyric-admin-firestore-how-to-write-a-batch/), [How to run a transaction](../pyric-admin-firestore-how-to-run-a-transaction/).

### Sandbox-only methods on the handle

`SandboxFirestore` adds three methods with no production analog, named in sandbox vocabulary so they cannot be confused with deployment:
```ts
setRules(rules: string): LintResult;
seed(options?: { documents?: Record<string, DocumentData> }): LintResult;
snapshot(): Record<string, DocumentData>;
```
`setRules` swaps the active ruleset (parse errors leave the old rules in place), `seed` replaces stored documents while preserving rules, `snapshot` captures every document as a path-keyed map. Full contract: [`SandboxFirestore` surface](../pyric-admin-firestore-reference-sandbox-firestore/).

---

## Values

### `FieldValue`
```ts
class FieldValue {
  static serverTimestamp(): FieldValueSentinel;
  static increment(n: number): FieldValueSentinel;
  static arrayUnion(...values: unknown[]): FieldValueSentinel;
  static arrayRemove(...values: unknown[]): FieldValueSentinel;
  static delete(): FieldValueSentinel;
}
```
The admin-SDK static-method shape. Each call returns a `FieldValueSentinel` marker the write path resolves.

### `Timestamp`
```ts
class Timestamp {
  constructor(seconds: number, nanoseconds: number);
  static now(): Timestamp;
  static fromDate(d: Date): Timestamp;
  static fromMillis(ms: number): Timestamp;
  toDate(): Date;
  toMillis(): number;
  isEqual(other: Timestamp): boolean;
}
```
Admin-SDK shape (`seconds` plus `nanoseconds`).

### `SandboxError`
```ts
class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  readonly denialContext?: DenialContext;
  readonly remediation?: string;
}
```
The typed error family from `pyric/sandbox`, re-exported so consumers can `catch (e) { if (e instanceof SandboxError) ... }` with one import path. `denialContext` is populated on `permission-denied` and carries the rule, the request, and the resource state that produced the verdict. See [Translate denials](../pyric-admin-firestore-how-to-translate-denials/).

---

## Types

Grouped by origin; the full rationale for what comes from where is in [Re-exported types](../pyric-admin-firestore-reference-re-exported-types/).

**Foundation (from `pyric/sandbox`):** `AuthState`, `Sandbox`, `SandboxContext`.

**Handle and listener types (declared here):**

- `SandboxFirestore extends Firestore`: the handle documented above.
- `SnapshotObserver<T>`: `{ next?, error?, complete? }`. Mirrors `firebase/firestore`'s `PartialObserver<T>`; `complete` never fires.
- `SnapshotListenOptions`: mirrors `firebase/firestore`'s shape. `includeMetadataChanges` is accepted but has no observable effect (no offline cache, no pending-writes window).
- `Unsubscribe`: `() => void`, returned by `onSnapshot`. Idempotent.

**Production-shaped (from the compat layer):** `Firestore`, `CollectionReference`, `DocumentReference`, `Query`, `Transaction`, `WriteBatch`, `DocumentData`, `SetOptions`, `WhereFilterOp`, `OrderDirection`, `Filter`, `FieldValueSentinel`, `AggregateField`, `AggregateSpec`, `AggregateQuerySnapshot`.

**Admin-shaped snapshots (what `ref.get()` returns):** `AdminDocumentSnapshot`, `AdminQueryDocumentSnapshot`, `AdminQuerySnapshot`. `exists` is a property, `size`/`empty`/`docs`/`forEach` on the query variant.

**Web-shaped snapshots (what `onSnapshot` callbacks receive):** `DocumentSnapshot`, `QueryDocumentSnapshot`, `QuerySnapshot`, `DocumentChange`, `DocumentChangeType`, `DocChangesOptions`, `SnapshotMetadata`. Spelled with the conventional Web SDK names so callbacks type naturally.

**Rules lint (from `pyric/rules`):** `LintResult`, `LintWarning`, `RulesMetrics`. Returned by `setRules` and `seed`.

---

## Where to go next

- [`SandboxFirestore` surface](../pyric-admin-firestore-reference-sandbox-firestore/) for per-method behavior on the handle.
- [`onSnapshot` overloads](../pyric-admin-firestore-reference-onsnapshot/) for the streaming surface in full.
