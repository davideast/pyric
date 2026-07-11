---
title: "API reference: pyric/database"
navLabel: "API reference"
group: "pyric / database"
section: "Reference"
order: 162
---
# API reference: `pyric/database`

Exact signatures of every public export, grouped by purpose. Sandbox-only behavior is called out per function.

> **Experimental.** Realtime Database is not part of Pyric's v1-supported surface (that is auth, Firestore, and rules). The modular functions below are verified sandbox-side by unit probes, and the semantics marked with an oracle observation are pinned to recorded production behavior, but most rows are not yet captured against a live project. See the [compatibility matrix](../pyric-database-compat/) before depending on parity.

The package has two surfaces that share one barrel:

1. **The modular SDK mirror.** Free functions shaped like `firebase/database` (`getDatabase`, `ref`, `get`, `set`, `onValue`, `query`, ...) that route to an in-process sandbox backend or a real Firebase backend depending on what you pass to `getDatabase`. Also importable on its own as `pyric/database/modular`.
2. **The agent-tool and rules toolkit.** The `RtdbHost` contract, `getRtdbTools`, the `createRtdb*Tools` factories, and the handler and schema exports behind them.

The rules constraint DSL (`atoms`, `policies`, `compose`, `ruleset`) lives on a separate subpath, `pyric/database/constraints`, and is documented in [rules-tooling.md](../pyric-database-reference-rules-tooling/).

---

## Initialization

### `getDatabase(target)`
```ts
function getDatabase(ctx: SandboxContext): Database;
function getDatabase(sandbox: Sandbox): Database;
function getDatabase(app: FirebaseApp): Database;
function getDatabase(app: PyricApp): Database;
```
Build a `Database` handle. Four overloads dispatch by input shape:

- `SandboxContext` (from `sandbox.withAuth(...)`): sandbox-backed with a frozen identity.
- `Sandbox`: sandbox-backed with a live identity. Each operation reads `sandbox.currentUser` at call time, so a `pyric/auth` sign-in flips the next operation's `request.auth` without re-binding.
- `FirebaseApp`: prod-backed, delegates to `firebase/database`.
- `PyricApp`: unwraps to the sandbox or prod path above based on the app's target.

One backend per `Sandbox`: repeat calls for the same sandbox return handles that share data, matching `firebase/database`'s singleton-per-app behavior. The sandbox tree also registers as a persistable service, so `enablePersistence` includes RTDB data in the serialized blob and restores it on reload.

### `getAdminDatabase(target)`
```ts
function getAdminDatabase(sandbox: Sandbox): Database;
function getAdminDatabase(ctx: SandboxContext): Database;
function getAdminDatabase(app: PyricApp): Database;
```
Sandbox-only rules-bypass handle, the RTDB counterpart of `getAdminFirestore`. Reads and writes through it skip rule evaluation. A prod-backed `PyricApp` throws a `TypeError`: a client-side app has no way to bypass deployed security rules.

### `connectDatabaseEmulator(db, host, port, options?)`
```ts
function connectDatabaseEmulator(
  db: Database,
  host: string,
  port: number,
  options?: { mockUserToken?: string | EmulatorMockTokenOptions },
): void;
```
Sandbox: no-op. The call is accepted so wiring code compiles and runs against both targets, but it changes nothing, because the sandbox already runs in-process. Prod: delegates to `firebase/database.connectDatabaseEmulator`.

### `TARGET_SYMBOL`
```ts
const TARGET_SYMBOL: unique symbol;
```
The hidden brand on every `Database` handle that routes each free function to its backend. Exported so advanced callers can detect a Pyric handle; there is no reason to read it in application code.

---

## Refs, reads, and writes

### `ref(db, path?)`
```ts
function ref(db: Database, path?: string): DatabaseReference;
```
Build a `DatabaseReference` at `path` (default root). Leading and trailing slashes are stripped; an empty path or `'/'` is the root. Refs carry their routing internally, so every function below accepts a ref without the `db` handle.

### `child(parent, path)`
```ts
function child(parent: DatabaseReference, path: string): DatabaseReference;
```
Ref at `<parent>/<path>`. Empty segments are stripped; the result inherits the parent's target.

### `get(refOrQuery)`
```ts
function get(r: DatabaseReference | Query): Promise<DataSnapshot>;
```
One-shot read. An absent path resolves to a snapshot where `val()` is `null` and `exists()` is `false`. Passing a `Query` returns the ordered, windowed result.

