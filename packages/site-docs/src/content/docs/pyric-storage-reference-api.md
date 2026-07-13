---
title: "Public API"
group: "pyric / storage"
section: "Reference"
order: 15006
---
# Public API

Every symbol exported from `pyric/storage`.

> **Experimental.** Storage is built, documented, and usable, but most of its behavior is not yet pinned to a recorded production observation the way Auth and Firestore are. See [`COMPAT.md`](../pyric-storage-compat/) for the row-by-row conformance state.

## Entry points

### `getStorage(app, bucketUrl?): FirebaseStorage`
```ts
function getStorage(app: PyricApp, bucketUrl?: string): FirebaseStorage
```
Firebase-shaped sandbox entry point. Package resolution selects this mirror before it loads, so it accepts only a sandbox-backed `PyricApp`. `bucketUrl` is accepted for call-site compatibility but ignored by the single-bucket sandbox. Direct tests that need `bucket`, `dbName`, or `rules` use `getStorageSandbox`.

### `getStorageSandbox(target, options?): FirebaseStorage`

Build a Storage handle backed by IndexedDB.

`target` is either a `Sandbox` (anonymous identity wired internally) or a `SandboxContext`. The handle is idempotent: calling `getStorageSandbox` twice with the same context returns the same wrapper.

### `const TARGET_SYMBOL: unique symbol`

The private brand carrying the handle's sandbox service, identity, bucket, and admin-lens state. Consumers don't import this. Pass the handle to free functions.

## Errors

### `class StorageError extends Error`
```ts
class StorageError extends Error {
  readonly code: `storage/${StorageErrorCode}`;
}
```
Every sandbox operation that fails throws one of these, so consumer code can branch on `err.code === 'storage/...'`. Production code receives Firebase's own errors because it imports `firebase/storage` directly. See [Error codes](../pyric-storage-reference-error-codes/).

### `StorageErrorCode`
```ts
type StorageErrorCode =
  | 'unknown'
  | 'object-not-found'
  | 'quota-exceeded'
  | 'unauthenticated'
  | 'unauthorized'
  | 'invalid-root-operation'
  | 'invalid-format'
  | 'invalid-argument';
```
## Reference construction

### `ref(storage)` / `ref(storage, path)` / `ref(parent, path)`

Build a `StorageReference`. Two overloads matching `firebase/storage`.

Path normalisation: leading/trailing slashes stripped, repeated internal slashes collapsed. Empty path = root reference (no parent).
```ts
const root = ref(storage);                           // root
const sessions = ref(storage, 'sessions');           // 'sessions/'
const one = ref(sessions, 'gen-123');                // 'sessions/gen-123'
```
### `StorageReference`
```ts
interface StorageReference {
  readonly name: string;
  readonly bucket: string;
  readonly fullPath: string;
  readonly parent: StorageReference | null;
  readonly root: StorageReference;
  readonly storage: FirebaseStorage;
}
```
## Upload

### `uploadBytes(ref, data, metadata?): Promise<UploadResult>`
```ts
await uploadBytes(ref(storage, 'sessions/n1'), bytes, {
  contentType: 'application/json',
  customMetadata: { sessionId: 'n1' },
});
```
`data` is `Blob | Uint8Array | ArrayBuffer`. Returns `{ ref, metadata: FullMetadata }`. Throws `storage/invalid-root-operation` when `ref` targets the root.

### `uploadString(ref, value, format?, metadata?): Promise<UploadResult>`

`format` is a `StringFormat` (default `'raw'`). Delegates to `uploadBytes` after decoding.

### `StringFormat`
```ts
type StringFormat = 'raw' | 'base64' | 'data_url';
```
`raw` defaults `contentType` to `text/plain;charset=utf-8` when nothing else supplies one. `data_url` reads the MIME prefix before the comma unless the caller's metadata overrides `contentType`. `base64` is standard base64.

## Download

### `getBytes(ref, maxDownloadSizeBytes?): Promise<ArrayBuffer>`
### `getBlob(ref, maxDownloadSizeBytes?): Promise<Blob>`

Throws `storage/object-not-found` on missing path. Throws `storage/quota-exceeded` when the object exceeds `maxDownloadSizeBytes`. Throws `storage/invalid-root-operation` on the root reference. The rule check runs before the not-found check, so a denied read of a missing path reports `storage/unauthorized`, matching prod's refusal to disclose object existence to a caller without read permission.

### `getDownloadURL(ref): Promise<string>`

Returns a page-owned `blob:` URL that fetches the stored sandbox object:
```ts
const url = await getDownloadURL(ref(storage, 'avatars/ada.png'));
image.src = url;
```
The sandbox URL is a snapshot of the bytes at call time. It cannot be shared outside the page and remains alive until `URL.revokeObjectURL(url)` or page unload. Missing objects and rules denials use the same `storage/object-not-found` and `storage/unauthorized` errors as `getBlob`.

