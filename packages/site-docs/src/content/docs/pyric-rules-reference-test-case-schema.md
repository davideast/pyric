---
title: "TestCase schema"
group: "pyric / rules"
section: "Reference"
order: 106
---
# `TestCase` schema

`TestCase` is the unit of work for both the local simulator (`SimulateFirestoreRulesHandler`) and the live Rules Test API client (`TestFirestoreRulesHandler`). The Zod schema is exported as `TestCaseSchema`; the inferred type is exported as `TestCase`.

## Required fields

### `description: string`

Human-readable label. Echoed back in each `TestResult.description` so failures point at a specific case.

### `expectation: 'ALLOW' | 'DENY'`

What the rule should decide for this request. The case `PASSED` when the simulator's decision matches; `FAILED` when it differs; `UNSUPPORTED` when the local simulator abstained.

### `method: 'get' | 'list' | 'create' | 'update' | 'delete'`

The Firestore method under test. Note that the rules engine also recognises the coarser `read` (= `get` ∪ `list`) and `write` (= `create` ∪ `update` ∪ `delete`) groupings in `allow` statements — those resolve automatically.

### `path: string`

Document path relative to the database, e.g. `'users/alice'` or `'admin/config/secrets/api-keys'`. Leading slashes are tolerated.

For `method: 'list'` the path may also be a COLLECTION path (e.g. `'menuItems'`): the simulator evaluates the document-level match block with the document wildcard hypothetical and `resource` undefined — the emulator's query semantics. A note on the result records when this widening applied. Doc-style list paths keep working unchanged.

## Optional fields

### `auth: { uid: string; token?: Record<string, unknown> } | null`

Auth context. Omit (or set `null`) for an unauthenticated request — `request.auth` will be `null`. `token` populates `request.auth.token`, which is where custom claims land.

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
For `get`, supply the document data. For `exists`, supply `true` (the mock will produce a document) or `false` (no result, the rule will see absence). Paths are relative — the simulator handles the `/databases/(default)/documents/` prefix.

### `query: ListQuery`

Only honoured for `method: 'list'`. Populates `request.query`:
```ts
interface ListQuery {
  limit?: number;
  offset?: number;
  orderBy?: string;
}
```
Unset fields read as `null` from rules. If your rule reads `request.query.limit`, set it — otherwise `null < 100` evaluates to `false` and the rule silently denies.

### `requestTime: string`

ISO-8601 timestamp used as `request.time`. Defaults to the wallclock at simulation time. Pin this whenever your rule reads `request.time` to keep tests deterministic. The lint rule `REQUEST_TIME_NOT_PINNED` surfaces unpinned cases when you pass `testCases` to `lintFirestoreRules`.

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

When your write payload contains a server-timestamp sentinel — exactly `{ __type: 'serverTimestamp' }` — the simulator resolves every occurrence to the same `Timestamp` instance (matching `request.time`). Use the exported `SERVER_TIMESTAMP` constant for clarity:
```ts
import { SERVER_TIMESTAMP } from 'pyric/rules';

const tc: TestCase = {
  description: 'create stamps createdAt = request.time',
  expectation: 'ALLOW',
  method: 'create',
  path: 'notes/n1',
  auth: { uid: 'alice' },
  data: { ownerId: 'alice', createdAt: SERVER_TIMESTAMP },
  requestTime: '2026-04-15T12:00:00Z',
};
```
The single-instance invariant matters because `data.createdAt == request.time` succeeds via field-compare on the `Timestamp` wrapper.

## Validation
```ts
import { TestCaseSchema } from 'pyric/rules';

const parsed = TestCaseSchema.parse(input);  // throws on schema mismatch
```
`TestCaseSchema` is a Zod schema, so you can also `safeParse` it or compose it into your own validators.
