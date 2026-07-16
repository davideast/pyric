---
title: "API reference: pyric-admin/storage"
navLabel: "pyric-admin/storage"
outcome: "Published declarations for pyric-admin/storage."
slug: "pyric-admin-storage-reference-api"
kind: "api"
apiPackage: "pyric-admin"
apiImportPath: "pyric-admin/storage"
apiSubpath: "storage"
apiSymbolCount: 8
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Interfaces

<a id="bucket"></a>

### Bucket

A storage bucket handle implemented by both local and remote sandbox
paths. Only the documented subset is supported.

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="name"></a> `name` | `readonly` | `string` | Name of the bucket. Stable across `file()` lookups. |

#### Methods

<a id="file"></a>

##### file()

```ts
file(path: string): File;
```

Get a [File](#file-2) handle for `path`. The file may or may not exist.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

###### Returns

[`File`](#file-2)

***

<a id="downloadoptions"></a>

### DownloadOptions

Options bag for [File.download](#download). Subset of `@google-cloud/storage`'s `DownloadOptions`.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="validation"></a> `validation?` | `boolean` \| `"md5"` \| `"crc32c"` | The sandbox accepts but ignores `validation`. |

***

<a id="file-2"></a>

### File

A file handle within a bucket. Method shapes mirror
`@google-cloud/storage`'s `File` (return tuples for download / exists
/ getSignedUrl, etc.) so common consumer code retains the familiar shape.

The sandbox backend implements the methods documented here. Any
other `File` method from `@google-cloud/storage` (`createWriteStream`,
`createReadStream`, `copy`, `move`, `setMetadata` beyond the basic
`save` options, etc.) throws on the sandbox path — see module header.

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="bucket-1"></a> `bucket` | `readonly` | [`Bucket`](#bucket) | Bucket the file belongs to. Same handle the `file()` call came from. |
| <a id="name-1"></a> `name` | `readonly` | `string` | Name (path) of the file within its bucket. |

#### Methods

<a id="delete"></a>

##### delete()

```ts
delete(): Promise<void>;
```

Remove the file from its bucket. Idempotent — deleting a missing
file is a no-op (matches `@google-cloud/storage`'s
`ignoreNotFound: true`, which is the only mode the sandbox models).

###### Returns

`Promise`\<`void`\>

<a id="download"></a>

##### download()

```ts
download(options?: DownloadOptions): Promise<[Buffer<ArrayBufferLike>]>;
```

Read the file's bytes. Returns a `[Buffer]` tuple to mirror
`@google-cloud/storage`'s `File.download` (which returns
`[Buffer, ...]`). Throws if the file does not exist.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `options?` | [`DownloadOptions`](#downloadoptions) |

###### Returns

`Promise`\<\[`Buffer`\<`ArrayBufferLike`\>\]\>

<a id="exists"></a>

##### exists()

```ts
exists(): Promise<[boolean]>;
```

`[true]` if the file exists, `[false]` otherwise. Tuple shape mirrors `@google-cloud/storage`.

###### Returns

`Promise`\<\[`boolean`\]\>

<a id="getsignedurl"></a>

##### getSignedUrl()

```ts
getSignedUrl(options: GetSignedUrlOptions): Promise<[string]>;
```

Return a stub signed URL of the form
`pyric-sandbox-storage://${path}?expires=${expires}`. The sandbox
does NOT serve the URL — it's a deterministic placeholder so
agent code that round-trips signed URLs (logs, fixtures, replay)
sees a stable shape.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `options` | [`GetSignedUrlOptions`](#getsignedurloptions) |

###### Returns

`Promise`\<\[`string`\]\>

<a id="save"></a>

##### save()

```ts
save(data: string | Buffer<ArrayBufferLike> | Uint8Array<ArrayBufferLike>, options?: SaveOptions): Promise<void>;
```

Persist `data` at this file's path. Replaces any existing content
(no append semantics). `options.metadata` is stored alongside the
bytes and surfaces on later reads via the in-memory state — the
sandbox doesn't expose a full `Metadata` API yet, but the payload
round-trips so future expansion is non-breaking.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `data` | `string` \| `Buffer`\<`ArrayBufferLike`\> \| `Uint8Array`\<`ArrayBufferLike`\> |
| `options?` | [`SaveOptions`](#saveoptions) |

###### Returns

`Promise`\<`void`\>

***

<a id="getsignedurloptions"></a>

### GetSignedUrlOptions

Options bag for [File.getSignedUrl](#getsignedurl). Mirrors `@google-cloud/storage`'s shape.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="action"></a> `action` | `"read"` \| `"write"` \| `"delete"` \| `"resumable"` | `'read' | 'write' | 'delete' | 'resumable'`. Sandbox stamps it into the URL only as a hint. |
| <a id="expires"></a> `expires` | `string` \| `number` \| `Date` | Expiration. Accepts ms-since-epoch (number), ISO date string, or `Date`. Sandbox normalizes to ms-since-epoch and embeds in the stub URL's `expires=` query. |

***

<a id="saveoptions"></a>

### SaveOptions

Options bag for [File.save](#save). Subset of `@google-cloud/storage`'s `SaveOptions`.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="contenttype"></a> `contentType?` | `string` | Content type hint stored on the sandbox entry. Convenience shortcut for `metadata.contentType`. |
| <a id="metadata"></a> `metadata?` | `Record`\<`string`, `unknown`\> | Arbitrary metadata stored alongside the file. The sandbox stores it verbatim; consumers that need to round-trip `contentType`, `metadata.custom`, etc. get it back via internal admin tooling (not exposed on `File` itself yet). |
| <a id="resumable"></a> `resumable?` | `boolean` | `resumable: false` is the only mode the sandbox models (single- shot writes). The sandbox throws when set to `true` since resumable uploads are deferred. |

***

<a id="storage"></a>

### Storage

`pyric-admin/storage`'s sandbox `Storage` handle. It exposes the subset
documented in the module header.

The shared `bucket(name?)` shape is the contract — consumers code
against it without caring whether the local or remote sandbox is live.

#### Methods

<a id="bucket-2"></a>

##### bucket()

```ts
bucket(name?: string): Bucket;
```

Get a [Bucket](#bucket) handle. When `name` is omitted, returns the
sandbox default bucket (`'pyric-default'`).

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `name?` | `string` |

###### Returns

[`Bucket`](#bucket)

## Type Aliases

<a id="storageapp"></a>

### StorageApp

```ts
type StorageApp = PyricAdminApp;
```

Input accepted by [getStorage](#getstorage). The branded `PyricAdminApp` is
the canonical shape; calling without an argument resolves the default
app from the `pyric-admin/app` registry (mirroring
`firebase-admin/storage`, where `getStorage()` resolves the default App),
and throws the captured `app/no-app` error when nothing is initialized.

## Functions

<a id="getstorage"></a>

### getStorage()

```ts
function getStorage(app?: SandboxAdminApp): Storage;
```

Get the [Storage](#storage) service for the given app.

Returns a sandbox-backed `Storage` whose state
  lives on the `Sandbox`. `sandbox.reset()` wipes it.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `app?` | `SandboxAdminApp` |

#### Returns

[`Storage`](#storage)