### `deleteObject(ref): Promise<void>`

Atomically removes both the blob and its metadata. No-op on missing paths in the sandbox (upstream Firebase throws `storage/object-not-found` here; the sandbox's persistence layer is no-op-on-missing instead, a known divergence, see [Error codes](../pyric-storage-reference-error-codes/)).

## Metadata

### `getMetadata(ref): Promise<FullMetadata>`

Read every metadata field, both client-settable and server-set.

### `updateMetadata(ref, patch): Promise<FullMetadata>`

Replace the client-settable fields. Bumps `metageneration` and refreshes `updated`. Server-set fields (`generation`, `timeCreated`, `bucket`, `size`, `md5Hash`) stay pinned. Blob content untouched. Passing `undefined` for a field leaves the previous value; there's no `null`-to-clear support in the v1 scope.

### `SettableMetadata`
```ts
interface SettableMetadata {
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  customMetadata?: { [key: string]: string };
}
```
### `FullMetadata`
```ts
interface FullMetadata extends SettableMetadata {
  bucket: string;
  fullPath: string;
  name: string;
  generation: string;
  metageneration: string;
  timeCreated: string;
  updated: string;
  size: number;
  md5Hash?: string;
}
```
### `UploadResult`
```ts
interface UploadResult {
  metadata: FullMetadata;
  ref: StorageReference;
}
```
## Listing

### `listAll(ref): Promise<ListResult>`

Returns `{ items, prefixes }`. Items are direct children; sub-folders surface in `prefixes` (deduplicated). `listAll(ref(storage))` scans the entire bucket. Enforces `read` on the scanned path: Storage's `read` permission governs both download and list, so `listAll` on an unauthorized tree throws `storage/unauthorized`.

### `ListResult`
```ts
interface ListResult {
  items: StorageReference[];
  prefixes: StorageReference[];
  nextPageToken?: string;
}
```
`nextPageToken` is always absent (`undefined`) from `listAll`; the field exists for forward compatibility with paginated `list`, which is deferred. See [Boundaries](#boundaries).

Paginated `list(ref, { maxResults, pageToken })` is deferred. `listAll` covers every v1 scope scenario.

## Rules

### `parseStorageRules(source): StorageRules`

Parse a Storage rules source. Throws on malformed input. Useful for testing rule expressions independently of a Storage handle.

### `evaluateStorageRules(rules, input): EvaluationResult`

Evaluate parsed rules against a synthetic request shape. Returns `{ allowed: boolean; reasons: string[] }`. `reasons` explains a denial (or a grant) in plain text; the sandbox's `storage/unauthorized` error messages are built from it.

Typically you don't call these directly. Pass the source to `getStorageSandbox(target, { rules })` and operations enforce it automatically.

See [Storage rules subset](../pyric-storage-reference-rules-subset/) for the grammar these functions accept.

### Rules types
```ts
type StorageMethod = 'read' | 'write';

interface StorageAuth {
  uid: string;
  token?: Record<string, unknown>;
}

interface StorageRequest {
  auth: StorageAuth | null;
  method: StorageMethod;
  path: string;
  resource?: { size: number; contentType?: string; metadata?: Record<string, string> };
}

interface StorageResource {
  size: number;
  contentType?: string;
  metadata?: Record<string, string>;
}

interface EvaluationInput {
  request: StorageRequest;
  resource: StorageResource | null;
}

interface EvaluationResult {
  allowed: boolean;
  reasons: string[];
}

interface StorageRules {
  readonly _root: unknown; // opaque
}
```
`StorageRules` is opaque outside the package; only `parseStorageRules` produces one and only `evaluateStorageRules` (or `getStorageSandbox(target, { rules })` internally) consumes one.

## Service types

### `FirebaseStorage`

The opaque handle. Carries the target via `TARGET_SYMBOL`; consumed by free functions only.

### `StorageOptions`
```ts
interface StorageOptions {
  bucket?: string;
  dbName?: string;
  rules?: string;
}
```
See [`StorageOptions`](../pyric-storage-reference-storage-options/).

### `Target`, `SandboxTarget`

Sandbox handle state. Exported for instrumentation; application code does not touch it.

## Admin / control plane

Beyond the data-plane adapter above, `pyric/storage` exports a control plane for provisioning and managing real Cloud Storage buckets. These functions take an OAuth access token directly (not a `FirebaseStorage` handle) and call the Firebase and Google Cloud management APIs over `fetch`, so they run equally from a Node agent runtime or a browser. Each function's docstring in `admin/api.ts` names the exact OAuth scope or IAM role it needs; the summaries below carry the load-bearing ones.

### `getStorageServiceState(accessToken, projectId): Promise<ServiceEnableState>`

Probe whether the `firebasestorage.googleapis.com` service is enabled on the project. Cheap read; requires `serviceusage.services.get`. Returns `'unknown'` on permission failure rather than throwing, so callers can downgrade to "try the operation, observe `SERVICE_DISABLED`" instead of blocking.
```ts
type ServiceEnableState = 'enabled' | 'disabled' | 'unknown';
```
### `enableStorageService(accessToken, projectId): Promise<void>`

Enable `firebasestorage.googleapis.com` on the project. Requires `serviceusage.services.enable`, part of `roles/owner` or `roles/serviceusage.serviceUsageAdmin`. The default Firebase Admin SDK service account does not have this. Throws `StorageProvisioningError` on failure.

### `getDefaultLocation(accessToken, projectId): Promise<string | null>`

Read the project's current default GCP resources location. Returns `null` when the project hasn't been finalized yet (brand-new Firebase projects with no resources). `firebase` OAuth scope is sufficient.

### `finalizeDefaultLocation(accessToken, projectId, locationId): Promise<void>`

Set the project's default GCP resources location. **Irreversible**: once set, the location cannot be changed. This function unconditionally calls `:finalize`; checking whether a location is already set is the caller's job (see `getDefaultLocation`). Also 404s on projects that already have other resources (RTDB, Hosting) provisioned without a default location; the error surfaces to the caller as-is.

### `listFirebaseBuckets(accessToken, projectId): Promise<FirebaseStorageBucket[]>`

List Firebase-linked Storage buckets on the project. Returns an empty list when none exist yet. Throws when the underlying service is disabled; call `getStorageServiceState` first to distinguish that case.
```ts
interface FirebaseStorageBucket {
  name: string;       // projects/{p}/buckets/{bucketId}
  bucketId: string;   // {bucketId} only
  reconciling?: boolean;
}
```
### `addFirebaseToBucket(accessToken, projectId, bucketId): Promise<FirebaseStorageBucket>`

Link a Cloud Storage bucket to Firebase Storage. Idempotent: if the bucket is already Firebase-linked, the call returns the existing record. For the default bucket name (`{projectId}.firebasestorage.app`), Firebase auto-creates the underlying GCS bucket on first call.

### `deployStorageRules(accessToken, projectId, source, bucketId?): Promise<{ rulesetName: string }>`

Deploy a Storage rules source. `bucketId` defaults to `{projectId}.firebasestorage.app`. Firebase Storage uses **per-bucket** release names (`projects/{p}/releases/firebase.storage/{bucketId}`) for actual rule application; the project-wide `firebase.storage` release is a legacy alias not bound to any bucket in modern projects, so deploying to it leaves the bucket's rules unchanged. Creates a ruleset, then patches the bucket's release (falling back to creating the release the first time one doesn't exist).

### `getBucketCors(accessToken, bucketId): Promise<CorsRule[]>`

Read the current CORS configuration for a bucket. Requires `storage.buckets.get` or equivalent.

### `setBucketCors(accessToken, bucketId, cors): Promise<void>`

Replace the bucket's CORS configuration wholesale (the GCS API replaces, not merges, the `cors` field on `PATCH`). Pass an empty array to clear all rules. Requires `storage.buckets.update`, granted by `roles/storage.admin` or the default Firebase Admin SDK service-agent role bundle in modern projects.
```ts
interface CorsRule {
  origin: string[];
  method: string[];
  responseHeader?: string[];
  maxAgeSeconds?: number;
}
```
### `defaultPlaygroundCors(hostingOrigin): CorsRule[]`

A starter CORS rule for a browser playground hosted on Firebase Hosting: allows `GET/POST/PUT/DELETE/HEAD/OPTIONS` from the hosting origin plus common localhost dev ports, with the response headers the Firebase Storage Web SDK needs.

### `provisionStorage(accessToken, projectId, options?): Promise<ProvisionStorageResult>`

End-to-end Storage enablement: enable the service if needed, finalize the default location if unset, link the default bucket if not already linked, optionally deploy rules, optionally apply CORS. Each step probes state before mutating, so repeat calls are safe. Throws `StorageProvisioningError` carrying a `reason` (e.g. `AUTH_PERMISSION_DENIED`, `SERVICE_DISABLED`) the caller can route on.
```ts
interface ProvisionStorageOptions {
  locationId?: string;   // default: 'us-central'. Irreversible once set.
  bucketId?: string;     // default: '{projectId}.firebasestorage.app'
  rules?: string;        // omit to leave current rules in place
  cors?: CorsRule[];     // omit to leave current CORS in place
  onProgress?: (event: { step: string; status: 'start' | 'done' | 'skip' | 'progress'; message: string; pct?: number }) => void;
}

interface ProvisionStorageResult {
  ok: true;
  serviceEnabled: boolean;
  locationFinalized: boolean;
  locationId: string | null;
  bucketCreated: boolean;
  bucketId: string;
  rulesDeployed: boolean;
  rulesetName?: string;
  corsApplied: boolean;
}
```
The `onProgress` callback's shape (named `ProvisionProgress` internally) is not itself an exported type; annotate inline or let it infer from `ProvisionStorageOptions['onProgress']`.

### `class StorageProvisioningError extends Error`
```ts
class StorageProvisioningError extends Error {
  readonly status: number;
  readonly body: string;
  readonly reason: string | undefined;
}
```
Thrown by every admin function above on a non-2xx response. `reason` is the Google API's structured error reason when present (e.g. `SERVICE_DISABLED`, `AUTH_PERMISSION_DENIED`); `body` is the raw response text, truncated to 400 characters in the surfaced message.

## Agent tools

Wraps the admin surface above behind a `ProjectScope` (`{ projectId, resolveToken(): Promise<string> }`) contract, the same credential shape the deploy tooling's factories accept.

### `class InspectStorageHandler`
```ts
class InspectStorageHandler {
  execute(scope: ProjectScope): Promise<InspectStorageResult>;
}
```
Resolves a token from `scope`, then reads service state, default location, and (when the service is enabled) the linked bucket list, in parallel. Never throws for a normal probe: a bucket-list failure with the service otherwise enabled degrades to an empty `buckets` array rather than surfacing an error.
```ts
interface InspectStorageResult {
  serviceState: 'enabled' | 'disabled' | 'unknown';
  defaultLocation: string | null;
  buckets: Array<{ name: string; bucketId: string }>;
}
```
### `class ProvisionStorageHandler`
```ts
class ProvisionStorageHandler {
  execute(
    scope: ProjectScope,
    input: ProvisionStorageInput,
    onProgress?: ProvisionProgress,
  ): Promise<ProvisionStorageOutcome>;
}
```
Calls `provisionStorage` with a token resolved from `scope`, and maps a thrown `StorageProvisioningError` onto a typed `ProvisionStorageOutcome` failure (via its `reason` and message, pattern-matched to a `ProvisionStorageErrorCode`) instead of letting it propagate. Callers branch on `outcome.success` rather than catching.
```ts
interface ProvisionStorageInput {
  locationId?: string;
  bucketId?: string;
  rules?: string;
  cors?: Array<{ origin: string[]; method: string[]; responseHeader?: string[]; maxAgeSeconds?: number }>;
}

type ProvisionStorageErrorCode =
  | 'PERMISSION_DENIED'
  | 'SERVICE_DISABLED'
  | 'LOCATION_FINALIZE_FAILED'
  | 'BUCKET_CREATE_FAILED'
  | 'RULES_DEPLOY_FAILED'
  | 'CORS_UPDATE_FAILED'
  | 'UNKNOWN';

type ProvisionStorageOutcome =
  | {
      success: true;
      serviceEnabled: boolean;
      locationFinalized: boolean;
      locationId: string | null;
      bucketCreated: boolean;
      bucketId: string;
      rulesDeployed: boolean;
      rulesetName?: string;
      corsApplied: boolean;
    }
  | {
      success: false;
      error: {
        code: ProvisionStorageErrorCode;
        message: string;
        recoverable: boolean;
      };
    };
```
### `createStorageAdminTools(deps): ToolHandler[]`
```ts
function createStorageAdminTools(deps: StorageAdminToolDeps): ToolHandler[];

interface StorageAdminToolDeps {
  scope: ProjectScope;
}
```
Returns two `@inbrowser/agent` `ToolHandler`s built on the handlers above: `storage_get_status` (wraps `InspectStorageHandler`) and `storage_provision` (wraps `ProvisionStorageHandler`, JSON-Schema-typed against `ProvisionStorageInput`). Mirrors the shape of the Firestore rules and deploy tool factories elsewhere in Pyric, so a registry can compose them uniformly.

## Boundaries

Out of scope for v1:

- Paginated `list`. Only `listAll` ships. `ListResult.nextPageToken` stays in the shape for forward compatibility but is always `undefined`.
- `uploadBytesResumable`. No pause/resume/progress uploads; `uploadBytes` is synchronous only.
- Image transformations. Not modeled; production-only via Firebase Extensions.
- Cloud Functions Storage triggers. Not data-plane concerns; no sandbox-side event channel for them today.

See [Implementation scope and deferred features](../pyric-storage-explanation-implementation-scope/) for the full deferred list, including granular rule verbs, `request.time`, and cross-bucket isolation.
