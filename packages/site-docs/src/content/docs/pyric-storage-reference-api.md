---
title: "Public API"
group: "pyric / storage"
section: "Reference"
order: 152
---
# Public API

Every symbol exported from `pyric/storage`.

## Entry points

### `getStorageSandbox(target, options?): FirebaseStorage`

Build a Storage handle backed by IndexedDB.

`target` is either a `Sandbox` (anonymous identity wired internally) or a `SandboxContext`. The handle is idempotent — calling `getStorageSandbox` twice with the same context returns the same wrapper.

### `getStorageProd(app, options?): FirebaseStorage`

Build a Storage handle backed by the real Firebase Storage. Dispatches to `firebase/storage`.

### `const TARGET_SYMBOL: unique symbol`

The discriminator that lets downstream functions tell the two backends apart. Consumers don't import this — pass the handle to free functions.

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
`data` is `Blob | Uint8Array | ArrayBuffer`. Returns `{ ref, metadata: FullMetadata }`.

### `uploadString(ref, value, format?, metadata?): Promise<UploadResult>`

`format` is `'raw' | 'base64' | 'data_url'` (default `'raw'`).

## Download

### `getBytes(ref, maxDownloadSizeBytes?): Promise<ArrayBuffer>`
### `getBlob(ref, maxDownloadSizeBytes?): Promise<Blob>`

Throws `storage/object-not-found` on missing path. Throws `storage/quota-exceeded` when the object exceeds `maxDownloadSizeBytes`.

### `deleteObject(ref): Promise<void>`

Atomically removes both the blob and its metadata. No-op on missing paths.

## Metadata

### `getMetadata(ref): Promise<FullMetadata>`

Read every metadata field — both client-settable and server-set.

### `updateMetadata(ref, patch): Promise<FullMetadata>`

Replace the client-settable fields. Bumps `metageneration` and refreshes `updated`. Server-set fields (`generation`, `timeCreated`, `bucket`, `size`, `md5Hash`) stay pinned. Blob content untouched.

### `SettableMetadata`
```ts
interface SettableMetadata {
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  contentType?: string;
  customMetadata?: Record<string, string>;
}
```
### `FullMetadata`

Settable fields plus server-set ones (`bucket`, `fullPath`, `generation`, `metageneration`, `md5Hash`, `name`, `size`, `timeCreated`, `updated`).

### `UploadResult`
```ts
interface UploadResult {
  ref: StorageReference;
  metadata: FullMetadata;
}
```
## Listing

### `listAll(ref): Promise<ListResult>`

Returns `{ items, prefixes, nextPageToken: undefined }`. Items are direct children; sub-folders surface in `prefixes` (deduplicated). `listAll(ref(storage))` scans the entire bucket.

### `ListResult`
```ts
interface ListResult {
  items: StorageReference[];
  prefixes: StorageReference[];
  nextPageToken: undefined;
}
```
Paginated `list(ref, { maxResults, pageToken })` is deferred — `listAll` covers every v1 scope scenario.

## Rules

### `parseStorageRules(source): ParsedRules`

Parse a Storage rules source. Surfaces parse errors with line/column info. Useful for testing rule expressions independently of a Storage handle.

### `evaluateStorageRules(rules, input): Decision`

Evaluate parsed rules against a synthetic request shape. Returns `{ allowed: true } | { allowed: false; reason }`.

Typically you don't call these directly — pass the source to `getStorageSandbox(target, { rules })` and operations enforce it automatically.

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

### `ProdStorageOptions`

The options accepted by `getStorageProd`. Subset of `StorageOptions` — no `dbName` (there's no IndexedDB on the prod backend), no `rules` (rules are deployed via `firebase deploy --only storage:rules`).

### `Target`, `SandboxTarget`, `ProdTarget`

Discriminated union for routing. Exported for callers writing instrumentation that wants to narrow on backend. Application code doesn't touch them.
