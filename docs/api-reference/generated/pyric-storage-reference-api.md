---
title: "API reference: pyric/storage"
navLabel: "pyric/storage"
outcome: "Published declarations for pyric/storage."
slug: "pyric-storage-reference-api"
kind: "api"
apiPackage: "pyric"
apiImportPath: "pyric/storage"
apiSubpath: "storage"
apiSymbolCount: 64
apiEvidenceSlug: "pyric-storage-compat"
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Classes

<a id="inspectstoragehandler"></a>

### InspectStorageHandler

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new InspectStorageHandler(): InspectStorageHandler;
```

###### Returns

[`InspectStorageHandler`](#inspectstoragehandler)

#### Methods

<a id="execute"></a>

##### execute()

```ts
execute(scope: ProjectScope): Promise<InspectStorageResult>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `scope` | `ProjectScope` |

###### Returns

`Promise`\<[`InspectStorageResult`](#inspectstorageresult)\>

***

<a id="provisionstoragehandler"></a>

### ProvisionStorageHandler

#### Constructors

<a id="constructor-1"></a>

##### Constructor

```ts
new ProvisionStorageHandler(): ProvisionStorageHandler;
```

###### Returns

[`ProvisionStorageHandler`](#provisionstoragehandler)

#### Methods

<a id="execute-2"></a>

##### execute()

```ts
execute(
   scope: ProjectScope,
   input: ProvisionStorageInput,
onProgress?: ProvisionProgress): Promise<ProvisionStorageOutcome>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `scope` | `ProjectScope` |
| `input` | [`ProvisionStorageInput`](#provisionstorageinput) |
| `onProgress?` | `ProvisionProgress` |

###### Returns

`Promise`\<[`ProvisionStorageOutcome`](#provisionstorageoutcome)\>

***

<a id="storageerror"></a>

### StorageError

Storage error carrying a prefixed `storage/<code>` on `.code`.
Drop-in for `err.code === 'storage/object-not-found'` branching.

#### Extends

- `Error`

#### Constructors

<a id="constructor-2"></a>

##### Constructor

```ts
new StorageError(code: StorageErrorCode, message: string): StorageError;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `code` | [`StorageErrorCode`](#storageerrorcode-1) |
| `message` | `string` |

###### Returns

[`StorageError`](#storageerror)

###### Overrides

```ts
Error.constructor
```

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="code"></a> `code` | `readonly` | \| `"storage/unknown"` \| `"storage/object-not-found"` \| `"storage/quota-exceeded"` \| `"storage/unauthenticated"` \| `"storage/unauthorized"` \| `"storage/invalid-root-operation"` \| `"storage/invalid-format"` \| `"storage/invalid-argument"` | Prefixed code, e.g. `storage/object-not-found`. |

***

<a id="storageprovisioningerror"></a>

### StorageProvisioningError

Pure-fetch client for the Firebase Storage provisioning APIs.
Takes an OAuth access token directly — works equally from a Node
agent runtime or a browser. Used by:

  - `ProvisionStorageHandler` server-side via the agent SDK
  - Consumers like the multi-tenant playground via direct import

The caller is responsible for token scope. `firebase` scope is
enough for the `:addFirebase` + `defaultLocation:finalize` calls,
but **NOT** for enabling the underlying `firebasestorage.googleapis.com`
service (which is the first-time gate). Service-enable requires
`cloud-platform` scope OR a service account with
`roles/serviceusage.serviceUsageAdmin`. Each function below
documents which scope it needs.

Endpoints under play:
  - serviceusage.googleapis.com/v1/projects/{p}/services/{s}:enable
  - firebase.googleapis.com/v1beta1/projects/{p}/defaultLocation:finalize
  - firebasestorage.googleapis.com/v1beta/projects/{p}/buckets
  - firebasestorage.googleapis.com/v1beta/projects/{p}/buckets/{b}:addFirebase
  - firebaserules.googleapis.com/v1/projects/{p}/releases/firebase.storage

#### Extends

- `Error`

#### Constructors

<a id="constructor-3"></a>

##### Constructor

```ts
new StorageProvisioningError(
   status: number,
   body: string,
   reason: string,
   message: string): StorageProvisioningError;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `status` | `number` |
| `body` | `string` |
| `reason` | `string` |
| `message` | `string` |

###### Returns

[`StorageProvisioningError`](#storageprovisioningerror)

###### Overrides

```ts
Error.constructor
```

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="body"></a> `body` | `readonly` | `string` |
| <a id="reason"></a> `reason` | `readonly` | `string` |
| <a id="status"></a> `status` | `readonly` | `number` |

## Interfaces

<a id="corsrule"></a>

### CorsRule

A single CORS rule entry, mirroring the GCS bucket CORS schema.
See https://cloud.google.com/storage/docs/cross-origin#cors-elements.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="maxageseconds"></a> `maxAgeSeconds?` | `number` |
| <a id="method"></a> `method` | `string`[] |
| <a id="origin"></a> `origin` | `string`[] |
| <a id="responseheader"></a> `responseHeader?` | `string`[] |

***

<a id="evaluationinput"></a>

### EvaluationInput

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="request"></a> `request` | [`StorageRequest`](#storagerequest) |
| <a id="resource"></a> `resource` | [`StorageResource`](#storageresource) |

***

<a id="evaluationresult"></a>

### EvaluationResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="allowed"></a> `allowed` | `boolean` | - |
| <a id="reasons"></a> `reasons` | `string`[] | Human-readable explanation of why — used by Slice 8's integration to populate `storage/unauthorized` error messages. |

***

<a id="firebasestorage"></a>

### FirebaseStorage

Public opaque handle. Carries a [Target](#target) via
[TARGET\_SYMBOL](#target_symbol-1); never inspected by consumer code, which
interacts with storage only through [ref](#ref-1) and the operation
free functions.

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="target_symbol"></a> `[TARGET_SYMBOL]` | `readonly` | [`SandboxTarget`](#sandboxtarget) |
| <a id="app"></a> `app?` | `readonly` | `FirebaseApp` |

***

<a id="firebasestoragebucket"></a>

### FirebaseStorageBucket

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="bucketid"></a> `bucketId` | `string` |
| <a id="name"></a> `name` | `string` |
| <a id="reconciling"></a> `reconciling?` | `boolean` |

***

<a id="firestorelookup"></a>

### FirestoreLookup

Injected capability that lets a Storage rule read Firestore documents
(`firestore.get(path)` / `firestore.exists(path)`), WITHOUT the pure
evaluator importing the Firestore sandbox. The enforcement layer builds
one from the sandbox's admin Firestore accessor (a synchronous in-memory
read) and passes it into [evaluateStorageRules](#evaluatestoragerules); pure/test callers
that omit it get the deny-with-reason "unsupported" behavior instead.

Paths are the document path RELATIVE to the database — the
`collection/doc` form `sandbox.admin.getDocument` expects — after the
evaluator has stripped the `/databases/<db>/documents/` prefix from the
rule's path literal.

#### Methods

<a id="exists"></a>

##### exists()

```ts
exists(path: string): boolean;
```

Whether a document exists at `path`.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

###### Returns

`boolean`

<a id="get"></a>

##### get()

```ts
get(path: string): Record<string, unknown>;
```

The document's fields, or `null` when the document does not exist.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

###### Returns

`Record`\<`string`, `unknown`\>

***

<a id="fullmetadata"></a>

### FullMetadata

Server-set + client-settable fields read back from
`uploadBytes` / `getMetadata` / `updateMetadata`. Server-set
fields (`bucket`, `fullPath`, `name`, `generation`,
`metageneration`, `timeCreated`, `updated`, `size`) are populated
by the upload pipeline; client-settable fields round-trip from
`SettableMetadata`.

#### Extends

- [`SettableMetadata`](#settablemetadata)

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="bucket"></a> `bucket` | `string` |
| <a id="cachecontrol"></a> `cacheControl?` | `string` |
| <a id="contentdisposition"></a> `contentDisposition?` | `string` |
| <a id="contentencoding"></a> `contentEncoding?` | `string` |
| <a id="contentlanguage"></a> `contentLanguage?` | `string` |
| <a id="contenttype"></a> `contentType?` | `string` |
| <a id="custommetadata"></a> `customMetadata?` | \{ \[`key`: `string`\]: `string`; \} |
| <a id="fullpath"></a> `fullPath` | `string` |
| <a id="generation"></a> `generation` | `string` |
| <a id="md5hash"></a> `md5Hash?` | `string` |
| <a id="metageneration"></a> `metageneration` | `string` |
| <a id="name-1"></a> `name` | `string` |
| <a id="size"></a> `size` | `number` |
| <a id="timecreated"></a> `timeCreated` | `string` |
| <a id="updated"></a> `updated` | `string` |

***

<a id="inspectstorageresult"></a>

### InspectStorageResult

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="buckets"></a> `buckets` | \{ `bucketId`: `string`; `name`: `string`; \}[] |
| <a id="defaultlocation"></a> `defaultLocation` | `string` |
| <a id="servicestate"></a> `serviceState` | `"unknown"` \| `"enabled"` \| `"disabled"` |

***

<a id="listresult"></a>

### ListResult

Mirrors `firebase/storage`'s `ListResult`. `nextPageToken` is
`undefined` for `listAll`; query `pyric can-i-use storage/list` for the
current availability of the separate paginated operation.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="items"></a> `items` | [`StorageReference`](#storagereference)[] |
| <a id="nextpagetoken"></a> `nextPageToken?` | `string` |
| <a id="prefixes"></a> `prefixes` | [`StorageReference`](#storagereference)[] |

***

<a id="provisionstorageinput"></a>

### ProvisionStorageInput

Shapes for the Storage provisioning + status tools.

Types only — the agent-tool parameter schemas live inline in
`tools.ts` as JSON Schema (the `ToolHandler` contract).

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="bucketid-1"></a> `bucketId?` | `string` | Override the default Firebase Storage bucket ID. Defaults to `{projectId}.firebasestorage.app`. |
| <a id="cors"></a> `cors?` | \{ `maxAgeSeconds?`: `number`; `method`: `string`[]; `origin`: `string`[]; `responseHeader?`: `string`[]; \}[] | CORS rules to apply to the bucket. Required for browser-side reads/writes from a non-Firebase origin. Omit to leave existing CORS untouched. |
| <a id="locationid"></a> `locationId?` | `string` | Default GCP resources location to use when the project has not been finalized yet. IRREVERSIBLE once set. Common values: `us-central`, `nam5`, `eur3`. Default: `us-central`. |
| <a id="rules"></a> `rules?` | `string` | Storage rules source to deploy after the bucket is linked. Optional; when omitted, whatever rules are currently released (possibly the deny-all default) stay in place. |

***

<a id="provisionstorageoptions"></a>

### ProvisionStorageOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="bucketid-2"></a> `bucketId?` | `string` | Override the default Firebase Storage bucket ID. Defaults to `{projectId}.firebasestorage.app` — the bucket Firebase Console creates automatically. |
| <a id="cors-1"></a> `cors?` | [`CorsRule`](#corsrule)[] | CORS rules to apply to the bucket after it's linked. Required for browser-side reads/writes from a non-Firebase origin — buckets created via the Cloud Console (vs Firebase Console) often ship with no CORS configuration, which manifests as `No 'Access-Control-Allow-Origin' header` on the first `XMLHttpRequest` from a hosted page. Pass `defaultPlaygroundCors(origin)` for a sensible starter config, or a custom array. Omit to leave the bucket's CORS alone. |
| <a id="locationid-1"></a> `locationId?` | `string` | Default GCP resources location to use if the project hasn't been finalized yet. Ignored when the location is already set. Default: `'us-central'`. |
| <a id="onprogress"></a> `onProgress?` | `ProvisionProgress` | Optional progress callback, invoked at each provisioning step boundary. |
| <a id="rules-1"></a> `rules?` | `string` | Storage rules source to deploy after the bucket is linked. When omitted, no rules are deployed (the project keeps whatever rules were last released — possibly the default deny-all). |

***

<a id="provisionstorageresult"></a>

### ProvisionStorageResult

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="bucketcreated"></a> `bucketCreated` | `boolean` |
| <a id="bucketid-3"></a> `bucketId` | `string` |
| <a id="corsapplied"></a> `corsApplied` | `boolean` |
| <a id="locationfinalized"></a> `locationFinalized` | `boolean` |
| <a id="locationid-2"></a> `locationId` | `string` |
| <a id="ok"></a> `ok` | `true` |
| <a id="rulesdeployed"></a> `rulesDeployed` | `boolean` |
| <a id="rulesetname"></a> `rulesetName?` | `string` |
| <a id="serviceenabled"></a> `serviceEnabled` | `boolean` |

***

<a id="sandboxtarget"></a>

### SandboxTarget

Sandbox target — IDB-backed, identity from `SandboxContext`, rules
enforced in-process via `enforce.ts`.

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="admin"></a> `admin?` | `readonly` | `boolean` | Rules-bypass admin plane. `true` only on handles minted by the INTERNAL getAdminStorageSandbox factory (exported via `pyric/storage/internal`, never the public surface): operations on an admin handle skip rule evaluation entirely — the storage mirror of `getAdminFirestore` / `getAdminDatabase`. The public modular surface stays rules-honest; this exists so hosts (the SharedWorker's `actAs: { mode: 'admin' }` lens) can serve firebase-admin semantics against the same shared store. |
| <a id="bucket-1"></a> `bucket` | `readonly` | `string` | - |
| <a id="context"></a> `context` | `readonly` | `SandboxContext` | - |
| <a id="currentauth"></a> `currentAuth?` | `readonly` | () => `AuthState` | App handles resolve auth at operation time; explicit contexts stay frozen. |
| <a id="kind"></a> `kind` | `readonly` | `"sandbox"` | - |
| <a id="sandbox"></a> `sandbox` | `readonly` | `Sandbox` | - |
| <a id="servicepromise"></a> `servicePromise` | `readonly` | `Promise`\<`StorageService`\> | - |

***

<a id="settablemetadata"></a>

### SettableMetadata

Client-settable fields. Passed to `uploadBytes` /
`uploadString` / `updateMetadata`. Every field is optional — the
upload pipeline fills any unsupplied client fields with sane
defaults (e.g. `contentType` falls back to `application/octet-stream`).

#### Extended by

- [`FullMetadata`](#fullmetadata)

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="cachecontrol-1"></a> `cacheControl?` | `string` |
| <a id="contentdisposition-1"></a> `contentDisposition?` | `string` |
| <a id="contentencoding-1"></a> `contentEncoding?` | `string` |
| <a id="contentlanguage-1"></a> `contentLanguage?` | `string` |
| <a id="contenttype-1"></a> `contentType?` | `string` |
| <a id="custommetadata-1"></a> `customMetadata?` | \{ \[`key`: `string`\]: `string`; \} |

***

<a id="storageadmintooldeps"></a>

### StorageAdminToolDeps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="scope"></a> `scope` | `ProjectScope` | Project identity + token resolver. |

***

<a id="storageauth"></a>

### StorageAuth

Identity passed in with the request. `null` is anonymous.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="token"></a> `token?` | `Record`\<`string`, `unknown`\> |
| <a id="uid"></a> `uid` | `string` |

***

<a id="storageoptions"></a>

### StorageOptions

Options for [getStorageSandbox](#getstoragesandbox).

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="bucket-2"></a> `bucket?` | `string` | Bucket identifier recorded on uploaded metadata. v1 has a single implicit bucket and does not enforce cross-bucket isolation — passing different values per call is accepted and round-trips in metadata, but the data store is shared. |
| <a id="dbname"></a> `dbName?` | `string` | Override the IndexedDB database name. Tests pass per-case unique names so state doesn't leak between runs. Only takes effect on the FIRST call per `Sandbox`. |
| <a id="rules-2"></a> `rules?` | `string` | Storage rules source. Parsed eagerly so a malformed string throws at config time. Only honored on the FIRST call per `Sandbox`. |

***

<a id="storagereference"></a>

### StorageReference

Public reference shape. Methods are inherited from the impl
classes below; the interface is exported so consumer code can
name the type without depending on the impls.

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="bucket-3"></a> `bucket` | `readonly` | `string` |
| <a id="fullpath-1"></a> `fullPath` | `readonly` | `string` |
| <a id="name-2"></a> `name` | `readonly` | `string` |
| <a id="parent"></a> `parent` | `readonly` | [`StorageReference`](#storagereference) |
| <a id="root"></a> `root` | `readonly` | [`StorageReference`](#storagereference) |
| <a id="storage"></a> `storage` | `readonly` | [`FirebaseStorage`](#firebasestorage) |

#### Methods

<a id="tostring"></a>

##### toString()

```ts
toString(): string;
```

###### Returns

`string`

***

<a id="storagerequest"></a>

### StorageRequest

Inbound request bindings the rules see.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="auth"></a> `auth` | [`StorageAuth`](#storageauth) | - |
| <a id="method-1"></a> `method` | [`StorageRequestMethod`](#storagerequestmethod-1) | - |
| <a id="path"></a> `path` | `string` | Path of the object the request targets. |
| <a id="resource-1"></a> `resource?` | \{ `contentType?`: `string`; `metadata?`: `Record`\<`string`, `string`\>; `size`: `number`; \} | Per-Firebase: on writes, `request.resource` describes the about-to-write object. Omit for reads (the rules language treats `request.resource` as unset there). |
| `resource.contentType?` | `string` | - |
| `resource.metadata?` | `Record`\<`string`, `string`\> | - |
| `resource.size` | `number` | - |

***

<a id="storageresource"></a>

### StorageResource

Existing-object bindings (for `resource.*`). `null` when no object exists
yet (creates).

The object-identity/time fields carry GOOGLE CLOUD STORAGE semantics, not
the client SDK's `FullMetadata` semantics — the two disagree on `name`:

  - rules `resource.name` is the object's FULL path within the bucket
    (`uploads/pic.png`), the GCS object-name convention. The client SDK's
    `FullMetadata.name` is the LAST path segment (`pic.png`). The adapter
    (`resourceFromStored`) therefore sources `name` from the persisted
    record's `fullPath`, NOT its `name`.
  - `timeCreated` / `updated` are ISO-8601 strings here (the persisted
    shape); the evaluator converts them to epoch millis when it builds the
    binding, so they compare numerically against `request.time` and against
    each other. Production types them as `timestamp` and rejects an int in
    their place ("Received: int < timestamp").
  - The update-time field is `updated`. There is NO `resource.timeUpdated`
    in the Storage rules language.

A field left `undefined` reads as ABSENT, which production treats as an
evaluation error that denies (see RuleError).

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="bucket-4"></a> `bucket?` | `string` | Bucket the object lives in. |
| <a id="contenttype-2"></a> `contentType?` | `string` | - |
| <a id="generation-1"></a> `generation?` | `number` | Content generation (production types it `int`). |
| <a id="metadata"></a> `metadata?` | `Record`\<`string`, `string`\> | - |
| <a id="metageneration-1"></a> `metageneration?` | `number` | Metadata generation (production types it `int`). |
| <a id="name-3"></a> `name?` | `string` | Full object path within the bucket, e.g. `uploads/pic.png`. |
| <a id="size-1"></a> `size` | `number` | - |
| <a id="timecreated-1"></a> `timeCreated?` | `string` | ISO-8601 creation time. |
| <a id="updated-1"></a> `updated?` | `string` | ISO-8601 time of the most recent content/metadata update. |

***

<a id="storagerules"></a>

### StorageRules

Opaque parsed-rules handle returned by `parseStorageRules`.

***

<a id="uploadresult"></a>

### UploadResult

Return shape of `uploadBytes` / `uploadString`.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="metadata-1"></a> `metadata` | [`FullMetadata`](#fullmetadata) |
| <a id="ref"></a> `ref` | [`StorageReference`](#storagereference) |

## Type Aliases

<a id="provisionstorageerrorcode"></a>

### ProvisionStorageErrorCode

```ts
type ProvisionStorageErrorCode =
  | "PERMISSION_DENIED"
  | "SERVICE_DISABLED"
  | "LOCATION_FINALIZE_FAILED"
  | "BUCKET_CREATE_FAILED"
  | "RULES_DEPLOY_FAILED"
  | "CORS_UPDATE_FAILED"
  | "UNKNOWN";
```

***

<a id="provisionstorageoutcome"></a>

### ProvisionStorageOutcome

```ts
type ProvisionStorageOutcome =
  | {
  bucketCreated: boolean;
  bucketId: string;
  corsApplied: boolean;
  locationFinalized: boolean;
  locationId: string | null;
  rulesDeployed: boolean;
  rulesetName?: string;
  serviceEnabled: boolean;
  success: true;
}
  | {
  error: {
     code: ProvisionStorageErrorCode;
     message: string;
     recoverable: boolean;
  };
  success: false;
};
```

***

<a id="serviceenablestate"></a>

### ServiceEnableState

```ts
type ServiceEnableState = "enabled" | "disabled" | "unknown";
```

***

<a id="storageerrorcode-1"></a>

### StorageErrorCode

```ts
type StorageErrorCode =
  | "unknown"
  | "object-not-found"
  | "quota-exceeded"
  | "unauthenticated"
  | "unauthorized"
  | "invalid-root-operation"
  | "invalid-format"
  | "invalid-argument";
```

The unprefixed storage error codes the sandbox can raise. Mirrors
the subset of `StorageErrorCode` used by currently implemented operations.

***

<a id="storagegrantverb"></a>

### StorageGrantVerb

```ts
type StorageGrantVerb = StorageMethod | StorageVerb;
```

A verb token that may appear in an `allow` clause.

***

<a id="storagemethod"></a>

### StorageMethod

```ts
type StorageMethod = "read" | "write";
```

Coarse permission umbrellas. `read` covers get + list; `write`
 covers create + update + delete.

***

<a id="storagerequestmethod-1"></a>

### StorageRequestMethod

```ts
type StorageRequestMethod = StorageMethod | StorageVerb;
```

What a caller records as the request's operation. Callers pass the
 precise granular verb; the coarse forms remain accepted so the
 umbrella semantics are symmetric.

***

<a id="storageverb"></a>

### StorageVerb

```ts
type StorageVerb = "get" | "list" | "create" | "update" | "delete";
```

Granular operation verbs. Production Storage maps each operation to
 exactly one of these:
   download / getMetadata      → get
   list                        → list
   upload to NONEXISTENT path  → create
   upload / updateMetadata over
     an EXISTING object        → update
   delete                      → delete

***

<a id="stringformat"></a>

### StringFormat

```ts
type StringFormat = "raw" | "base64" | "data_url";
```

`uploadString` format selector.

***

<a id="target"></a>

### Target

```ts
type Target = SandboxTarget;
```

## Variables

<a id="target_symbol-1"></a>

### TARGET\_SYMBOL

```ts
const TARGET_SYMBOL: unique symbol;
```

Hidden property on every [FirebaseStorage](#firebasestorage) handle. Carries
the sandbox state free functions share without exposing it publicly.

## Functions

<a id="addfirebasetobucket"></a>

### addFirebaseToBucket()

```ts
function addFirebaseToBucket(
   accessToken: string,
   projectId: string,
bucketId: string): Promise<FirebaseStorageBucket>;
```

Link a Cloud Storage bucket to Firebase Storage. Idempotent — if
the bucket is already Firebase-linked, the API returns 200 with
the existing record. The bucket must already exist as a GCS
resource; for the default Firebase bucket name
(`{projectId}.firebasestorage.app`), Firebase auto-creates it on
first `:addFirebase` call.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `accessToken` | `string` |
| `projectId` | `string` |
| `bucketId` | `string` |

#### Returns

`Promise`\<[`FirebaseStorageBucket`](#firebasestoragebucket)\>

***

<a id="connectstorageemulator"></a>

### connectStorageEmulator()

```ts
function connectStorageEmulator(
   _storage: FirebaseStorage,
   _host: string,
   _port: number,
   _options?: {
  mockUserToken?: string | Record<string, unknown>;
}): void;
```

Accepted no-op because the selected Storage backend already is local.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `_storage` | [`FirebaseStorage`](#firebasestorage) |
| `_host` | `string` |
| `_port` | `number` |
| `_options?` | \{ `mockUserToken?`: `string` \| `Record`\<`string`, `unknown`\>; \} |
| `_options.mockUserToken?` | `string` \| `Record`\<`string`, `unknown`\> |

#### Returns

`void`

***

<a id="createstorageadmintools"></a>

### createStorageAdminTools()

```ts
function createStorageAdminTools(deps: StorageAdminToolDeps): ToolHandler<unknown, unknown>[];
```

Bundles:
  - `storage_get_status`
  - `storage_provision`

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `deps` | [`StorageAdminToolDeps`](#storageadmintooldeps) |

#### Returns

`ToolHandler`\<`unknown`, `unknown`\>[]

***

<a id="defaultplaygroundcors"></a>

### defaultPlaygroundCors()

```ts
function defaultPlaygroundCors(hostingOrigin: string): CorsRule[];
```

Default rule for a browser playground hosted on Firebase Hosting.
Allows GET/POST/PUT/DELETE/HEAD/OPTIONS from the Hosting origin
+ common localhost dev ports, with response headers needed by the
Firebase Storage Web SDK.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `hostingOrigin` | `string` |

#### Returns

[`CorsRule`](#corsrule)[]

***

<a id="deleteobject"></a>

### deleteObject()

```ts
function deleteObject(ref: StorageReference, provenance?: EventProvenance): Promise<void>;
```

Delete the object at `ref` — removes both the blob and the
metadata atomically. No-op when the path doesn't exist (the
persistence layer's `delete` is no-op on missing keys).

NOTE: the JS SDK's `deleteObject` throws
`storage/object-not-found` when the path is missing. The v1 scope
keeps the persistence-layer no-op behavior for now; Slice 8 will
reconsider whether to mirror the strict throw.

`provenance` (host-only): op EventProvenance bound at ISSUE time,
threaded EXPLICITLY onto the emitted `object_delete` event. The delete
awaits the backend before emitting, so it escapes the sandbox's
synchronous ambient-provenance window — see the note on `uploadBytes`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `ref` | [`StorageReference`](#storagereference) |
| `provenance?` | `EventProvenance` |

#### Returns

`Promise`\<`void`\>

***

<a id="deploystoragerules"></a>

### deployStorageRules()

```ts
function deployStorageRules(
   accessToken: string,
   projectId: string,
   source: string,
   bucketId?: string): Promise<{
  rulesetName: string;
}>;
```

Deploy a Storage rules source for a specific bucket. Firebase
Storage uses **per-bucket** release names —
`projects/{p}/releases/firebase.storage/{bucketId}` — for actual
rule application. The project-wide `firebase.storage` release
exists as a legacy alias but isn't bound to any bucket in modern
projects; deploying to it leaves the bucket's deny-all rule
unchanged.

Defaults `bucketId` to `{projectId}.firebasestorage.app` (the
Firebase default bucket name). Pass an override when targeting a
non-default bucket.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `accessToken` | `string` |
| `projectId` | `string` |
| `source` | `string` |
| `bucketId?` | `string` |

#### Returns

`Promise`\<\{
  `rulesetName`: `string`;
\}\>

***

<a id="enablestorageservice"></a>

### enableStorageService()

```ts
function enableStorageService(accessToken: string, projectId: string): Promise<void>;
```

Enable `firebasestorage.googleapis.com` on the project. Requires
`serviceusage.services.enable` IAM permission — included in
`roles/owner`, `roles/editor` (deprecated), or
`roles/serviceusage.serviceUsageAdmin`. The default Firebase Admin
SDK service account does NOT have this; the caller's token must
either be a user-OAuth with `cloud-platform` scope or a SA with
the elevated role.

Long-running operation under the hood; the response carries an
operation name. We don't poll — the response 200 is enough signal
for our purposes, and a brief settle delay handles propagation.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `accessToken` | `string` |
| `projectId` | `string` |

#### Returns

`Promise`\<`void`\>

***

<a id="evaluatestoragerules"></a>

### evaluateStorageRules()

```ts
function evaluateStorageRules(
   rules: StorageRules,
   input: EvaluationInput,
   now?: Date,
   firestoreLookup?: FirestoreLookup): EvaluationResult;
```

Evaluate the rules against a request + resource binding. Returns
`{ allowed, reasons }`. `allowed` is true iff any `allow` clause
at any matching match block evaluates to a truthy condition.

Path-matching strategy: the request's path is segmented and
walked against the AST's match tree. Wildcards (`{p=**}`) match
zero or more remaining segments; named params bind one segment.

Multi-clause failure mode: when no clause matches, `reasons`
contains a short trace ("no match found for path X" or "rule at
match /sessions/{id} denied: condition false"). Helpful for the
playground's error surface.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `rules` | [`StorageRules`](#storagerules) |
| `input` | [`EvaluationInput`](#evaluationinput) |
| `now?` | `Date` |
| `firestoreLookup?` | [`FirestoreLookup`](#firestorelookup) |

#### Returns

[`EvaluationResult`](#evaluationresult)

***

<a id="finalizedefaultlocation"></a>

### finalizeDefaultLocation()

```ts
function finalizeDefaultLocation(
   accessToken: string,
   projectId: string,
locationId: string): Promise<void>;
```

Set the project's default GCP resources location. IRREVERSIBLE —
once set, the location cannot be changed. Skip-if-set is the
caller's job; this function unconditionally calls `:finalize`.

Per observed behavior, `:finalize` 404s on projects that already
have resources provisioned (RTDB, Hosting) without a default
location. The error path surfaces that to the caller.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `accessToken` | `string` |
| `projectId` | `string` |
| `locationId` | `string` |

#### Returns

`Promise`\<`void`\>

***

<a id="getblob"></a>

### getBlob()

```ts
function getBlob(ref: StorageReference, maxDownloadSizeBytes?: number): Promise<Blob>;
```

Read the blob at `ref` and return it as a `Blob`. Same semantics
as `getBytes` but skips the `arrayBuffer()` conversion when the
caller wants a `Blob` directly (e.g. for streaming or
`URL.createObjectURL`). Note: this is the browser-side
counterpart of the JS SDK's `getBlob` — the v1 scope doesn't ship
a Node-stream variant.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `ref` | [`StorageReference`](#storagereference) |
| `maxDownloadSizeBytes?` | `number` |

#### Returns

`Promise`\<`Blob`\>

***

<a id="getbucketcors"></a>

### getBucketCors()

```ts
function getBucketCors(accessToken: string, bucketId: string): Promise<CorsRule[]>;
```

Read the current CORS configuration for a bucket.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `accessToken` | `string` |
| `bucketId` | `string` |

#### Returns

`Promise`\<[`CorsRule`](#corsrule)[]\>

***

<a id="getbytes"></a>

### getBytes()

```ts
function getBytes(ref: StorageReference, maxDownloadSizeBytes?: number): Promise<ArrayBuffer>;
```

Read the blob at `ref` and return its contents as an
`ArrayBuffer`. Honors the optional `maxDownloadSizeBytes` cap by
truncating to that length.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `ref` | [`StorageReference`](#storagereference) |
| `maxDownloadSizeBytes?` | `number` |

#### Returns

`Promise`\<`ArrayBuffer`\>

***

<a id="getdefaultlocation"></a>

### getDefaultLocation()

```ts
function getDefaultLocation(accessToken: string, projectId: string): Promise<string>;
```

Read the project's current default GCP resources location. Returns
null when the project hasn't been finalized yet — e.g. brand-new
Firebase projects with no resources. `firebase` scope is sufficient.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `accessToken` | `string` |
| `projectId` | `string` |

#### Returns

`Promise`\<`string`\>

***

<a id="getdownloadurl"></a>

### getDownloadURL()

```ts
function getDownloadURL(ref: StorageReference): Promise<string>;
```

Return a URL the current page can use to read the sandbox object. The URL is
created from the same rules-checked blob as [getBlob](#getblob). It is a
snapshot, cannot be shared outside the page, and stays
alive until the caller revokes it or the page unloads.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `ref` | [`StorageReference`](#storagereference) |

#### Returns

`Promise`\<`string`\>

***

<a id="getmetadata"></a>

### getMetadata()

```ts
function getMetadata(ref: StorageReference): Promise<FullMetadata>;
```

Read the full metadata record at `ref`. Throws when no object
exists at the path (`storage/object-not-found`).

Mirrors `firebase/storage`'s `getMetadata`. Returns the same
`FullMetadata` shape `uploadBytes` produced — server-set fields
pinned at upload time, client-settable fields whatever the latest
write left them as.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `ref` | [`StorageReference`](#storagereference) |

#### Returns

`Promise`\<[`FullMetadata`](#fullmetadata)\>

***

<a id="getstorage"></a>

### getStorage()

```ts
function getStorage(app?: FirebaseApp, bucketUrl?: string): AppFirebaseStorage;
```

Resolve the Firebase-shaped Storage service associated with an app.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `app?` | `FirebaseApp` |
| `bucketUrl?` | `string` |

#### Returns

`AppFirebaseStorage`

***

<a id="getstoragesandbox"></a>

### getStorageSandbox()

```ts
function getStorageSandbox(target: any, options?: StorageOptions): FirebaseStorage;
```

Construct (or return cached) a sandbox-backed `FirebaseStorage`
handle. Accepts either a bare `Sandbox` (anonymous identity wired
up via `sandbox.withAuth(null)`) or an explicit `SandboxContext`.
Idempotent on `SandboxContext` identity.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `target` | `any` |
| `options?` | [`StorageOptions`](#storageoptions) |

#### Returns

[`FirebaseStorage`](#firebasestorage)

***

<a id="getstorageservicestate"></a>

### getStorageServiceState()

```ts
function getStorageServiceState(accessToken: string, projectId: string): Promise<ServiceEnableState>;
```

Probe whether the `firebasestorage.googleapis.com` service is
enabled on the project. Cheap, uses Service Usage `GET`. Requires
`serviceusage.services.get` permission (the default Firebase Admin
SDK SA has this; user OAuth tokens with `firebase` scope do not).

Returns `'unknown'` on permission failures so callers can downgrade
to "try the operation; observe SERVICE_DISABLED" rather than block.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `accessToken` | `string` |
| `projectId` | `string` |

#### Returns

`Promise`\<[`ServiceEnableState`](#serviceenablestate)\>

***

<a id="listall"></a>

### listAll()

```ts
function listAll(refIn: StorageReference): Promise<ListResult>;
```

Enumerate every immediate child item + sub-prefix under `refIn`.
Works on the root reference too — pass `ref(storage)` to scan the
whole bucket.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `refIn` | [`StorageReference`](#storagereference) |

#### Returns

`Promise`\<[`ListResult`](#listresult)\>

***

<a id="listfirebasebuckets"></a>

### listFirebaseBuckets()

```ts
function listFirebaseBuckets(accessToken: string, projectId: string): Promise<FirebaseStorageBucket[]>;
```

List Firebase-linked Storage buckets on the project. Returns an
empty list when none exist yet. Throws when the underlying service
is disabled — callers should check `getStorageServiceState` first
if they want to distinguish.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `accessToken` | `string` |
| `projectId` | `string` |

#### Returns

`Promise`\<[`FirebaseStorageBucket`](#firebasestoragebucket)[]\>

***

<a id="parsestoragerules"></a>

### parseStorageRules()

```ts
function parseStorageRules(source: string): StorageRules;
```

Parse a Storage rules source into an opaque handle. Throws
`SyntaxError` on malformed input. Used by Slice 8's
`getStorage(ctx, { rules })` to validate upfront.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `source` | `string` |

#### Returns

[`StorageRules`](#storagerules)

***

<a id="provisionstorage"></a>

### provisionStorage()

```ts
function provisionStorage(
   accessToken: string,
   projectId: string,
options?: ProvisionStorageOptions): Promise<ProvisionStorageResult>;
```

End-to-end Storage enablement + provisioning. Each step is
idempotent (probe before mutating); the result reports what was
actually done.

Permission requirements (caller's token):
  - `roles/serviceusage.serviceUsageAdmin` (or Owner) — to enable
    the service when it's disabled
  - `cloud-platform` OAuth scope (or `firebase` if service already
    enabled)

The handler throws `StorageProvisioningError` with the
underlying `reason` (e.g. `AUTH_PERMISSION_DENIED`,
`SERVICE_DISABLED`) so the caller can route to actionable UX.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `accessToken` | `string` |
| `projectId` | `string` |
| `options?` | [`ProvisionStorageOptions`](#provisionstorageoptions) |

#### Returns

`Promise`\<[`ProvisionStorageResult`](#provisionstorageresult)\>

***

<a id="ref-1"></a>

### ref()

#### Call Signature

```ts
function ref(storage: FirebaseStorage, path?: string): StorageReference;
```

Construct a reference. Two overloads matching Firebase:

  `ref(storage, path?)`   — `path` is bucket-rooted. Omit for root.
  `ref(parent, path)`     — `path` is relative to `parent.fullPath`.

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `storage` | [`FirebaseStorage`](#firebasestorage) |
| `path?` | `string` |

##### Returns

[`StorageReference`](#storagereference)

#### Call Signature

```ts
function ref(parent: StorageReference, path: string): StorageReference;
```

Construct a reference. Two overloads matching Firebase:

  `ref(storage, path?)`   — `path` is bucket-rooted. Omit for root.
  `ref(parent, path)`     — `path` is relative to `parent.fullPath`.

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `parent` | [`StorageReference`](#storagereference) |
| `path` | `string` |

##### Returns

[`StorageReference`](#storagereference)

***

<a id="setbucketcors"></a>

### setBucketCors()

```ts
function setBucketCors(
   accessToken: string,
   bucketId: string,
cors: CorsRule[]): Promise<void>;
```

Replace the bucket's CORS configuration. Pass an empty array to
clear all rules. The GCS API replaces (not merges) the cors field
on PATCH.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `accessToken` | `string` |
| `bucketId` | `string` |
| `cors` | [`CorsRule`](#corsrule)[] |

#### Returns

`Promise`\<`void`\>

***

<a id="updatemetadata"></a>

### updateMetadata()

```ts
function updateMetadata(
   ref: StorageReference,
   patch: SettableMetadata,
provenance?: EventProvenance): Promise<FullMetadata>;
```

Update the client-settable metadata at `ref`. Server-set fields
(`bucket`, `fullPath`, `name`, `generation`, `timeCreated`,
`size`, `md5Hash`) are preserved; `metageneration` bumps and
`updated` refreshes. The blob is untouched.

Pass `undefined` for a field to leave the previous value in
place. To explicitly clear a field, the JS SDK accepts `null` —
we don't model that in the v1 scope to keep the patch logic simple.
Documented for Slice 9's deferred-features section.

`provenance` (host-only): op EventProvenance bound at ISSUE time,
threaded EXPLICITLY onto the emitted `metadata_update` event. Emit runs
after the backend awaits, escaping the sandbox's synchronous
ambient-provenance window — see the note on `uploadBytes`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `ref` | [`StorageReference`](#storagereference) |
| `patch` | [`SettableMetadata`](#settablemetadata) |
| `provenance?` | `EventProvenance` |

#### Returns

`Promise`\<[`FullMetadata`](#fullmetadata)\>

***

<a id="uploadbytes"></a>

### uploadBytes()

```ts
function uploadBytes(
   ref: StorageReference,
   data: Blob | ArrayBuffer | Uint8Array<ArrayBufferLike>,
   metadata?: SettableMetadata,
provenance?: EventProvenance): Promise<UploadResult>;
```

Upload bytes to the reference's `fullPath`. Replaces any existing
object at the path. Returns the populated `FullMetadata` and the
same `ref` for chaining.

Throws when the reference targets the root (`fullPath === ''`) —
uploads need a non-empty path, matching Firebase's
`invalid-root-operation` precondition.

Provenance is captured from the reference's operation-scoped Storage
handle before the first await. The optional `provenance` argument remains
as a compatibility override for internal callers. Either way, concurrent
uploads cannot exchange source or auth-lens identity, and
`service: 'storage'` always wins.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `ref` | [`StorageReference`](#storagereference) |
| `data` | `Blob` \| `ArrayBuffer` \| `Uint8Array`\<`ArrayBufferLike`\> |
| `metadata?` | [`SettableMetadata`](#settablemetadata) |
| `provenance?` | `EventProvenance` |

#### Returns

`Promise`\<[`UploadResult`](#uploadresult)\>

***

<a id="uploadstring"></a>

### uploadString()

```ts
function uploadString(
   ref: StorageReference,
   value: string,
   format?: StringFormat,
   metadata?: SettableMetadata,
provenance?: EventProvenance): Promise<UploadResult>;
```

Upload a string in one of three formats:

  - `raw` (default): UTF-8 text. Defaults `contentType` to
    `text/plain;charset=utf-8` if neither metadata nor the data
    specify one.
  - `base64`: standard base64-encoded bytes.
  - `data_url`: a `data:` URL — the MIME prefix is honored as
    `contentType` unless the caller overrides it explicitly.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `ref` | [`StorageReference`](#storagereference) |
| `value` | `string` |
| `format?` | [`StringFormat`](#stringformat) |
| `metadata?` | [`SettableMetadata`](#settablemetadata) |
| `provenance?` | `EventProvenance` |

#### Returns

`Promise`\<[`UploadResult`](#uploadresult)\>
