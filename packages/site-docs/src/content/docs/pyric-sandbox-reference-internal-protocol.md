---
title: "The /internal adapter protocol"
navLabel: "The /internal protocol"
group: "pyric / sandbox"
section: "Reference"
order: 132
---
# The `/internal` adapter protocol

The `pyric/sandbox/internal` sub-path is the **adapter-only** surface. Service-adapter packages (`pyric-admin`, `pyric/firestore`, future `pyric/auth`) consume it to reach the underlying `LocalEnvironment` and related primitives.

It is **not** part of the public API. The shape is subject to change without breaking-change semantics across `pyric/sandbox` versions. External adapter authors should not depend on it directly. When the protocol stabilises (after the multi-service architecture lands) it will be promoted.

## What lives there
```ts
import { getInternalEnv, LocalEnvironment, EventLog /* … */ } from 'pyric/sandbox/internal';
```
The major surfaces:

### `getInternalEnv(sandbox): LocalEnvironment`

Given a `Sandbox` produced by `initializeSandbox()`, return its `LocalEnvironment`. Throws `SandboxError('invalid-argument')` for hand-rolled `Sandbox` handles, so adapters can rely on it to reject malformed input early.

### `LocalEnvironment`

The runtime substrate. Methods adapters use most:

- `execute(operation)`: run a single operation, evaluating rules.
- `executeBatch(operations)`: atomic batch.
- `runTransaction(callback)`: transaction with read tracking.
- `seed({ rules, documents })`: bulk-load state.
- `deployRules(source)`: swap rules and re-evaluate live listeners.
- `addSnapshotListener({ kind, path?, collection?, auth, onSnapshot, onError? })`: register a Firestore-shaped listener.
- `getDocument`, `listDocuments`, `listRootCollections`, `listSubcollections`: admin reads.
- `snapshot()`: Firestore-only state capture.
- `onRequest`, `onWrite`, `onSnapshotDelivery`, `onSnapshotSuppressed`, `onListenerLifecycle`, `onSnapshotError`, `onDenial`: internal channels. `SandboxImpl` subscribes to each and re-emits the resulting payloads through the public `Sandbox.onEvent` as a `SandboxEvent` discriminated union. Adapters typically don't tap these directly; consume through `Sandbox.onEvent` instead.
- `dispose()`: drop listener registries.

### `EventLog`

Append-only audit trail of every operation. Adapters that need to surface "what happened" to a UI (the playground does) consume `EventLog.getEvents()`. Carries `AgentEvent` records with `id`, `timestamp`, `method`, `path`, `auth`, `allowed`, `data`, `operations`, `reads`, `debugMessages`.

### Field-value sentinels

For `pyric-admin` and `pyric/firestore` to translate user-facing sentinels into the simulator's shape:
```ts
import {
  INCREMENT,
  ARRAY_UNION,
  ARRAY_REMOVE,
  DELETE_FIELD,
  // converter registry
  incrementConverter, arrayUnionConverter, arrayRemoveConverter, deleteFieldConverter,
} from 'pyric/sandbox/internal';
```
### Transaction primitives
```ts
import {
  Transaction,
  type BatchOperation,
  type CreateResult,
  type UpdateResult,
  type SetResult,
  type DeleteResult,
} from 'pyric/sandbox/internal';
```
These shapes describe the per-operation results inside a batch or transaction so adapters can map them onto upstream-SDK return types.

### Error translation helpers
```ts
import {
  FirestoreSimError,
  firestoreErrorFromSimError,
  FIRESTORE_ERROR_CODES,
} from 'pyric/sandbox/internal';
```
Adapters use these to translate simulator-shaped errors into upstream-SDK error shapes (`FirebaseError` with `firestore/permission-denied`-style codes).

### Value resolver
```ts
import {
  resolveValueTree,
  partitionDeletes,
  registerDefaultConverters,
  type ResolveMethod,
} from 'pyric/sandbox/internal';
```
Walk a payload tree, replacing sentinel values (`INCREMENT(1)`, `serverTimestamp()`, etc.) with their resolved equivalents under the current document state.

## What stays out

The `/internal` surface is for adapters to *reach into* the sandbox. It is not a place to wedge half-public APIs that should eventually be promoted. Two rules:

- **No application code imports from `/internal`.** Application code uses the data-plane adapters (`pyric-admin`, `pyric/firestore`), not the substrate.
- **No business logic lives in `/internal`.** Anything that translates user intent (e.g. "patch this update with `FieldValue.increment(1)`") lives in the adapter, not in the substrate. The substrate stores documents and runs rules.

When a method on `LocalEnvironment` starts to look like an application-facing API, the right move is to expose it through an adapter, not through `/internal`.

## Star-export caveat

The `/internal` index uses `export * from '../firestore/local-environment.js'`
and similar to forward every public symbol from the moved files. This is
deliberate. `pyric-admin` reaches in for a long tail of helper symbols, and
listing each one by hand creates maintenance churn.

The downside is that adding a new export in a moved file silently propagates through `/internal`. Adapter packages should treat the `/internal` surface as "everything currently in those files" and not as "exactly these named symbols".
