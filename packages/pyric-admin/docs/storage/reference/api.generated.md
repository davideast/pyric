<!-- Generated from the package export declaration via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

# pyric-admin/storage

## Interfaces

### Bucket

A storage bucket handle implemented by both local and remote sandbox
paths. Only the documented subset is supported.

#### Properties

##### name

> `readonly` **name**: `string`

Name of the bucket. Stable across `file()` lookups.

#### Methods

##### file()

> **file**(`path`): [`File`](#file-2)

Get a [File](#file-2) handle for `path`. The file may or may not exist.

###### Parameters

###### path

`string`

###### Returns

[`File`](#file-2)

***

### DownloadOptions

Options bag for [File.download](#download). Subset of `@google-cloud/storage`'s `DownloadOptions`.

#### Properties

##### validation?

> `optional` **validation**: `boolean` \| `"md5"` \| `"crc32c"`

The sandbox accepts but ignores `validation`.

***

### File

A file handle within a bucket. Method shapes mirror
`@google-cloud/storage`'s `File` (return tuples for download / exists
/ getSignedUrl, etc.) so common consumer code retains the familiar shape.

The sandbox backend implements the methods documented here. Any
other `File` method from `@google-cloud/storage` (`createWriteStream`,
`createReadStream`, `copy`, `move`, `setMetadata` beyond the basic
`save` options, etc.) throws on the sandbox path — see module header.

#### Properties

##### bucket

> `readonly` **bucket**: [`Bucket`](#bucket)

Bucket the file belongs to. Same handle the `file()` call came from.

##### name

> `readonly` **name**: `string`

Name (path) of the file within its bucket.

#### Methods

##### delete()

> **delete**(): `Promise`\<`void`\>

Remove the file from its bucket. Idempotent — deleting a missing
file is a no-op (matches `@google-cloud/storage`'s
`ignoreNotFound: true`, which is the only mode the sandbox models).

###### Returns

`Promise`\<`void`\>

##### download()

> **download**(`options?`): `Promise`\<\[`Buffer`\<`ArrayBufferLike`\>\]\>

Read the file's bytes. Returns a `[Buffer]` tuple to mirror
`@google-cloud/storage`'s `File.download` (which returns
`[Buffer, ...]`). Throws if the file does not exist.

###### Parameters

###### options?

[`DownloadOptions`](#downloadoptions)

###### Returns

`Promise`\<\[`Buffer`\<`ArrayBufferLike`\>\]\>

##### exists()

> **exists**(): `Promise`\<\[`boolean`\]\>

`[true]` if the file exists, `[false]` otherwise. Tuple shape mirrors `@google-cloud/storage`.

###### Returns

`Promise`\<\[`boolean`\]\>

##### getSignedUrl()

> **getSignedUrl**(`options`): `Promise`\<\[`string`\]\>

Return a stub signed URL of the form
`pyric-sandbox-storage://${path}?expires=${expires}`. The sandbox
does NOT serve the URL — it's a deterministic placeholder so
agent code that round-trips signed URLs (logs, fixtures, replay)
sees a stable shape.

###### Parameters

###### options

[`GetSignedUrlOptions`](#getsignedurloptions)

###### Returns

`Promise`\<\[`string`\]\>

##### save()

> **save**(`data`, `options?`): `Promise`\<`void`\>

Persist `data` at this file's path. Replaces any existing content
(no append semantics). `options.metadata` is stored alongside the
bytes and surfaces on later reads via the in-memory state — the
sandbox doesn't expose a full `Metadata` API yet, but the payload
round-trips so future expansion is non-breaking.

###### Parameters

###### data

`string` | `Buffer`\<`ArrayBufferLike`\> | `Uint8Array`\<`ArrayBufferLike`\>

###### options?

[`SaveOptions`](#saveoptions)

###### Returns

`Promise`\<`void`\>

***

### GetSignedUrlOptions

Options bag for [File.getSignedUrl](#getsignedurl). Mirrors `@google-cloud/storage`'s shape.

#### Properties

##### action

> **action**: `"read"` \| `"write"` \| `"delete"` \| `"resumable"`

`'read' | 'write' | 'delete' | 'resumable'`. Sandbox stamps it into the URL only as a hint.

##### expires

> **expires**: `string` \| `number` \| `Date`

Expiration. Accepts ms-since-epoch (number), ISO date string, or
`Date`. Sandbox normalizes to ms-since-epoch and embeds in the
stub URL's `expires=` query.

***

### SaveOptions

Options bag for [File.save](#save). Subset of `@google-cloud/storage`'s `SaveOptions`.

#### Properties

##### contentType?

> `optional` **contentType**: `string`

Content type hint stored on the sandbox entry.
Convenience shortcut for `metadata.contentType`.

##### metadata?

> `optional` **metadata**: `Record`\<`string`, `unknown`\>

Arbitrary metadata stored alongside the file. The sandbox stores
it verbatim; consumers that need to round-trip `contentType`,
`metadata.custom`, etc. get it back via internal admin tooling
(not exposed on `File` itself yet).

##### resumable?

> `optional` **resumable**: `boolean`

`resumable: false` is the only mode the sandbox models (single-
shot writes). The sandbox throws when set to `true` since resumable
uploads are deferred.

***

### Storage

`pyric-admin/storage`'s sandbox `Storage` handle. It exposes the subset
documented in the module header.

The shared `bucket(name?)` shape is the contract — consumers code
against it without caring whether the local or remote sandbox is live.

#### Methods

##### bucket()

> **bucket**(`name?`): [`Bucket`](#bucket)

Get a [Bucket](#bucket) handle. When `name` is omitted, returns the
sandbox default bucket (`'pyric-default'`).

###### Parameters

###### name?

`string`

###### Returns

[`Bucket`](#bucket)

## Type Aliases

### StorageApp

> **StorageApp** = `PyricAdminApp`

Input accepted by [getStorage](#getstorage). The branded `PyricAdminApp` is
the canonical shape; calling without an argument resolves the default
app from the `pyric-admin/app` registry (mirroring
`firebase-admin/storage`, where `getStorage()` resolves the default App),
and throws the captured `app/no-app` error when nothing is initialized.

## Functions

### getStorage()

> **getStorage**(`app?`): [`Storage`](#storage)

Get the [Storage](#storage) service for the given app.

Returns a sandbox-backed `Storage` whose state
  lives on the `Sandbox`. `sandbox.reset()` wipes it.

#### Parameters

##### app?

`SandboxAdminApp`

#### Returns

[`Storage`](#storage)
