---
title: "API reference: pyric-admin/storage"
navLabel: "API reference"
group: "pyric-admin / storage"
section: "Reference"
order: 22002
---
# API reference: `pyric-admin/storage`

Exact signatures of every public export, plus the per-arm method matrix for `Storage`, `Bucket`, and `File`. Storage support is experimental; the surfaces below are tested but mostly not yet pinned to recorded production observations.

The three arms:

- **prod**: `getStorage` delegates to `firebase-admin/storage`. The returned object is the unmodified production `Storage`; everything `@google-cloud/storage` documents applies. Nothing below constrains prod.
- **local**: an in-memory `Map<bucketName, Map<path, entry>>` per `Sandbox`. Multi-bucket isolation is real (buckets are independent maps). `sandbox.reset()` wipes the store.
- **remote**: a remote-branded sandbox relays operations over the worker channel with `actAs: { mode: 'admin' }` pinned (rules bypass) against the one object store the browser app, Studio, and agents share. Single bucket; 8 MiB per-operation byte cap.

---

## Initialization

### `getStorage(app?)`

```ts
function getStorage(app?: StorageApp): Storage;
```

Get the `Storage` service for the given app, or for the `'[DEFAULT]'` app when called with no argument (throws `app/no-app` when nothing is initialized). Dispatch reads the brand symbol: prod delegates to `firebase-admin/storage`; a remote-branded sandbox gets the relay backend; a local sandbox gets the in-memory backend. Throws `TypeError` for an unbranded value.

---

## `Storage` and `Bucket`

### `storage.bucket(name?)`

```ts
bucket(name?: string): Bucket;
```

- Local: returns a handle for `name`, creating the bucket map on first use. Omitted `name` resolves to the default bucket `'pyric-default'` (the same default `pyric/storage` uses). Buckets are genuinely isolated from each other.
- Remote: the worker's object store is single-bucket. `bucket()` and `bucket('pyric-default')` work; any other name throws immediately rather than silently merging buckets. This is the sharpest local/remote divergence, and it is loud on purpose.
- Prod: whatever `firebase-admin/storage`'s `bucket()` resolves from app config.

### `bucket.file(path)`

```ts
file(path: string): File;
```

All arms. Returns a `File` handle; the file may or may not exist.

---

## `File`: the object data plane

### `file.save(data, options?)`

```ts
save(data: Buffer | string | Uint8Array, options?: SaveOptions): Promise<void>;
```

Arms: local, remote. Persists `data` at the file's path, replacing any existing content (no append semantics). Strings are UTF-8 encoded; buffers are copied on ingest so callers can reuse their input. `options.metadata` and `options.contentType` are stored alongside the bytes and round-trip.

- `options.resumable: true` throws on both sandbox arms (resumable uploads are deferred; prod forwards it).
- Remote: relays `storage.putBytes` (base64 over the wire). Payloads over 8 MiB reject with the payload-too-large error below, before anything is sent.

### `file.download(options?)`

```ts
download(options?: DownloadOptions): Promise<[Buffer]>;
```

Arms: local, remote. Returns a `[Buffer]` tuple, mirroring `@google-cloud/storage`. A missing file throws `Error('No such object: <bucket>/<path>')` on both arms, the same message shape as production, so catch blocks that string-match keep working. `options.validation` is accepted and ignored on the sandbox arms. Remote relays `storage.getBytes`.

### `file.delete()`

```ts
delete(): Promise<void>;
```

Arms: local, remote. Idempotent: deleting a missing file is a no-op (the `ignoreNotFound: true` mode is the only one the sandbox models). Remote relays `storage.deleteObject`.

### `file.exists()`

```ts
exists(): Promise<[boolean]>;
```

Arms: local, remote. `[true]` if the file exists. Remote probes `storage.getMetadata` and maps object-not-found to `[false]`.

### `file.getSignedUrl(options)`

```ts
getSignedUrl(options: GetSignedUrlOptions): Promise<[string]>;
```

Arms: local, remote (byte-identical output; the remote arm never relays this call). Returns a deterministic stub:

```
pyric-sandbox-storage://<bucket>/<path>?expires=<ms>&action=<action>
```

The sandbox does NOT serve this URL. It is a stable placeholder so code that round-trips signed URLs through logs, fixtures, or replay sees a consistent shape. `expires` accepts ms-since-epoch, an ISO date string, or a `Date`, normalized to ms; expiration is not enforced. Prod returns real signed URLs from GCS.

---

## The remote byte cap

Relayed payloads are capped at 8 MiB per operation (whole-object buffering across the relay hops; the cap mirrors the worker host's `MAX_STORAGE_OP_BYTES`). An oversized `save` rejects with an `Error` carrying `code: 'payload-too-large'` and a message that names the size, the cap, and the remediation (split the object or keep it under the cap). The local arm has no cap.

---

## Deferred on both sandbox arms

Each throws `Error('not implemented in pyric-admin/storage sandbox backend: <what>')` (the remote arm says `remote sandbox backend` and, for streams, points at `save`/`download` as the alternative):

- Streaming: `createWriteStream`, `createReadStream`
- Resumable uploads (`save` with `resumable: true`)
- Signed cookies
- IAM policies
- Lifecycle rules
- ACLs
- Copy / move
- Notifications

Every one of these works on the prod arm.

---

## Types

### `Storage`, `Bucket`, `File`

```ts
interface Storage {
  bucket(name?: string): Bucket;
}

interface Bucket {
  readonly name: string;
  file(path: string): File;
}

interface File {
  readonly name: string;
  readonly bucket: Bucket;
  save(data: Buffer | string | Uint8Array, options?: SaveOptions): Promise<void>;
  download(options?: DownloadOptions): Promise<[Buffer]>;
  delete(): Promise<void>;
  exists(): Promise<[boolean]>;
  getSignedUrl(options: GetSignedUrlOptions): Promise<[string]>;
}
```

The shared contract across backends. On prod the returned object is a structural superset (the full `@google-cloud/storage` surface); the interfaces document the subset the sandbox arms implement.

### `SaveOptions`

```ts
interface SaveOptions {
  metadata?: Record<string, unknown>;
  contentType?: string; // shortcut for metadata.contentType
  resumable?: boolean;  // true throws on sandbox arms; prod forwards
}
```

### `DownloadOptions`

```ts
interface DownloadOptions {
  validation?: 'md5' | 'crc32c' | boolean; // sandbox arms ignore; prod forwards
}
```

### `GetSignedUrlOptions`

```ts
interface GetSignedUrlOptions {
  action: 'read' | 'write' | 'delete' | 'resumable';
  expires: number | string | Date;
}
```

### `StorageApp`

```ts
type StorageApp = PyricAdminApp;
```

The input `getStorage` accepts; an alias of the branded handle from `pyric-admin/app`.

---

## Where to go next

- [`pyric-admin/app` reference](../pyric-admin-app-reference-api/) for how the arm is chosen.
- `pyric/storage` for the Web-SDK-shaped mirror and the storage rules engine.