Sandbox reads run through the rule engine. A denial throws a plain `Error` (not a `FirebaseError`) with `code === 'PERMISSION_DENIED'` and message `'PERMISSION_DENIED: Permission denied'`, the exact shape recorded from production (oracle `rtdb-rules-denied-error-code.json`).

### `set(ref, value)`
```ts
function set(r: DatabaseReference, value: unknown): Promise<void>;
```
Replace the value at the ref's path. `set(ref, null)` deletes, the RTDB invariant (oracle `rtdb-remove-vs-set-null.json`). `serverTimestamp()` and `increment()` sentinels resolve at write time.

### `update(ref, values)`
```ts
function update(r: DatabaseReference, values: Record<string, unknown>): Promise<void>;
```
Partial update with two modes, decided by the keys:

- Keys containing `/` make it a multi-path atomic update: every listed path is written as one transaction, and any denial fails the whole batch.
- Plain keys make it a shallow merge at the ref's path: each top-level key replaces the corresponding child, and `null` values delete.

### `remove(ref)`
```ts
function remove(r: DatabaseReference): Promise<void>;
```
Delete the subtree at the ref's path. Dispatches through the same path as `set(ref, null)`.

### `push(ref, value?)`
```ts
function push(r: DatabaseReference, value?: unknown): ThenableReference;
```
Mint an auto-id child key under the ref's path, optionally writing `value` there. The key is minted client-side: the returned ref and its `.key` are available synchronously, even when the optional write is later denied by rules (the denial rejects the thenable's promise instead of throwing). Keys are 20 characters, start with `-`, and sort lexicographically by creation time (oracle `rtdb-push-autoid-format.json`).

### `pushKey()`
```ts
function pushKey(): string;
```
Pre-mint a push key without writing. Useful when a multi-path `update` needs the key up front:
```ts
const key = pushKey();
await update(ref(db), { [`/users/${key}/name`]: 'Alice', [`/index/${key}`]: true });
```
---

## Listeners

All subscribe functions return an `Unsubscribe` (`() => void`). Calling it twice is a no-op. A listener callback that throws is swallowed, matching `firebase/database`, so one observer's exception never blocks others.

### `onValue(refOrQuery, cb, options?)`
```ts
function onValue(
  r: DatabaseReference | Query,
  cb: (snap: DataSnapshot) => void,
  options?: { onlyOnce?: boolean },
): Unsubscribe;
```
Fires immediately on subscribe with the current value (`null` and `exists: false` for an absent path), then on every write touching the path or a descendant. With `onlyOnce: true` the listener auto-unsubscribes after its first fire.

On a `Query`, the listener fires only when the windowed result changes: a write outside the window does not re-fire it, a write inside or one that displaces a member does (oracle `rtdb-modular-onvalue-with-query.json`).

Subscribing under rules that deny the read throws the `PERMISSION_DENIED` plain-`Error` shape synchronously.

### `onChildAdded(refOrQuery, cb)`
```ts
function onChildAdded(r: DatabaseReference | Query, cb: (snap: DataSnapshot) => void): Unsubscribe;
```
On subscribe, replays every existing direct child (one fire per key). After that, fires exactly once per new direct child. On a `Query`, a child entering the window fires, and the current window is replayed in window order on subscribe.

### `onChildChanged(refOrQuery, cb)`
```ts
function onChildChanged(r: DatabaseReference | Query, cb: (snap: DataSnapshot) => void): Unsubscribe;
```
No initial replay. Fires when an existing direct child transitions to a new non-null value; the snapshot carries the new value. Does not fire for added or removed children.

### `onChildRemoved(refOrQuery, cb)`
```ts
function onChildRemoved(r: DatabaseReference | Query, cb: (snap: DataSnapshot) => void): Unsubscribe;
```
No initial replay. Fires when a direct child is deleted (`remove(child)` or `set(child, null)`); the snapshot carries the prior, now-removed value. On a `Query`, a child leaving the window (displaced past a `limitTo*` boundary, or filtered out) also fires with its prior value.

