---
title: "Feature matrix — pyric/firestore coverage of firebase/firestore"
navLabel: "Feature matrix"
group: "pyric / firestore"
section: "Reference"
order: 84
---
# Feature matrix — `pyric/firestore` coverage of `firebase/firestore`

Side-by-side coverage of the modular Web SDK surface. Use this to
decide what's safe to write in code that has to run against both
the pyric sandbox and prod Firebase.

**Legend:**

- ✅ — exported by `pyric/firestore` with the same name and
  signature as upstream. Works on both backends.
- ⚠️ — exported, but with a caveat: signature subset, sandbox-only
  no-op, runtime parity gap, or similar. Read the note.
- ❌ — not exported. Code that imports it will fail to resolve
  when the sandbox-preview build aliases `firebase/firestore` →
  `pyric/firestore`.

The right column ("Use in agent-generated `appSource`?") is the
deny-list / allow-list the agent's system prompt should encode.

---

## Initialization & lifecycle

| Symbol | Status | Note | Use in `appSource`? |
|---|---|---|---|
| `getFirestore(app)` | ✅ | Also accepts `SandboxContext` overload (sandbox-only) | Yes |
| `initializeFirestore(app, settings)` | ❌ | No custom settings on sandbox backend | No |
| `connectFirestoreEmulator(db, host, port)` | ✅ | No-op on sandbox handles; delegates on prod | Yes |
| `terminate(db)` | ❌ | No lifecycle handle on sandbox | No |
| `enableIndexedDbPersistence(db)` | ❌ | Persistence is host-runtime concern | No |
| `enableMultiTabIndexedDbPersistence(db)` | ❌ | As above | No |
| `clearIndexedDbPersistence(db)` | ❌ | As above | No |
| `persistentLocalCache(settings)` | ❌ | As above | No |
| `memoryLocalCache(settings)` | ❌ | As above | No |
| `persistentSingleTabManager`, `persistentMultipleTabManager` | ❌ | As above | No |
| `memoryEagerGarbageCollector`, `memoryLruGarbageCollector` | ❌ | As above | No |
| `waitForPendingWrites(db)` | ❌ | No equivalent on sandbox | No |

## Network control

| Symbol | Status | Note | Use in `appSource`? |
|---|---|---|---|
| `disableNetwork(db)` | ❌ | Sandbox has no network | No |
| `enableNetwork(db)` | ❌ | As above | No |

## References & equality

| Symbol | Status | Note | Use in `appSource`? |
|---|---|---|---|
| `doc(parent, ...path)` | ✅ | All overloads | Yes |
| `collection(parent, ...path)` | ✅ | All overloads | Yes |
| `collectionGroup(db, id)` | ✅ | | Yes |
| `documentId()` | ✅ | Re-exported from upstream; works on both | Yes |
| `FieldPath` | ✅ | Re-exported from upstream; works on both | Yes |
| `refEqual(a, b)` | ✅ | Target-aware; handles mixed sandbox/prod shapes | Yes |
| `queryEqual(a, b)` | ✅ | As above | Yes |
| `snapshotEqual(a, b)` | ✅ | As above | Yes |

## Reading

| Symbol | Status | Note | Use in `appSource`? |
|---|---|---|---|
| `getDoc(ref)` | ✅ | | Yes |
| `getDocs(query)` | ✅ | | Yes |
| `getDocFromCache(ref)` | ❌ | Cache APIs are prod-only infrastructure | No |
| `getDocFromServer(ref)` | ❌ | As above | No |
| `getDocsFromCache(query)` | ❌ | As above | No |
| `getDocsFromServer(query)` | ❌ | As above | No |
| `onSnapshot(ref, ...)` | ✅ | Doc + query overloads; observer + callbacks | Yes |
| `onSnapshotsInSync(db, observer)` | ❌ | No equivalent on sandbox | No |

## Writing

| Symbol | Status | Note | Use in `appSource`? |
|---|---|---|---|
| `setDoc(ref, data, options?)` | ✅ | `{ merge: true }` and `mergeFields` supported | Yes |
| `updateDoc(ref, data)` | ✅ | | Yes |
| `deleteDoc(ref)` | ✅ | | Yes |
| `addDoc(coll, data)` | ✅ | | Yes |
| `writeBatch(db)` | ✅ | Returns `WriteBatch` with `set` / `update` / `delete` / `commit` | Yes |

