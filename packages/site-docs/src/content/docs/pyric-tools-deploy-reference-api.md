---
title: "Public API"
group: "pyric-tools / deploy"
section: "Reference"
order: 10014
---
# Public API

This page describes every symbol re-exported from `pyric-tools/deploy`. Symbols are grouped by submodule and listed in the order they appear in `index.ts`.

## Foundation

### `interface ProjectScope`

Project-level credentials threaded through every control-plane call.
```ts
interface ProjectScope {
  readonly projectId: string;
  resolveToken(): Promise<string>;
}
```
See [`ProjectScope`, `Outcome`, `AdminApiError`](../pyric-tools-deploy-reference-scope-and-outcome/).

### `type Outcome<TData, TErrCode>`

Result shape used by orchestrators:
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
### `class AdminApiError extends Error`

Thrown by primitives on non-2xx responses.
```ts
class AdminApiError extends Error {
  readonly status: number;   // HTTP status from upstream
  readonly body: string;     // capped at 8 KiB
}
```
### `fromServiceAccount(saJsonOrPath: string): Promise<ProjectScope>`

Build a `ProjectScope` from a service-account JSON. Accepts:

- An absolute or relative filesystem path (Node).
- A literal JSON string starting with `{`.
- A base64-encoded JSON string prefixed with `base64:`.

The returned scope's `resolveToken` is memoised internally. Callers don't need their own caching layer.

### `memoizeTtl(resolver, opts?): () => Promise<string>`

TTL memoiser for resolver functions. Two overloads:

- **Plain string resolver**: `() => Promise<string>` plus `opts.ttlMs` (required).
- **Structured token resolver**: `() => Promise<{ token, expiresIn? }>`. Parses `expiresIn` (seconds) and refreshes at 90% of TTL by default.

See [Token caching and `memoizeTtl`](../pyric-tools-deploy-explanation-token-caching/).

### `MemoizeTtlOptions`
```ts
interface MemoizeTtlOptions {
  ttlMs?: number;
  refreshAtFraction?: number;  // default 0.9
  resolverTimeoutMs?: number;  // default 30_000
}
```
### `withResolvedScope(scope, fn): Promise<Outcome<TData, 'not-found'>>`

Standard wrapper for the resolver + try/catch shape primitives use. Buckets `AdminApiError` by HTTP status:

- `401` / `403` → `'permission-denied'`
- `404` → `'not-found'`
- Other non-2xx → `'unknown'`

Other thrown errors (network, DNS) bucket as `'unknown'`, not `'permission-denied'`, to avoid mis-labelling transport failures as IAM issues.

## Namespaces

### `const hosting`

Hosting deploy primitives. See [`hosting` namespace](../pyric-tools-deploy-reference-hosting-namespace/):

- `hosting.deployFiles(scope, options)`
- `hosting.sites.create(scope, input)`
- `hosting.sites.ensure(scope, input)`

### `const functions`

Cloud Functions Gen 2 deploy primitives. See [`functions` namespace](../pyric-tools-deploy-reference-functions-namespace/):

- `functions.deployLocal(scope, options)`
- `functions.deploy(scope, input)`
- `functions.bundle(localDir)`
- `functions.pollOperation(scope, operationName, opts?)`
- `functions.grantPublicInvoker(scope, input)`

### `const firestore`

Firestore rules, indexes, and database primitives. See [`firestore` namespace](../pyric-tools-deploy-reference-firestore-namespace/):

- `firestore.rules.{ fetch, deploy, inject, check, ensure }`
- `firestore.indexes.{ create, deployAll, getStatus }`
- `firestore.databases.{ provision }`

### `const rtdb`

Realtime Database rules primitives. See [`rtdb` namespace](../pyric-tools-deploy-reference-rtdb-namespace/):

- `rtdb.rules.{ fetch, deploy, discoverDefaultDatabaseUrl, resolveDatabaseUrl }`

### `const recipes`

Paste-in templates for `firestore.rules.ensure`:

- `recipes.pyricSessions`: multi-tenant playground session-archive recipe.

## Tool factories

### `createFirestoreDeployTools(deps): ToolHandler[]`

Returns seven handlers:

- `firestore_get_rules`
- `firestore_deploy_rules`
- `firestore_ensure_rules`
- `firestore_provision_database`
- `firestore_deploy_indexes`
- `firestore_create_index`
- `firestore_get_index_status`

### `createHostingDeployTools(deps): ToolHandler[]`

Returns two handlers:

- `hosting_deploy`
- `hosting_ensure_site`

### `createRtdbDeployTools(deps): ToolHandler[]`

Returns two handlers:

- `rtdb_get_rules`
- `rtdb_deploy_rules`

### `createFunctionsDeployTools(deps): ToolHandler[]`

Returns one handler:

- `functions_deploy`

### Types

- `ProjectScopedDeps`: `{ scope: ProjectScope }`.
- `DeployToolData`: keyed map from tool name to the concrete `data` shape its `execute` returns.

See [Tool factories](../pyric-tools-deploy-reference-tool-factories/).

## Wire-shape types

Re-exported from the relevant submodule:

### Hosting

- `DeployHostingResult`, `DeployHostingSuccess`, `DeployHostingError`, `HostingErrorCode`.
- `DeployHostingFilesInput`.
- `CreateSiteResult`, `EnsureSiteResult`, `HostingSiteResource`, `CreateHostingSiteInput`.
- `HostingJsonConfig`, `HostingRewriteJson`, `HostingRedirectJson`, `HostingHeaderJson`, `HostingSource`.
- `WalkedFile`.

### Functions

- `DeployFunctionsResult`, `DeployFunctionsSuccess`, `DeployFunctionsError`, `FunctionsErrorCode`.
- `DeployedFunction`, `FunctionDeployConfig`.
- `DeployFunctionsCoreInput`.
- `BundleResult`, `BundleOptions`.
- `PollResult`, `PollOptions`.

### Firestore

- `RuleCheckResult`, `EnsureRuleOutcome`.
- `ProvisionDatabaseOptions`, `ProvisionDatabaseOutcome`.
- `QueryScope`, `IndexFieldOrder`, `ArrayConfig`, `IndexState`, `ApiScope`, `Density`, `VectorConfig`, `IndexField`, `Index`, `IndexesConfigEntry`, `IndexesConfig`, `IndexOperation`.
- `DeployIndexesOptions`, `PerIndexOutcome`, `DeployIndexesOutcome`.
- `GetIndexStatusOutcome`.

### Realtime Database

- `RtdbDeployRulesInput`, `RtdbFetchRulesInput`, `RtdbRulesDiscoveryResult`.

See [Error codes by operation](../pyric-tools-deploy-reference-error-codes/) for the values each error union can take.
