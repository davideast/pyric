---
title: "Re-exported types"
group: "pyric-admin / firestore"
section: "Reference"
order: 20009
---
# Re-exported types

`pyric-admin/firestore` re-exports a large surface of types from the sandbox
admin-firestore implementation and `pyric/sandbox` so most consumers can import
the Firestore admin surface from one place. This page lists what comes from
where and why.

## From `pyric/sandbox`

Foundation types you'll always need alongside the data plane:

- `AuthState`: the `{ uid, token? }` shape `withAuth` accepts.
- `Sandbox`: the root handle from `initializeSandbox()`.
- `SandboxContext`: the `(sandbox, auth)` pair `getFirestore` accepts.
- `SandboxError`: the typed error family. Catch with `instanceof`.

Anyone needing more reaches into `pyric/sandbox` directly.

## Production-shaped types

```ts
export type {
  AggregateField, AggregateQuerySnapshot, AggregateSpec, Filter,
  CollectionReference, DocumentData, DocumentReference,
  DocumentSnapshot as AdminDocumentSnapshot,
  FieldValueSentinel, Firestore,
  LintResult, LintWarning, OrderDirection,
  Query,
  QueryDocumentSnapshot as AdminQueryDocumentSnapshot,
  QuerySnapshot as AdminQuerySnapshot,
  RulesMetrics, SetOptions, Transaction, WhereFilterOp, WriteBatch,
} from 'pyric/sandbox/admin-firestore';
```

These mirror `firebase-admin/firestore`. The shapes match production exactly; the implementations are sandbox-aware.

### Why the `Admin*` prefixes

The three snapshot types appear with `Admin*` prefixes:

- `AdminDocumentSnapshot`
- `AdminQuerySnapshot`
- `AdminQueryDocumentSnapshot`

This is because the Web SDK has differently-shaped snapshot types with the same canonical names, and `onSnapshot` callbacks consume the Web shape. Aliasing the admin variants with the `Admin*` prefix keeps the canonical names available for the Web shape (see next section), so call sites copied from a `firebase/firestore` codebase typecheck without renaming.

## Web-SDK-shaped snapshot types

```ts
export type {
  LiveDocumentSnapshot as DocumentSnapshot,
  LiveQueryDocumentSnapshot as QueryDocumentSnapshot,
  LiveQuerySnapshot as QuerySnapshot,
  DocumentChange,
  DocumentChangeType,
  DocChangesOptions,
  SnapshotMetadata,
} from 'pyric/sandbox/admin-firestore';
```

Spelled with the conventional Web SDK names. Use these when typing `onSnapshot` callbacks:

```ts
import { onSnapshot, type DocumentSnapshot } from 'pyric-admin/firestore';

onSnapshot(db.doc('games/g1'), (snap: DocumentSnapshot) => {
  console.log(snap.exists, snap.data(), snap.metadata.fromCache);
});
```

## Values

Two runtime values re-exported from the simulator:

- `FieldValue`: the sentinel factory. `FieldValue.serverTimestamp()`, `FieldValue.increment(1)`, `FieldValue.arrayUnion(...)`, `FieldValue.arrayRemove(...)`, `FieldValue.delete()`.
- `Timestamp`: the timestamp wrapper class. `Timestamp.now()`, `Timestamp.fromDate(d)`, `Timestamp.fromMillis(ms)`.

Both behave the same way as in `firebase-admin/firestore`. The implementations route through the sandbox's value-resolver so writes encoded with sentinels merge correctly into the post-state.

## Why all this lives at the top of `pyric-admin`

A user writing a test wants:

```ts
import {
  getFirestore,
  initializeSandbox,
  SandboxError,
  FieldValue,
  Timestamp,
  type DocumentSnapshot,
} from 'pyric-admin';
```

Mostly one import. Reaching for `pyric/sandbox` separately to get
`SandboxError`, or for `pyric/sandbox/admin-firestore` separately for
`FieldValue`, would create friction for the common case. The aliases and
re-exports here exist to remove that friction.

When the consumer genuinely needs something not in this surface (the raw
`LocalEnvironment`, credentials for Rules Test API, the rules linter), the import path tells
them where to look: `pyric/sandbox/internal`, `@pyric/cli/credentials/node`, or
`pyric/rules`.