### `onChildMoved(refOrQuery, cb)`
```ts
function onChildMoved(r: DatabaseReference | Query, cb: (snap: DataSnapshot) => void): Unsubscribe;
```
Only meaningful under an ordered query; under a plain ref the subscription is accepted but never fires, matching the upstream SDK. **Sandbox divergence:** the sandbox accepts the subscription on a query but does not yet fire on reorders, while production does. The reorder and `previousChildName` semantics are held pending fresh oracle captures. This is a documented, pinned divergence.

### `off(ref, eventType?, callback?)`
```ts
function off(
  r: DatabaseReference,
  eventType?: 'value' | 'child_added' | 'child_changed' | 'child_removed' | 'child_moved',
  callback?: (snap: DataSnapshot) => void,
): void;
```
Unsubscribe variant (oracle `rtdb-modular-off-stops-child-fires.json`):

- `off(ref)` removes all listeners at the ref, value and every child variety.
- `off(ref, eventType)` removes only that variety.
- `off(ref, eventType, cb)` removes only the matching callback; an unregistered callback is a silent no-op.

The unsubscribe function returned by `onValue` / `onChild*` is equivalent to the three-argument form for that registration. Both work.

---

## Transactions and write sentinels

### `runTransaction(ref, transactionUpdate, options?)`
```ts
function runTransaction<T>(
  r: DatabaseReference,
  transactionUpdate: (current: T | null) => T | undefined,
  options?: { applyLocally?: boolean },
): Promise<TransactionResult>;
```
Atomic read-modify-write. The oracle-locked contract:

1. `transactionUpdate` receives the current value; an absent path passes `null`, not `undefined`.
2. Returning `undefined` aborts: resolves `{ committed: false, snapshot }` where the snapshot is the pre-transaction value.
3. Returning a defined value writes it (rules-checked): resolves `{ committed: true, snapshot }` with the committed value.
4. A rules denial rejects with a plain `Error` whose message is `'permission_denied'` (lowercase) and no `.code` field. This is deliberately different from `set`/`get`'s denial shape; production behaves this way (oracle `rtdb-modular-runtransaction-on-rules-denied-path.json`).

`options.applyLocally` (default `true`): when `false`, listeners skip the optimistic intermediate value and see only the committed one. The single-client sandbox has no other writer to conflict with, so the update function runs once; the documented retry-on-conflict path never engages.

### `serverTimestamp()`
```ts
function serverTimestamp(): ServerTimestampSentinel;
```
Returns the `{ '.sv': 'timestamp' }` sentinel. Resolves to epoch milliseconds (a number) at write time on both targets (oracle `rtdb-servertimestamp-resolves.json`). The sentinel type itself is not exported; treat the return value as opaque.

### `increment(delta)`
```ts
function increment(delta: number): IncrementSentinel;
```
Returns the `{ '.sv': { increment: delta } }` sentinel that atomically adds `delta` to the value at the written field. Starts from `0` when the field is absent or non-numeric (oracle `rtdb-modular-increment-from-missing.json`).

---

## Query builder

### `query(refOrQuery, ...constraints)`
```ts
function query(refOrQuery: DatabaseReference | Query, ...constraints: QueryConstraint[]): Query;
```
Wrap a ref in an immutable constraint chain, then pass the result to `get`, `onValue`, or the `onChild*` listeners. Chaining folds: `query(query(ref, orderByChild('x')), limitToFirst(2))` merges both constraints into one spec. On prod the chain delegates to `firebase/database.query()`, so wire encoding and index checks happen upstream exactly as usual.

### Ordering constraints
```ts
function orderByChild(path: string): QueryConstraint;
function orderByKey(): QueryConstraint;
function orderByValue(): QueryConstraint;
```
- `orderByChild(path)` orders children by the value at a nested child path (oracle `rtdb-modular-orderbychild-window.json`).
- `orderByKey()` orders lexicographically by key string (oracle `rtdb-modular-orderbykey-window.json`).
- `orderByValue()` orders by primitive value. Production requires `.indexOn: ".value"` and throws `Index not defined` without it; the sandbox does not enforce indexes (oracle `rtdb-modular-orderbyvalue-numeric.json`).

