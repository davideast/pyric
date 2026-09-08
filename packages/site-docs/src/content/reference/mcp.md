---
title: "MCP tools & resources reference"
navLabel: "MCP tools & resources"
group: "API reference"
section: "@pyric/cli"
order: 100010
description: "Complete specification for Pyric's 12 verb-first MCP tools and 7 pyric:// MCP resource URI templates."
---

# MCP tools & resources reference

Pyric's Model Context Protocol (MCP) surface exposes the local sandbox through **12 verb-first action tools** (for mutations, identity switching, branching experiments, and AST rule diagnosis) and **7 `pyric://` resource URI templates** (for read-only state inspection).

Every tool parameter schema enforces a maximum nesting depth of 2 levels (`assertFlatSchema`), ensuring reliable serialization across all MCP clients.

---

## MCP Resource URI Templates (`resources/read`)

Read-only inspection of sandbox state is exposed through `resources/read` using `pyric://` URI templates.

| URI Template | Description | Returned Payload Shape |
|---|---|---|
| `pyric://sandbox/status` | Snapshot of sandbox health, active auth identity lens, mock clock offset, network state, and service document/user counts. | `{ status: 'ok', clockIso: string, network: 'online' \| 'offline', activeIdentity: AuthLens, services: { firestore, database, auth, storage } }` |
| `pyric://sandbox/events` | Chronological history of operations evaluated by the sandbox, including security rules verdicts. | `{ totalCount: number, events: SandboxEvent[] }` |
| `pyric://firestore/docs/{path}` | Reads a single Firestore document (even segment count, e.g., `users/alice`) or lists a collection (odd segment count, e.g., `users`). | Document: `{ kind: 'document', path, exists: boolean, data }` <br/> Collection: `{ kind: 'collection', path, documents: Array<{ path, data }> }` |
| `pyric://database/tree/{path}` | Reads a JSON subtree from the Realtime Database at `{path}` (use `root` for the entire tree). | `{ path: string, exists: boolean, value: unknown, childKeys: string[] }` |
| `pyric://auth/users` | Lists all registered sandbox Auth users and their custom claims. | `{ count: number, users: Array<{ uid, email, displayName, customClaims, tenantId }> }` |
| `pyric://storage/objects/{bucket}` | Lists stored objects in the specified Cloud Storage bucket. | `{ bucket: string, count: number, objects: Array<{ name, bucket, fullPath }> }` |
| `pyric://stdlib/rules/{module}` | Returns documentation and source signatures for a `2+modules` standard library module (e.g., `auth`, `math`, `list`, or `index`). | `{ module: string, available: boolean, documentation?: string, availableModules?: string[] }` |

---

## Identity & Authentication Tools

### `switch_auth_identity`

