# `SandboxError` codes

Every error the sandbox raises is a `SandboxError` carrying a `code`. Catch with `instanceof SandboxError`, switch on `code`.

```ts
import { SandboxError } from 'pyric/sandbox';

try {
  await aliceDb.collection('admin').doc('x').set({ value: 1 });
} catch (e) {
  if (e instanceof SandboxError && e.code === 'permission-denied') {
    console.log('Rules said no:', e.denialContext);
  }
}
```

## Firebase-aligned codes

These match Firebase / gRPC conventions so production-shaped `catch (e) { if (e.code === 'permission-denied') }` code keeps working.

### `'invalid-argument'`

Caller passed something the API does not accept. Common cases:

- `sandbox.withAuth(undefined)` — say `withAuth(null)` explicitly.
- `sandbox.withAuth({ uid: '' })` — UID must be non-empty.
- `sandbox.withAuth({ uid: 'x', token: 'oops' })` — `token` must be an object.
- Hand-rolled `Sandbox` handle passed to a service factory (via `getInternalEnv` from `/internal`).

Errors of this kind carry `remediation` text explaining the fix.

### `'permission-denied'`

Rules denied the operation. The `denialContext` field is populated with:

- `auth` — the identity that was active.
- `reasons` — the simulator's debug messages (one per evaluated rule).
- `request` — the eval-time `request.*` shape (method, path, resource data).
- `resource` — the eval-time `resource.*` (existing doc, exists flag).
- `rule` (best-effort) — line and expression source.

See the [`SandboxEvent` reference](./sandbox-event.md) — `DenialContext` mirrors the `kind: 'request' && result: 'deny'` event shape.

### `'not-found'`

Operation referenced a document that does not exist:

- `update` against a non-existent document.
- `transaction` reading a path that's gone.

### `'already-exists'`

`create` against a path that already has a document. (Plain `set` overwrites; `create` insists on absence.)

### `'failed-precondition'`

The operation could not run in the current state, for reasons other than missing/extra docs:

- Read-after-write violation inside a transaction.
- Ambiguous post-delete reference.

### `'aborted'`

A transaction was aborted, typically because its callback threw. The thrown error propagates synchronously; the event log marks the transaction as aborted and excludes it from undo.

### `'unavailable'`

Reserved. Not currently emitted — no network stream to drop. May appear if a future service has a transport.

## Sandbox-specific codes

These don't have a production analog. They exist so callers can distinguish "the sandbox doesn't model this" from "your rule is wrong" without parsing messages.

### `'unimplemented'`

The sandbox doesn't yet model a feature your rule uses. Returned from the simulator's `UnsupportedError` channel surfaced through this code. For most agent workflows the right response is to route the offending case to the live Firebase Rules Test API — see [`pyric/rules`](../../rules/explanation/simulator-vs-rules-test-api.md).

### `'not-seeded'`

An operation was issued before `LocalEnvironment.seed` provided rules. The default state is empty, with no rules — most operations will deny under default-deny semantics, but some surfaces (admin reads, listing operations) raise this code instead so it's obvious the sandbox hasn't been initialised.

### `'rules-not-loaded'`

Similar to `'not-seeded'`, but specifically signals that rules haven't been deployed yet. Use `LocalEnvironment.deployRules(source)` or seed with `rules` before issuing operations that need to evaluate.

## Constructing errors yourself

Two forms:

```ts
// Positional — backwards-compatible.
throw new SandboxError('permission-denied', 'Denied: …', denialContext);

// Options bag — use when attaching remediation.
throw new SandboxError({
  code: 'invalid-argument',
  message: 'withAuth() needs an explicit AuthState.',
  remediation: 'For anonymous: withAuth(null). For users: withAuth({ uid: "…" }).',
});
```

When `remediation` is set, it is appended to the error's `.message` with a blank-line separator so consumers that surface `.message` (logs, UIs) see the guidance without an API change. The structured form is also available on the instance as `error.remediation`.

## What carries `denialContext`

Only `'permission-denied'` errors. Every other code has `denialContext: undefined`. Consumers branching on `denialContext` should check the code first.

The exact field set depends on the operation:

| Operation | `request` | `resource` |
|---|---|---|
| `get` | method=`'get'`, path | data + exists for the existing doc |
| `list` | method=`'list'`, path | — (collection ops; resource not modelled per-doc) |
| `create` | method=`'create'`, path, resourceData | data=`null`, exists=`false` |
| `update` | method=`'update'`, path, resourceData | data + exists for the existing doc |
| `delete` | method=`'delete'`, path | data + exists for the existing doc |

`resourceData` reflects the post-sentinel-resolution payload — what the rule actually saw on `request.resource.data`.