### Bound constraints
```ts
function startAt(value: JsonValue, key?: string): QueryConstraint;
function startAfter(value: JsonValue, key?: string): QueryConstraint;
function endAt(value: JsonValue, key?: string): QueryConstraint;
function endBefore(value: JsonValue, key?: string): QueryConstraint;
function equalTo(value: JsonValue, key?: string): QueryConstraint;
```
`startAt` and `endAt` are inclusive; `startAfter` and `endBefore` are exclusive (oracle `rtdb-modular-startafter-endbefore-exclusive.json`). The optional `key` breaks ties when ordering by child or value and several children share the bound's value. `equalTo(v, key?)` is sugar for `startAt(v, key)` plus `endAt(v, key)` and returns all matching children, with no uniqueness assumption (oracle `rtdb-modular-equalTo-filter.json`).

### Limit constraints
```ts
function limitToFirst(n: number): QueryConstraint;
function limitToLast(n: number): QueryConstraint;
```
Keep the first or last `n` children of the ordered window (oracle `rtdb-modular-limittofirst-vs-limittolast.json`).

### `QUERY_SYMBOL`
```ts
const QUERY_SYMBOL: unique symbol;
```
The brand on every `Query`, used internally to dispatch `get` / `onValue` between plain refs and query-wrapped refs. Exported for detection; not needed in application code.

---

## The sandbox namespace

Sandbox lifecycle operations the prod target does not ship. Every method throws a plain `Error` when called with a prod-backed handle.
```ts
const sandbox: {
  setRules(db: Database, rulesJson: { rules: Record<string, unknown> } | null): void;
  setData(db: Database, data: Record<string, unknown>): void;
  snapshotState(db: Database): JsonValue;
};
```
- `setRules(db, rulesJson)` replaces the deployed rules. Pass `null` to clear; the sandbox returns to default-allow. Rules evaluate through the same simulator engine that backs `simulate()` and the `rtdb_simulate_access` tool.
- `setData(db, data)` bulk-loads fixtures bypassing rules. Keys are absolute paths (`'/users/alice'`); values land at those paths.
- `snapshotState(db)` reads the full tree bypassing rules. Usually a keyed object; a primitive when the root holds one.

---

## Host contract and tool factories

This is the surface agents and MCP registries consume. Deep tool semantics (arguments, result shapes, workflows) live in the repository's `docs/agent-tools.md`.

### `RtdbHost`
```ts
interface RtdbHost {
  readonly projectId: string;
  readonly databaseUrl: string;
  resolveAdminToken(): Promise<string>;
  resolveUserToken(auth: UserAuth): Promise<string>;
  getClientForUser(auth: UserAuth): Promise<Database>; // firebase/database Database
}
```
What the toolkit needs from its caller to talk to a real Realtime Database. `resolveAdminToken` backs the admin REST paths (IR fetch, rule deploy, crawl without `auth`). `resolveUserToken` mints a Firebase ID token for a `{ uid, claims }` so REST paths can run with rules enforced. `getClientForUser` returns a `firebase/database` instance authenticated as that user, used by the data tools when an `auth` argument is supplied.

### `fetchDatabase(host, path, params?, userToken?)`
```ts
function fetchDatabase(
  host: RtdbHost,
  path: string,
  params?: Record<string, string>,
  userToken?: string,
): Promise<Response>;
```
REST fetch helper for handlers that talk to the RTDB REST API directly. With `userToken`, the request signs as that user via the `auth` query param; otherwise the admin OAuth token rides in an `Authorization: Bearer` header. The path is resolved through the URL API and pinned to the database origin, so inputs like `@evil.com/x` or `//evil.com/x` cannot redirect the request (or the admin credential) off-origin. Redirects are refused (`redirect: 'error'`); a path resolving outside the origin throws.

### `initializeDatabaseApp(agentApp, options?)`
```ts
interface AgentAppLike {
  readonly projectId: string;
  getRestToken(): Promise<string>;
  getUserToken(auth: UserAuth): Promise<string>;
  getClientDatabase(auth: UserAuth, databaseUrl: string): Promise<Database>;
}

function initializeDatabaseApp(
  agentApp: AgentAppLike,
  options?: { databaseUrl?: string },
): RtdbHost;
```
Build an `RtdbHost` from an app-shaped object. The shape is structural, so any credential bundle with these four members works. `databaseUrl` defaults to `https://<projectId>-default-rtdb.firebaseio.com`.

