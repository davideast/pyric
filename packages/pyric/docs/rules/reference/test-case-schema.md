# `FirestoreCase` schema

`FirestoreCase` is the unit of work for `firestoreRules(source).simulate(cases)` and `firestoreRules(source).explain(oneCase)`, both from `pyric/rules`. It's structurally identical to the engine-internal `TestCase` type (`pyric/rules/internal`), re-exported under the public name so callers never need to reach into the engine seam. A Zod schema for the same shape, `TestCaseSchema`, is available on `pyric/rules/internal` for callers that want runtime validation; it is not part of the public contract.

## Required fields

### `description: string`

Human-readable label. Echoed back in each `TestResult.description` so failures point at a specific case.

### `expectation: 'ALLOW' | 'DENY'`

What the rule should decide for this request. On the resulting `CaseResult`, `passed` is `true` when the simulator's `decision` matches; `false` when it differs; `unsupported` is `true` when the simulator abstained.

### `method: 'get' | 'list' | 'create' | 'update' | 'delete'`

The Firestore method under test. Note that the rules engine also recognises the coarser `read` (= `get` ∪ `list`) and `write` (= `create` ∪ `update` ∪ `delete`) groupings in `allow` statements. Those resolve automatically.

### `path: string`

Document path relative to the database, e.g. `'users/alice'` or `'admin/config/secrets/api-keys'`. Leading slashes are tolerated.

For `method: 'list'` the path may also be a COLLECTION path (e.g. `'menuItems'`): the simulator evaluates the document-level match block with the document wildcard hypothetical and `resource` undefined, matching the emulator's query semantics. A note on the result records when this widening applied. Doc-style list paths keep working unchanged.

## Optional fields

### `auth: { uid: string; token?: Record<string, unknown> } | null`

Auth context. Omit (or set `null`) for an unauthenticated request, and `request.auth` will be `null`. `token` populates `request.auth.token`, which is where custom claims land.

### `data: Record<string, unknown>`

The proposed write payload. Becomes `request.resource.data` on write operations. Ignored on `get` and `list` (read requests have no proposed write).

### `resource: Record<string, unknown>`

The existing document, if any. Becomes `resource.data` for the rule evaluation. Omit for `create` cases against an empty path, set for `update`/`delete` cases against an existing document, and set for `get` to model the document being read.

### `functionMocks: FunctionMock[]`

Mock results for `get()` and `exists()` calls the rule makes:

```ts
interface FunctionMock {
  function: 'get' | 'exists';
  path: string;                                       // relative to db
  result: Record<string, unknown> | boolean;          // doc data for get; boolean for exists
}
```

For `get`, supply the document data. For `exists`, supply `true` (the mock will produce a document) or `false` (no result, the rule will see absence). Paths are relative. The simulator handles the `/databases/(default)/documents/` prefix.

### `query: ListQuery`

Only honoured for `method: 'list'`. Populates `request.query`:

```ts
interface ListQuery {
  limit?: number;
  offset?: number;
  orderBy?: string;
}
```

Unset fields read as `null` from rules. If your rule reads `request.query.limit`, set it. Otherwise `null < 100` evaluates to `false` and the rule silently denies.

### `requestTime: string`

ISO-8601 timestamp used as `request.time`. Defaults to the wallclock at simulation time. Pin this whenever your rule reads `request.time` to keep tests deterministic. The lint rule `REQUEST_TIME_NOT_PINNED` surfaces unpinned cases, but only through the engine-internal `lintFirestoreRules(source, { testCases })` on `pyric/rules/internal`; the public `lint(source)` and `firestoreRules(source).lint()` don't take a `testCases` option. See [Pin `request.time` for deterministic tests](../how-to/pin-request-time.md).

### `writeMode`

Explicit write-mode discriminator. When set, the simulator runs `projectAfterState(writeMode, resource, data)` to derive both `request.resource.data` and the value `getAfter(path)` returns. When unset, the simulator falls back to "`tc.data` IS the after-state", which is correct for shallow `create` but wrong for nested-map updates.

```ts
type WriteMode =
  | { kind: 'create' }
  | { kind: 'set'; merge: boolean }
  | { kind: 'update' }
  | { kind: 'delete' };
```

| Mode | After-state |
|---|---|
| `{ kind: 'create' }` | `data` (asserts the doc did not exist) |
| `{ kind: 'set', merge: false }` | `data` (full replace) |
| `{ kind: 'set', merge: true }` | recursive merge of `resource` and `data` |
| `{ kind: 'update' }` | top-level keys in `data` replace those in `resource`; dot-paths patch nested maps |
| `{ kind: 'delete' }` | `null` |

## Server-timestamp sentinels in `data`

When your write payload contains a server-timestamp sentinel (exactly `{ __type: 'serverTimestamp' }`), the simulator resolves every occurrence to the same `Timestamp` instance (matching `request.time`). Use the `serverTimestamp()` value helper for clarity:

```ts
import { serverTimestamp, type FirestoreCase } from 'pyric/rules';

const tc: FirestoreCase = {
  description: 'create stamps createdAt = request.time',
  expectation: 'ALLOW',
  method: 'create',
  path: 'notes/n1',
  auth: { uid: 'alice' },
  data: { ownerId: 'alice', createdAt: serverTimestamp() },
  requestTime: '2026-04-15T12:00:00Z',
};
```

The single-instance invariant matters because `data.createdAt == request.time` succeeds via field-compare on the `Timestamp` wrapper.

## Validation

`TestCaseSchema`, the Zod schema behind `FirestoreCase`, lives on `pyric/rules/internal` (an internal, unstable surface):

```ts
import { TestCaseSchema } from 'pyric/rules/internal';

const parsed = TestCaseSchema.parse(input);  // throws on schema mismatch
```

`TestCaseSchema` is a Zod schema, so you can also `safeParse` it or compose it into your own validators.
