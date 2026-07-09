---
title: "Error codes by operation"
group: "pyric-tools / deploy"
section: "Reference"
order: 30
---
# Error codes by operation

Every operation in `pyric-tools/deploy` surfaces failures one of three ways:

1. **Primitives** throw `AdminApiError`. Branch on `error.status` (HTTP status from upstream).
2. **Orchestrators** return `{ ok: false, code, message }`. Codes are typed per operation.
3. **Tool handlers** return `{ ok: false, summary }`. Stringifies the underlying failure.

This page lists every coded error value an orchestrator can return.

## Universal codes

These two appear in every `Outcome` union:

- **`'permission-denied'`** — upstream returned 401 or 403, *or* the token resolver itself failed with an `AdminApiError` of that status.
- **`'unknown'`** — anything else. Network failures, DNS errors, unexpected non-2xx, exceptions from non-fetch code paths.

## Hosting

### `DeployHostingError.code`
```
INVALID_INPUT             — caller passed an invalid `options`
PERMISSION_DENIED         — 401 / 403 from any of the 5 REST steps
SITE_NOT_FOUND            — the named site doesn't exist
CREATE_VERSION_FAILED     — POST .../versions returned non-2xx
POPULATE_FAILED           — .files:populate manifest call failed
UPLOAD_FAILED             — at least one file failed to upload to GCS
FINALIZE_FAILED           — versions.patch state=FINALIZED failed
RELEASE_FAILED            — releases.create failed
REWRITE_TARGET_NOT_FOUND  — finalize rejected a rewrite naming a missing function
CHANNEL_FAILED            — preview-channel ensure failed (invalid id / non-2xx)
NETWORK_ERROR             — transport-level fetch failure
```
`REWRITE_TARGET_NOT_FOUND` is distinct from `FINALIZE_FAILED` because Hosting validates rewrite targets at finalize time only. The split lets callers retry the deploy after the function lands without re-bundling the whole site.

`CHANNEL_FAILED` always fires before any version is created — a channel deploy ensures the channel first, so a bad channel id costs zero uploads. 403s and network failures during the ensure keep their generic codes (`PERMISSION_DENIED`, `NETWORK_ERROR`).

### `EnsureSiteResult` *(create vs ensure)*

`ensure` returns the same shape but with an `'already-exists'` success branch in addition to `'created'`.

## Cloud Functions

### `DeployFunctionsError.code`
```
INVALID_INPUT          — empty localDir, empty functions array, missing entryPoint
PERMISSION_DENIED      — 401 / 403 from any deploy step
SOURCE_BUNDLE_FAILED   — local source couldn't be zipped (Node bundler error)
UPLOAD_URL_FAILED      — generateUploadUrl returned non-2xx
UPLOAD_FAILED          — PUT to the signed URL failed
CREATE_FAILED          — functions.create returned non-2xx
UPDATE_FAILED          — functions.patch (re-deploy) returned non-2xx
OPERATION_TIMED_OUT    — long-running operation didn't complete inside the timeout
OPERATION_FAILED       — operation completed with `error` set
IAM_GRANT_FAILED       — invoker: 'public' but grantPublicInvoker failed
NETWORK_ERROR          — transport-level fetch failure
```
`functionIndex` is set when a specific function in a multi-function deploy failed. Earlier functions in the array may already be live.

## Firestore rules

### `EnsureRuleOutcome.code`
```
permission-denied  — fetch or deploy failed with 401 / 403
merge-failed       — inject() couldn't locate the documents-match block
unknown            — anything else
```
`'merge-failed'` is a specific signal: the rules source doesn't match the expected shape, so the caller can fall back to "paste this snippet manually" rather than guessing where to put it.

## Firestore indexes

### `DeployIndexesOutcome.code`
```
permission-denied  — 403 from any create call
invalid-config     — pre-flight validation failed (bad shape, missing fields)
create-failed      — one or more indexes returned non-2xx (non-403, non-409)
unknown            — anything else
```
On `ok: false`, `partial` carries the operations that did succeed before the failure. Callers can either retry just the failed entries or surface the partial success to the user.

### `GetIndexStatusOutcome.code`
```
permission-denied  — operation.get returned 403
build-failed       — operation completed with `error` set
unknown            — anything else
```
## Firestore databases

### `ProvisionDatabaseOutcome.code`
```
permission-denied  — get-or-create returned 401 / 403
unknown            — anything else
```
The orchestrator probes for an existing database first, so `'already-exists'` is a success state — not an error.

## Tool handlers

Tool factories return `ToolHandler[]` that adapt these outcomes to the `@inbrowser/agent` `ToolResult` shape:
```ts
type ToolResult = { ok: boolean; summary: string; data?: unknown };
```
The handler's `data` field carries the underlying `Outcome` so consumers can re-narrow when they need the structured code. See [Tool factories](../pyric-tools-deploy-reference-tool-factories/) for the `DeployToolData` map.