### `getRtdbTools(host)`
```ts
function getRtdbTools(host: RtdbHost): RtdbTools;

interface RtdbTools {
  generateIR(): Promise<GenerateIRResult>;
  simulate(input: unknown): SimulateResult;
  writeRules(ir: RtdbIR): Promise<WriteRulesResult>;
  crawlStructure(options?: CrawlOptions & DataAuthOptions): Promise<CrawlStructureResult>;
  readData(path: string, options?: DataAuthOptions): Promise<DataResult>;
  setData(path: string, data: unknown, options?: DataAuthOptions): Promise<DataResult>;
  updateData(path: string, data: Record<string, unknown>, options?: DataAuthOptions): Promise<DataResult>;
  pushData(path: string, data: unknown, options?: DataAuthOptions): Promise<DataResult>;
  removeData(path: string, options?: DataAuthOptions): Promise<DataResult>;
  validatedWrite(input: ValidatedWriteInput): Promise<ValidatedWriteResult>;
}
```
The programmatic API for direct consumers. `generateIR()` fetches and parses the deployed rules and caches the IR; `simulate(input)` evaluates against that cached IR and fails with `IR_NOT_GENERATED` if you have not called `generateIR()` first. The data methods run as admin unless `options.auth` supplies a `UserAuth`, in which case the operation goes through `host.getClientForUser(auth)` with rules enforced. `DataResult` resolves to `{ success: true; data: unknown }` or `{ success: false; error: { code; message; recoverable } }`; the `DataResult` name itself is not exported from the barrel.

### `createRtdbRulesTools(deps)`
```ts
type RtdbRulesToolDeps = { host: RtdbHost };
function createRtdbRulesTools(deps: RtdbRulesToolDeps): ToolHandler[];
```
The four rules tools as agent-callable `ToolHandler`s: `rtdb_build_expression` (parse, validate, and lint a rule expression), `rtdb_get_rules` (fetch and parse deployed rules into the IR tree), `rtdb_simulate_access` (evaluate a read/write/validate against the loaded rules locally, no network to the database), and `rtdb_deploy_rules` (write a complete rules IR over REST).

### `createRtdbDataTools(deps)`
```ts
type RtdbDataToolDeps = { host: RtdbHost };
function createRtdbDataTools(deps: RtdbDataToolDeps): ToolHandler[];
```
The seven data tools: `rtdb_crawl_structure` (shape discovery without downloading values), `rtdb_get`, `rtdb_set`, `rtdb_update` (merge, or atomic multi-location fan-out when path is `/` with root-relative keys), `rtdb_push`, `rtdb_delete`, and `rtdb_validated_write` (schema inference plus rules simulation before the write commits). Every data tool takes an optional `auth: { uid, claims? }`; with it the operation runs as that user with rules enforced, without it the operation uses admin access. Crawl paths are rejected up front when they contain `//`, backslashes, whitespace, or control characters, with `fetchDatabase`'s origin pinning as the backstop.

### `createRtdbAdminTools(deps)`
```ts
type RtdbAdminToolDeps = { host: RtdbHost };
function createRtdbAdminTools(deps: RtdbAdminToolDeps): ToolHandler[];
```
All eleven tools: the concatenation of `createRtdbRulesTools(deps)` and `createRtdbDataTools(deps)`. This is the factory `composeMcpRegistry` consumes.

---

## Handlers

Exported for direct-handler integration tests. The barrel marks them as not part of the stable public API; prefer `getRtdbTools` or the factories.
```ts
class GenerateIRHandler {
  execute(host: RtdbHost): Promise<GenerateIRResult>;
}
class SimulateHandler {
  execute(ir: RtdbIR | null, rawInput: unknown): SimulateResult;
}
class WriteRulesHandler {
  execute(host: RtdbHost, ir: RtdbIR): Promise<WriteRulesResult>;
}
class CrawlStructureHandler {
  execute(host: RtdbHost, options?: CrawlOptions, userToken?: string): Promise<CrawlStructureResult>;
}
class DataHandler {
  execute(
    host: RtdbHost,
    operation: 'get' | 'set' | 'update' | 'push' | 'remove',
    path: string,
    data?: unknown,
    auth?: UserAuth,
  ): Promise<DataResult>;
}
```
Each handler is the implementation behind the matching `RtdbTools` method. `SimulateHandler.execute` is synchronous and takes the IR explicitly (returning `IR_NOT_GENERATED` on `null`); the rest talk to the database through the host.

---

## Rules IR mapper

