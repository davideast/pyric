---
title: "The /internal adapter protocol"
navLabel: "The /internal protocol"
group: "pyric / sandbox"
section: "Explanation"
order: 14020
---
# The `/internal` adapter protocol

`pyric/sandbox` ships a second sub-path: `pyric/sandbox/internal`. The public entry stays narrow: `Sandbox`, `SandboxContext`, `SandboxError`, listener channels, lifecycle. Anything an adapter needs but a consumer shouldn't reach for lives behind the `/internal` gate.

This page explains the gate and what it implies for adapter authors.

## What's behind the gate

The substrate's runtime types: `LocalEnvironment`, `EventLog`, transaction primitives, sentinel converters, error translation helpers. Adapter packages (`pyric-admin`, `pyric/firestore`) consume these to translate user-facing SDK calls into substrate operations.

The full list is documented in [The `/internal` adapter protocol](../pyric-sandbox-reference-internal-protocol/).

## Why a gate at all

Three reasons to hide a surface behind a sub-path:

1. **Discourage application use.** App code that imports from `/internal` is reaching past the public API. The path name is the warning.
2. **Permit breakage between minor versions.** The public API is semver-stable. `/internal` is not. Its shape evolves with the substrate's needs.
3. **Document the dependency direction.** Adapters depend on `/internal`; the substrate doesn't depend on adapters. The gate makes the direction visible.

The gate is by convention, not enforcement. `pyric/sandbox/internal` is a regular subpath export. TypeScript will happily resolve it from application code. The conventional discouragement is the point. The type name, the path name, and the documentation all say "this is for adapter authors". Authors who reach past it accept the breakage risk.

## How adapters use it

A typical adapter does three things with `/internal`:

### 1. Resolve the runtime substrate

```ts
import { getInternalEnv } from 'pyric/sandbox/internal';
import type { SandboxContext } from 'pyric/sandbox';

function getFirestore(ctx: SandboxContext): FirestoreHandle {
  const env = getInternalEnv(ctx.sandbox);
  return buildHandleAroundEnv(env, ctx.auth);
}
```

`getInternalEnv` throws if the `Sandbox` wasn't produced by `initializeSandbox`, so adapters can rely on it to reject malformed input early.

### 2. Translate user calls to substrate operations

```ts
import type { Operation, OperationResult } from 'pyric/sandbox/internal';

async function set(handle, path, data) {
  const operation: Operation = {
    method: data ? 'set' : 'delete',
    path,
    auth: handle.auth,
    data,
  };
  const result: OperationResult = handle.env.execute(operation);
  if (!result.allowed) throw translateError(result.error);
  return result;
}
```

Operations are plain shapes. Each adapter writes its own translation logic: `pyric-admin` translates chainable calls, `pyric/firestore` translates modular function calls. Both produce `Operation` and consume `OperationResult`.

### 3. Resolve sentinels

```ts
import { resolveValueTree, registerDefaultConverters } from 'pyric/sandbox/internal';
```

Sentinels (`FieldValue.increment`, `serverTimestamp`, `arrayUnion`) are values the substrate doesn't store directly. They describe an operation on the current document. The adapter resolves them via `resolveValueTree(payload, env, method)` before handing the payload to `LocalEnvironment.execute`.

## What adapters shouldn't do

### Treat `/internal` as a stable API surface

The shape changes when the substrate's needs change. Methods get renamed. Types get widened. New parameters appear. The package's semver does not protect `/internal`.

In practice, the surface has been stable for months at a time. The substrate isn't churning. But "stable in practice" is not "stable by contract". Adapter authors should pin to specific versions of `pyric/sandbox` and update deliberately.

### Add business logic to the substrate

If a piece of behaviour translates user intent ("interpret this dot-path update as a nested-map patch", "merge this batch's writes by collection", "schedule this snapshot listener fire after the current micro-task"), it belongs in the adapter, not in `/internal`. The substrate stores documents and runs rules. Anything beyond that is adapter responsibility.

This rule keeps the substrate small. Adapters can differ in their merge semantics, their fire timing, their reference identity model. All of that lives in the adapter, and the substrate doesn't care.

### Import from `/internal` in application code

Application code uses `pyric-admin` or `pyric/firestore`. The reason is forward-compatibility: if a future minor release changes a `/internal` type, the adapter absorbs the change and the application doesn't notice. Application code that imports from `/internal` becomes a breakage liability the next time the substrate evolves.

If an application needs something an adapter doesn't expose, the right move is to file a request on the adapter, not to reach into `/internal` and add the wrapping itself.

## The star-export decision

The `/internal` index uses `export * from '../firestore/local-environment.js'` and similar wildcards. The alternative is a hand-maintained named-export list.

We picked stars because:

- `pyric-admin` reaches in for a long tail of helper symbols (`DELETE_MARKER`, `KEEP`, `FIRESTORE_ERROR_CODES`, etc.). The list is dozens of entries.
- Keeping the named-export list in sync with the moved files' actual exports creates maintenance churn. Every new export needs two changes.
- Star exports propagate automatically. Add a new export to a moved file, it appears at `pyric/sandbox/internal`.

The downside is that adding a new public export in a moved file silently appears on `/internal` without an explicit decision. We accept that: anything in those files is intended to be reachable by adapters; the gate isn't there to filter, it's there to label the surface.

## Will `/internal` ever be promoted?

When the multi-service architecture lands (Auth, RTDB, Storage all sharing one `LocalEnvironment`) the substrate's surface will need to stabilise. At that point parts of `/internal` will likely be promoted to the public API, probably the parts adapters need most (`Operation`, `OperationResult`, sentinel conversion).

Promotion will be deliberate. Each symbol that moves to the public API gets:

- A documented contract on the public reference page.
- Semver protection going forward.
- A removal from `/internal` (or kept as a re-export for adapter compatibility).

Until then, `/internal` is the place where the protocol evolves.