## Queries & constraints

| Symbol | Status | Note | Use in `appSource`? |
|---|---|---|---|
| `query(base, ...constraints)` | ✅ | Composes constraints; spreadable | Yes |
| `where(field, op, value)` | ✅ | `field` may be `string` or `FieldPath` | Yes |
| `or(...filters)` | ✅ | | Yes |
| `and(...filters)` | ✅ | | Yes |
| `orderBy(field, direction?)` | ✅ | | Yes |
| `limit(n)` | ✅ | | Yes |
| `limitToLast(n)` | ✅ | | Yes |
| `startAt(...)` | ✅ | Snapshot and value overloads | Yes |
| `startAfter(...)` | ✅ | As above | Yes |
| `endAt(...)` | ✅ | As above | Yes |
| `endBefore(...)` | ✅ | As above | Yes |

## Aggregates

| Symbol | Status | Note | Use in `appSource`? |
|---|---|---|---|
| `count()` | ✅ | | Yes |
| `sum(field)` | ✅ | | Yes |
| `average(field)` | ✅ | | Yes |
| `getCountFromServer(query)` | ✅ | | Yes |
| `getAggregateFromServer(query, spec)` | ✅ | | Yes |

## Transactions & batches

| Symbol | Status | Note | Use in `appSource`? |
|---|---|---|---|
| `runTransaction(db, updateFn, options?)` | ✅ | | Yes |
| `writeBatch(db)` | ✅ | See "Writing" | Yes |

## Sentinels & field values

| Symbol | Status | Note | Use in `appSource`? |
|---|---|---|---|
| `serverTimestamp()` | ✅ | | Yes |
| `increment(n)` | ✅ | | Yes |
| `arrayUnion(...values)` | ✅ | | Yes |
| `arrayRemove(...values)` | ✅ | | Yes |
| `deleteField()` | ✅ | | Yes |
| `FieldValue` (class re-export) | ✅ | Re-exported as `ChainFieldValue` alias | Yes |
| `Timestamp` (class re-export) | ✅ | Re-exported as `ChainTimestamp` alias | Yes |
| `Bytes` | ✅ | Round-trips through sandbox `setDoc` / `getDoc` as a `Bytes` instance — sandbox converter at `packages/pyric/src/sandbox/firestore/converters/bytes-geopoint.ts` + read finalization at `pyric/firestore`. COMPAT row #109. | Yes |
| `GeoPoint` | ✅ | Round-trips through sandbox `setDoc` / `getDoc` as a `GeoPoint` instance — same converter family. COMPAT row #110. | Yes |

## Bundles & named queries

| Symbol | Status | Note | Use in `appSource`? |
|---|---|---|---|
| `loadBundle(db, data)` | ❌ | Sandbox has no bundle pipeline | No |
| `namedQuery(db, name)` | ❌ | As above | No |

## Vector search

| Symbol | Status | Note | Use in `appSource`? |
|---|---|---|---|
| `vector(values)` | ❌ | Wire-encoder gap on sandbox | No |
| `VectorValue` | ❌ | As above | No |
| `findNearest(query, field, options)` | ❌ | As above | No |

## Data converters

| Symbol | Status | Note | Use in `appSource`? |
|---|---|---|---|
| `withConverter(ref, converter)` | ✅ | All overloads (`doc`/`coll`/`query`, plus null clear) | Yes |
| `FirestoreDataConverter<T>` | ✅ | Interface re-defined to keep types backend-opaque | Yes |

## Result & wrapper types

