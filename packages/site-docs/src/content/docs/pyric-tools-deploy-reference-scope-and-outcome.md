---
title: "ProjectScope, Outcome, AdminApiError"
navLabel: "Scope and Outcome"
group: "pyric-tools / deploy"
section: "Reference"
order: 10022
---
# `ProjectScope`, `Outcome`, `AdminApiError`

The three foundation types every primitive and orchestrator in `pyric-tools/deploy` uses.

## `ProjectScope`

```ts
interface ProjectScope {
  readonly projectId: string;
  resolveToken(): Promise<string>;
}
```

Project-level credentials. One scope object instead of `(token, projectId, …)` signatures everywhere.

- **`projectId`**: stable identity for the life of the scope. Frozen at construction time when built via `fromServiceAccount`.
- **`resolveToken`**: host's promise to deliver a fresh-enough OAuth access token with the `https://www.googleapis.com/auth/firebase` and `https://www.googleapis.com/auth/cloud-platform` scopes. Callers invoke per-dispatch. Hosts that care about cost wrap the resolver in `memoizeTtl`.

### Building a scope

Two common paths:

```ts
// Node host — service account JSON. Token caching is built in.
import { fromServiceAccount } from 'pyric-tools/deploy';
const scope = await fromServiceAccount('./service-account.json');

// Browser host — Firebase Auth.
const scope: ProjectScope = {
  projectId,
  resolveToken: () => firebaseAuth.currentUser!.getIdToken(),
};
```

## `Outcome<TData, TErrCode>`

```ts
type Outcome<TData, TErrCode extends string = never> =
  | { ok: true; data: TData }
  | {
      ok: false;
      code: TErrCode | 'permission-denied' | 'unknown';
      message: string;
      partial?: unknown;
    };
```

Returned by orchestrators. Two universal error codes:

- **`'permission-denied'`**: auth or IAM failure. Returned when the upstream API responds 401 or 403, or when the resolver itself rejects with an `AdminApiError` of that status.
- **`'unknown'`**: anything else, including network failures, DNS errors, and any non-`AdminApiError` exception. Deliberately *not* bucketed as `'permission-denied'`, since that would mis-label transport failures as IAM issues.

Each orchestrator widens the union with its own coded error values (`'not-found'`, `'invalid-config'`, `'create-failed'`, `'merge-failed'`, etc.). See [Error codes by operation](../pyric-tools-deploy-reference-error-codes/).

### `partial`

When a batch orchestrator (e.g. `firestore.indexes.deployAll`) fails part-way through, `partial` carries what did succeed before the failure so callers can present a useful diagnostic and decide whether to retry the rest.

## `AdminApiError`

Thrown by primitive (non-orchestrator) functions for non-2xx responses.

```ts
class AdminApiError extends Error {
  readonly status: number;   // HTTP status from upstream
  readonly body: string;     // capped at 8 KiB with [truncated, N bytes] suffix
}
```

`status` lets callers branch on permission (`401` / `403`), not-found (`404`), conflict (`409`), etc. `body` is the upstream payload, capped at 8 KiB so a misbehaving proxy returning a multi-megabyte HTML error page doesn't balloon error chains.

### Catching directly

```ts
import { AdminApiError, firestore } from 'pyric-tools/deploy';

try {
  await firestore.rules.deploy(scope, source);
} catch (e) {
  if (e instanceof AdminApiError) {
    if (e.status === 401 || e.status === 403) {
      // auth / IAM
    } else if (e.status === 400) {
      // invalid source — check e.body for the parser message
    } else {
      // transport, throttle, or unknown
    }
  } else {
    // resolver failure, network, etc.
  }
}
```

### Why throw from primitives

Primitives are intentionally low-level: they map one REST call to one TypeScript function. Throwing lets callers reach for finer-grained error handling than an `Outcome` union allows (an HTTP status, the full body). Orchestrators wrap primitives in `withResolvedScope` to translate thrown errors into `Outcome` shapes for callers that want one shape across all operations.

See [Primitives throw, orchestrators return](../pyric-tools-deploy-explanation-primitives-vs-orchestrators/) for the design rationale.