Sets or resets the active ambient identity lens for subsequent sandbox tool calls.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mode` | `'admin' \| 'uid' \| 'anonymous'` | Yes | Identity mode. `'admin'` bypasses security rules; `'anonymous'` acts signed out; `'uid'` impersonates a specific user. |
| `uid` | `string` | When `mode === 'uid'` | User ID to impersonate. |
| `tenant` | `string` | No | Identity Platform tenant ID. Automatically projected into `request.auth.token.firebase.tenant`. |
| `claimsJson` | `string` | No | JSON-encoded object of custom claims exposed on `request.auth.token.<claim>`. |

#### Example

```json
{
  "name": "switch_auth_identity",
  "arguments": {
    "mode": "uid",
    "uid": "alice",
    "tenant": "acme-corp",
    "claimsJson": "{\"role\":\"editor\"}"
  }
}
```

---

### `manage_auth_users`

Creates, updates, deletes, lists, sets claims on, or mints custom tokens for sandbox Authentication users.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | `'create' \| 'get' \| 'list' \| 'update' \| 'delete' \| 'set_claims' \| 'mint_token'` | Yes | Auth management action to perform. |
| `uid` | `string` | For single-user actions | Target user ID. |
| `email` | `string` | No | User email address. |
| `displayName` | `string` | No | User display name. |
| `tenant` | `string` | No | Tenant ID associated with the user account. |
| `claimsJson` | `string` | No | JSON-encoded custom claims object. |

#### Example

```json
{
  "name": "manage_auth_users",
  "arguments": {
    "action": "create",
    "uid": "user_bob",
    "email": "bob@example.com",
    "tenant": "acme-corp",
    "claimsJson": "{\"tier\":\"pro\"}"
  }
}
```

---

### `inspect_auth_flow`

Retrieves outbox verification/reset emails (`take_mail`) or inspects active session state (`get_session`).

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | `'take_mail' \| 'get_session'` | Yes | `'take_mail'` drains captured outbox messages (password reset, email verification links); `'get_session'` returns the active session lens. |
| `email` | `string` | No | Filter outbox messages by recipient email address. |

---

## Data & Storage Tools

### `mutate_sandbox_data`

Executes atomic writes (`set`, `add`, `update`, `delete`, `batch`, `transaction`) against Firestore or Realtime Database. Respects the active identity lens unless an inline `auth` override is supplied.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `service` | `'firestore' \| 'database'` | Yes | Target database service. |
| `action` | `'set' \| 'add' \| 'update' \| 'delete' \| 'batch' \| 'transaction'` | Yes | Mutation type. |
| `path` | `string` | For single-path actions | Document path (e.g., `projects/p1`) or RTDB node path. |
| `dataJson` | `string` | For write actions | JSON-encoded document or node payload. |
| `batchOps` | `Array<{ op: 'set' \| 'update' \| 'delete', path: string, dataJson?: string }>` | When `action === 'batch'` | Atomic batch write operations (maximum depth 2). |
| `auth` | `{ mode: 'admin' \| 'uid' \| 'anonymous', uid?: string, tenant?: string, claimsJson?: string }` | No | Inline identity override for this single operation. |

#### Example

```json
{
  "name": "mutate_sandbox_data",
  "arguments": {
    "service": "firestore",
    "action": "set",
    "path": "projects/p1",
    "dataJson": "{\"name\":\"Apollo\",\"ownerId\":\"alice\"}"
  }
}
```

---

### `query_sandbox_data`

Runs structured filtered, ordered, and bounded queries against Firestore collections or Realtime Database paths.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `service` | `'firestore' \| 'database'` | Yes | Target database service. |
| `path` | `string` | Yes | Collection path or RTDB node path to query. |
| `filters` | `Array<{ field: string, op: WhereFilterOp, valueJson: string }>` | No | Query predicates (e.g., `op: "=="`, `valueJson: "\"published\""`). |
| `orderByField` | `string` | No | Field name to sort results by. |
| `orderDirection` | `'asc' \| 'desc'` | No | Sort order direction. |
| `limit` | `number` | No | Maximum number of results to return. |
| `auth` | `{ mode: 'admin' \| 'uid' \| 'anonymous', uid?: string, tenant?: string, claimsJson?: string }` | No | Inline identity override. |

---

### `manage_storage_files`

Uploads (base64), downloads (`data:` URI), lists, or deletes objects in Cloud Storage.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | `'upload' \| 'download' \| 'delete' \| 'list'` | Yes | Cloud Storage operation. |
| `path` | `string` | Yes | Object storage path (e.g., `avatars/alice.png`). |
| `bucket` | `string` | No | Target bucket name (defaults to default sandbox bucket). |
| `contentBase64` | `string` | When `action === 'upload'` | Base64-encoded file payload. |
| `contentType` | `string` | No | MIME content type (defaults to `application/octet-stream`). |

---

## Rules Verification & Diagnostics Tools

### `diagnose_rule_denial`

Evaluates a hypothetical request against Firestore or Realtime Database security rules and returns a step-by-step AST expression trace (`ExprTraceEntry[]`) pinpointing why an operation was allowed or denied.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `service` | `'firestore' \| 'database'` | Yes | Target service ruleset. |
| `operation` | `'get' \| 'list' \| 'create' \| 'update' \| 'delete' \| 'read' \| 'write'` | Yes | Operation to evaluate. |
| `path` | `string` | Yes | Target document or database path. |
| `resourceDataJson` | `string` | No | JSON-encoded incoming request payload (`request.resource.data` / `newData`). |
| `rulesSource` | `string` | No | Optional candidate rules source string. If omitted, evaluates the active sandbox rules. |
| `auth` | `{ uid?: string, tenant?: string, claimsJson?: string }` | No | Identity context for the simulated request. |

---

### `verify_security_rules`

Lints rules source, resolves `2+modules` imports, checks feature conformance, or runs a declarative suite of security rules test cases.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `service` | `'firestore' \| 'database' \| 'storage'` | Yes | Target service. |
| `action` | `'lint' \| 'resolve_modules' \| 'simulate_suite' \| 'check_conformance'` | Yes | Verification mode. |
| `source` | `string` | No | Rules source code to verify (defaults to currently loaded rules). |
| `testCases` | `Array<{ expectation: 'ALLOW' \| 'DENY', operation: string, path: string, uid?: string, tenant?: string, claimsJson?: string, resourceDataJson?: string }>` | When `action === 'simulate_suite'` | Suite of test cases evaluated against the ruleset. |

---

### `dry_run_experiment`

Forks an isolated copy-on-write sandbox branch, applies candidate rules or mutations, replays recorded sandbox traffic to detect permission regressions (`ALLOW` -> `DENY`), and promotes or discards the branch.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | `'fork' \| 'apply' \| 'diff' \| 'promote' \| 'discard'` | Yes | Branch lifecycle action. |
| `branchId` | `string` | No | Branch identifier (defaults to `'default'`). |
| `candidateRules` | `string` | No | Candidate Firestore rules source to evaluate against recorded sandbox traffic. |
| `mutationsJson` | `string` | No | JSON-encoded array of sandbox events to apply on the branch. |
| `force` | `boolean` | No | Promote the branch even if rule regressions were detected. |

---

## Environment, Cloud Functions & AI Tools

### `control_sandbox_environment`

Resets sandbox state across all services, advances the deterministic mock clock, or toggles simulated network connectivity.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | `'reset_all' \| 'advance_clock' \| 'set_network'` | Yes | Environment control action. |
| `advanceMs` | `number` | When `action === 'advance_clock'` | Milliseconds to advance the sandbox clock forward. |
| `isoTimestamp` | `string` | No | ISO-8601 timestamp to pin the sandbox clock to. |
| `networkState` | `'online' \| 'offline'` | When `action === 'set_network'` | Simulated client network mode. |

---

### `invoke_cloud_function`

Invokes a callable Cloud Function or simulates a background event trigger in the sandbox.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Registered function name. |
| `type` | `'callable' \| 'event'` | Yes | Trigger invocation mode. |
| `dataJson` | `string` | No | JSON-encoded request data or event payload. |
| `auth` | `{ uid?: string, tenant?: string, claimsJson?: string }` | No | Caller authentication context. |

---

### `configure_ai_mock`

Configures deterministic scripted responses or simulated HTTP errors for Vertex AI / Gemini calls in the sandbox.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | `'set_script' \| 'clear_scripts'` | Yes | Scripting queue action. |
| `promptContains` | `string` | No | Substring match trigger on incoming prompt text. |
| `responseText` | `string` | No | Deterministic text completion returned when matched. |
| `errorCode` | `number` | No | Simulated HTTP error status code (e.g., `429`). |
