---
title: "firestore namespace"
group: "pyric-tools / deploy"
section: "Reference"
order: 62
---
# `firestore` namespace

Firestore rules, indexes, and database provisioning primitives.
```ts
import { firestore } from 'pyric-tools/deploy';
```
Primitives throw `AdminApiError` on non-2xx; orchestrators return `Outcome`-shaped objects. JSDoc on each function marks which it is. See [Primitives throw, orchestrators return](../pyric-tools-deploy-explanation-primitives-vs-orchestrators/).

## `firestore.rules`

### `fetch(scope): Promise<string | null>` *(primitive — throws)*

Fetch the deployed Firestore rules source for the project. Returns `null` for greenfield projects that have no `cloud.firestore` release yet.
```ts
const current = await firestore.rules.fetch(scope);
```
### `deploy(scope, source): Promise<void>` *(primitive — throws)*

Deploy a rules source. Two-step server flow: create a new ruleset, then PATCH the release to point at it. Throws on any non-2xx.

### `inject(currentSource, snippet, marker): string | null` *(pure utility)*

Inject a rule snippet into an existing rules source.

- Returns the new source string when the snippet is added.
- Returns `null` when `marker` is already present in the source (no-op).
- Throws when the `match /databases/{database}/documents { ... }` block can't be located.

Strategy: locate the documents-match opening brace and insert the snippet on the next line. Handles the common shape (Firebase Console default + every example in the docs) without parsing.

### `check(scope, marker): Promise<RuleCheckResult>` *(orchestrator)*

Read-only probe: does the deployed ruleset contain `marker`?
```ts
type RuleCheckResult =
  | { state: 'configured' }
  | { state: 'not-configured' }
  | { state: 'no-rules-yet' }
  | { state: 'check-failed'; message: string };
```
Used by UIs to decide whether to surface a "Configure rule" button.

### `ensure(scope, config): Promise<EnsureRuleOutcome>` *(orchestrator)*

Idempotent rule installer.
```ts
async function ensure(scope: ProjectScope, config: {
  marker: string;
  snippet: string;
  freshTemplate: string;
}): Promise<EnsureRuleOutcome>;

type EnsureRuleOutcome =
  | { ok: true; status: 'already-configured' | 'merged' | 'fresh' }
  | {
      ok: false;
      code: 'permission-denied' | 'merge-failed' | 'unknown';
      message: string;
    };
```
Three branches:

- Project has no Firestore rules yet → deploy `freshTemplate`, return `fresh`.
- Rules exist and contain `marker` → no-op, return `already-configured`.
- Rules exist but lack `marker` → inject `snippet`, deploy, return `merged`.

## `firestore.indexes`

### `create(scope, entry, options?): Promise<IndexOperation>` *(primitive — throws)*

Create a single composite index. Returns the long-running-operation handle.

### `deployAll(scope, config, options?): Promise<DeployIndexesOutcome>` *(orchestrator)*

Batch-deploy a `firestore.indexes.json`-shaped config.
```ts
type DeployIndexesOutcome =
  | {
      ok: true;
      operationsStarted: IndexOperation[];
      alreadyExists: number;
      perIndex: PerIndexOutcome[];
    }
  | {
      ok: false;
      code: 'permission-denied' | 'invalid-config' | 'create-failed' | 'unknown';
      message: string;
      partial?: { operationsStarted; alreadyExists; perIndex };
    };
```
Per-entry status: `started` / `already-exists` / `failed`. Aborts the batch on 403. On `ok: false`, `partial` carries what did succeed so callers don't lose info.

### `getStatus(scope, operationName): Promise<GetIndexStatusOutcome>` *(orchestrator)*

Poll a long-running index build operation. `operationName` is the opaque resource path from `create` or from a `deployAll` outcome's `operationsStarted[].name`.
```ts
type GetIndexStatusOutcome =
  | {
      ok: true;
      state: 'CREATING' | 'NOT_FOUND';
      operationName: string;
    }
  | {
      ok: true;
      state: IndexState;
      operationName: string;
      index?: { name; fields };
    }
  | {
      ok: false;
      code: 'permission-denied' | 'build-failed' | 'unknown';
      message: string;
    };
```
## `firestore.databases`

### `provision(scope, options?): Promise<ProvisionDatabaseOutcome>` *(orchestrator)*

Idempotent database provisioning. Probes first via `GET .../databases/<id>`, short-circuits when present.
```ts
interface ProvisionDatabaseOptions {
  databaseId?: string;    // default '(default)'
  locationId?: string;    // default 'nam5'
  type?: 'FIRESTORE_NATIVE' | 'DATASTORE_MODE';   // default 'FIRESTORE_NATIVE'
}

type ProvisionDatabaseOutcome =
  | { ok: true; status: 'created'; operationName: string }
  | { ok: true; status: 'already-exists' }
  | { ok: false; code: 'permission-denied' | 'unknown'; message: string };
```
Required IAM (subsumed by Owner/Editor):

- `datastore.databases.get`
- `datastore.databases.create`

After `created`, the data plane comes online ~30s later. Callers that need strict ordering should poll the long-running operation before issuing writes.

## Index wire shapes

`firestore.indexes.json`-compatible:
```ts
interface IndexesConfig {
  indexes: IndexesConfigEntry[];
  fieldOverrides?: unknown[];
}

interface IndexesConfigEntry extends Index {
  collectionGroup: string;
}

interface Index {
  name?: string;             // server-assigned on reads
  queryScope: QueryScope;    // 'COLLECTION' | 'COLLECTION_GROUP'
  fields: IndexField[];
  state?: IndexState;
  apiScope?: ApiScope;
  density?: Density;
  multikey?: boolean;
  unique?: boolean;
}

interface IndexField {
  fieldPath: string;
  order?: IndexFieldOrder;   // 'ASCENDING' | 'DESCENDING'
  arrayConfig?: ArrayConfig; // 'CONTAINS'
  vectorConfig?: VectorConfig;
}

interface VectorConfig {
  dimension: number;
  flat?: Record<string, never>;
}
```
Each `IndexField` must specify exactly one of `order`, `arrayConfig`, or `vectorConfig`. `deployAll` validates this before issuing any HTTP calls and returns `invalid-config` on violations.