| Symbol | Status | Note | Use in `appSource`? |
|---|---|---|---|
| `Firestore` | ✅ | Opaque handle carrying `TARGET_SYMBOL` | Yes |
| `DocumentReference<T>` | ✅ | Subset of upstream — `id` + `path` only; rest opaque | Yes |
| `CollectionReference<T>` | ✅ | As above | Yes |
| `Query<T>` | ✅ | Opaque branded type | Yes |
| `DocumentSnapshot<T>` | ✅ | `id`, `exists()`, `data()`, `ref`, `metadata` | Yes |
| `QueryDocumentSnapshot<T>` | ✅ | `data()` always present | Yes |
| `QuerySnapshot<T>` | ✅ | `docs`, `size`, `empty`, `metadata`, `forEach` | Yes |
| `QueryConstraint` | ✅ | Returned by `where`/`orderBy`/cursor/etc. | Yes |
| `SetOptions` | ✅ | `{ merge }` / `{ mergeFields }` | Yes |
| `SnapshotListenOptions` | ✅ | | Yes |
| `SnapshotObserver<T>` | ✅ | | Yes |
| `Transaction` | ✅ | Union of sandbox + prod shape | Yes |
| `WriteBatch` | ✅ | Union of sandbox + prod shape | Yes |
| `Unsubscribe` | ✅ | `() => void` | Yes |
| `AggregateField`, `AggregateSpec`, `AggregateQuerySnapshot` | ✅ | | Yes |
| `LoadBundleTask`, `LoadBundleTaskProgress` | ❌ | Bundle pipeline absent | No |
| `FirestoreSettings` | ❌ | No `initializeFirestore` | No |

## Sandbox-only additions

These have no `firebase/firestore` equivalent. They live under
the `sandbox.*` namespace and throw `failed-precondition` if
called against a prod-backed handle.

| Symbol | Status | Note | Use in `appSource`? |
|---|---|---|---|
| `sandbox.setRules(db, rulesSource)` | ✅ | Sandbox-only; use `pyric-tools/deploy` for prod | **No** — never appears in deployed app code |
| `sandbox.seedDocuments(db, docs)` | ✅ | Sandbox-only; bulk-load bypassing rules | **No** — same |
| `sandbox.snapshotState(db)` | ✅ | Sandbox-only; dump of all stored docs | **No** — same |
| `TARGET_SYMBOL` | ✅ | Internal brand; agents should not read it | No |

These belong in the **runner** (the `code` artifact in the
playground workspace), not in `appSource`. The deploy adapter's
metafile gate refuses any prod bundle containing `@pyric/*`.

---

## Adjacent surfaces not in this matrix

- `firebase/app` — `initializeApp`, `getApp`, `getApps`,
  `FirebaseApp`. Used by the template's `main.tsx` and
  `firebase.ts`. Real prod surface in deployed bundles; the
  sandbox does not provide a `firebase/app` shim because
  `getFirestore(sandboxContext)` skips the app handle entirely.
- `firebase/auth` — **no `@pyric/*` equivalent today.** Agent
  code in `appSource` must not import `firebase/auth`. Identity
  in the sandbox is provided by `sandbox.withAuth(...)`
  (see `pyric/sandbox` docs). Tracked as an open question in
  the design rationale; build a `pyric/auth`
  shim if a real app pattern forces it.
- `firebase/storage`, `firebase/functions`, etc. — out of scope
  for the deploy milestone. Separate `pyric/storage` package
  exists; mapping to a `firebase/storage` alias is a future
  question.

## How this matrix gets used

- **The agent's system prompt** encodes the "No" column as an
  explicit deny-list, plus the `firebase/auth` exclusion. Agents
  generating `appSource` won't reach for symbols that break
  sandbox preview.
- **The sandbox preview build** aliases `firebase/firestore` →
  `pyric/firestore`. A `✅` row is guaranteed to work. A `⚠️`
  row works at the type level but has a sandbox-runtime caveat —
  acceptable for preview, fix-on-deploy.
- **The deploy build** has no aliases. Whatever the agent imports
  resolves to real `firebase/firestore` in node_modules. Any
  symbol the upstream SDK exports works; `❌` rows from this
  matrix only fail in sandbox preview, not in production. The
  metafile gate enforces the inverse direction: nothing from
  `@pyric/*` may appear in a deploy bundle.

---

## Keeping this matrix honest

Re-run this audit when:

- `pyric/firestore` adds or removes exports (`grep -E "^export" packages/pyric/src/firestore/index.ts | wc -l` — current count: ~86).
- The upstream `firebase/firestore` modular SDK adds a new
  symbol category (vector search expanded, persistence APIs
  reshaped, etc.).
- The sandbox wire-encoder closes a parity gap (e.g. `Bytes` /
  `GeoPoint` round-trip support) — flip the corresponding row
  from ⚠️ to ✅.