### `buildRuleExpression(raw, context, pathVariables?)`
```ts
function buildRuleExpression(
  raw: string,
  context: 'read' | 'write' | 'validate',
  pathVariables?: string[],
): RtdbRuleExpression;
```
Parse, validate, and lint one rule expression. The result carries the raw string plus parse validity, errors, warnings, and the identifiers the expression references.

### `RtdbMapper`
```ts
class RtdbMapper {
  static mapToRulesJSON(ir: RtdbIR): { rules: Record<string, unknown> };
  static mapToIR(
    rulesJson: unknown,
    shallowData: Record<string, true | 1> | null,
    databaseUrl: string,
  ): RtdbIR;
}
```
Round-trip between deployable rules JSON and the parsed IR tree (`RtdbNode` nodes with per-node `read`/`write`/`validate` expressions, `indexOn`, and path variables). `shallowData` is a shallow root fetch used to mark which top-level paths exist. Both directions throw on malformed input.

---

## Replay

### `replay(events, opts)`
```ts
function replay(
  events: readonly SandboxEvent[],
  opts: RtdbReplayOptions,
): Promise<RtdbReplayResult>;

interface RtdbReplayOptions {
  rules: { rules: Record<string, unknown> };
  capturedState?: unknown;
  databaseUrl?: string;
}

interface RtdbReplayResult {
  ok: boolean;
  sandbox: Sandbox;
  checkedEvents: number;
  replayedState: unknown;
  divergences: RtdbReplayDivergence[];
}
```
Re-issue captured RTDB commits (`set`, `remove`, `update`, `transaction`) against a fresh sandbox running a candidate ruleset, and report divergence. With `capturedState`, the tree is rewound to the pre-session state first and final state drift is diffed path by path. `RtdbReplayDivergence` is a union of `now-denied` (a previously allowed write the candidate rules reject), `state-drift` (final values differ), and `unsupported` (a commit shape replay cannot re-issue). Admin-flagged commits replay through the rules-bypass handle and do not count toward `checkedEvents`.

---

## Schemas and error codes

Runtime values, mostly Zod schemas, exported for input validation at the tool boundary.

| Export | What it is |
|---|---|
| `GenerateIRInputSchema` | `{ databaseUrl: string (url) }` |
| `RtdbIRErrorCode` | enum: `RULES_FETCH_FAILED`, `RULES_PARSE_FAILED`, `INVALID_RULES_JSON`, `SHALLOW_FETCH_FAILED` |
| `SimulationInputSchema` | `{ operation: 'read' \| 'write' \| 'validate', path (leading `/`), auth: { uid, token } \| null, mockData, newData? }` |
| `SimulateErrorCode` | enum: `IR_NOT_GENERATED`, `INVALID_INPUT`, `NO_MATCHING_RULE`, `EVALUATION_ERROR` |
| `SimulationResultSchema` | `{ allowed, matchedPath, matchedRule, reason, pathVariableBindings }` |
| `ValidatedWriteInputSchema` | `{ path, data (nullish coerced to null), operation: 'set' \| 'update' \| 'push', auth: { uid, token } \| null }` |
| `WriteRulesErrorCode` | enum: `WRITE_FAILED`, `PERMISSION_DENIED`, `INVALID_RULES_JSON` |
| `CrawlErrorCode` | enum: `CRAWL_FAILED`, `PERMISSION_DENIED` |
| `CRAWL_DEFAULTS` | `{ path: '/', maxDepth: 10, maxChildren: 100, maxConcurrency: 5 }` |
| `RtdbIRSchema` | `{ service: 'realtime-database', databaseUrl, rules }` |
| `RuleErrorSchema`, `RuleLintSchema` | `{ code, message }` |
| `ParsedExpressionSchema` | `{ raw, valid, errors, warnings, referencedIdentifiers }` |
| `RtdbRuleExpressionSchema` | `{ raw, parsed }` |

---

## Types

Modular SDK types:

| Type | Shape |
|---|---|
| `Database` | Opaque handle branded with `TARGET_SYMBOL`. |
| `DatabaseReference` | `key` (last segment, `null` at root), `parent` (`null` at root), `root`, `toString()` (sandbox refs stub a `sandbox://rtdb/...` URL). |
| `DataSnapshot` | `key`, `ref`, `size` (child count, a getter, not a `numChildren()` method), `priority` (always `null` on sandbox), `exists()`, `val()`, `child(path)`, `hasChild(path)`, `hasChildren()`, `exportVal()`, `toJSON()`, `forEach(cb)` (return `true` to stop early; query snaps iterate in window order). |
| `TransactionResult` | `{ committed: boolean, snapshot: DataSnapshot }`. |
| `ThenableReference` | A `DatabaseReference` with `then`/`catch` attached; `push`'s return type. |
| `Query` | A ref plus an immutable constraint chain, branded with `QUERY_SYMBOL`. |
| `QueryConstraint` | Opaque constraint; `type` is the constraint name string (`'orderByChild'`, `'limitToFirst'`, ...). |
| `Unsubscribe` | `() => void`. |

Toolkit types:

| Type | Shape |
|---|---|
| `UserAuth` | `{ uid: string, claims?: Record<string, unknown> }`. Identity for user-mode operations; omit for admin. |
| `DataAuthOptions` | `{ auth?: UserAuth }`. |
| `RtdbIR` | `{ service: 'realtime-database', databaseUrl, rules }`. |
| `RtdbNode` | Rule-tree node: `path`, `pathVariables`, `exists`, optional `read`/`write`/`validate` expressions, `indexOn`, `children`. |
| `RtdbRuleExpression`, `ParsedExpression`, `RuleError`, `RuleLint` | Expression parse results, per the schemas above. |
| `RtdbTools` | Return type of `getRtdbTools`, listed in full above. |
| `RtdbAdminToolDeps`, `RtdbDataToolDeps`, `RtdbRulesToolDeps` | All `{ host: RtdbHost }`. |
| `GenerateIRInput`, `GenerateIRResult`, `GenerateIRSpec` | IR generation input, result union, and handler interface. |
| `SimulationInput`, `SimulationResult`, `SimulateResult` | Simulation input, verdict, and result union. |
| `ValidatedWriteInput`, `ValidatedWriteResult` | Validated-write input and result (with `schemaWarnings` and `simulationResult`). |
| `WriteRulesResult`, `WriteRulesSpec` | Deploy result union and handler interface. |
| `CrawlOptions`, `CrawlStructureResult`, `CrawlStructureSpec`, `StructureNode` | Crawl input, result union, handler interface, and the structure tree node. |
| `AgentAppLike` | Structural input to `initializeDatabaseApp`, listed above. |
| `RtdbReplayOptions`, `RtdbReplayResult`, `RtdbReplayDivergence` | Replay input, result, and divergence union. |

`pyric/database/modular` additionally re-exports the types `Sandbox`, `SandboxContext`, `AuthState`, `FirebaseApp`, and `JsonValue` for convenience.

---

## Boundaries

- **The whole service is experimental.** Sandbox behavior is verified by unit probes; only the semantics with an oracle citation are pinned to recorded production behavior. See the [compatibility matrix](../pyric-database-compat/) for the row-by-row state.
- `onChildMoved` on a sandbox query registers but never fires on reorder; production fires. Pinned divergence, held pending new oracle captures.
- The sandbox does not enforce `.indexOn`. An `orderByValue()` query that throws `Index not defined` in production succeeds in the sandbox.
- Priority is not modeled: `DataSnapshot.priority` is always `null` and `exportVal()` equals `val()`.
- `DataSnapshot.size` is a getter; there is no `numChildren()` method (that was the legacy namespaced API).
- Sandbox transactions run the update function once. There is no concurrent writer, so the retry-on-conflict path never engages.
- Two distinct denial shapes, both matching production: `get`/`set`/`update`/`remove`/`onValue` throw a plain `Error` with `code: 'PERMISSION_DENIED'`; `runTransaction` rejects with message `'permission_denied'` and no `code`.
- `connectDatabaseEmulator` is a no-op on sandbox handles.
- `getAdminDatabase` throws a `TypeError` for a prod-backed app, and every `sandbox.*` method throws on a prod handle.
- Passing a ref that was not produced by this package throws a `TypeError` from the routing layer.
- The handler classes (`DataHandler`, `GenerateIRHandler`, `WriteRulesHandler`, `CrawlStructureHandler`, `SimulateHandler`) are exported for integration tests and are not a stable API.

For the rules constraint DSL and deploy workflow, see [rules-tooling.md](../pyric-database-reference-rules-tooling/). For coverage against `firebase/database`'s full surface, see the [compatibility matrix](../pyric-database-compat/).
