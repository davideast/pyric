---
title: "API reference: @pyric/ui/storage/hooks"
navLabel: "@pyric/ui/storage/hooks"
group: "API reference"
section: "@pyric/ui"
order: 9046
description: "Published declarations for @pyric/ui/storage/hooks."
kind: "api"
apiPackage: "@pyric/ui"
apiImportPath: "@pyric/ui/storage/hooks"
apiSubpath: "storage/hooks"
apiSymbolCount: 43
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Interfaces

<a id="custommetadataentry"></a>

### CustomMetadataEntry

One `customMetadata` row. `id` is a stable render key — keys are
 user-editable, so they can't key the rows themselves.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="error"></a> `error?` | `string` | Validation error (`'Key is required'` / `'Duplicate key'`). |
| <a id="id"></a> `id` | `string` | - |
| <a id="key"></a> `key` | `string` | - |
| <a id="value"></a> `value` | `string` | - |

***

<a id="metadataeditorstate"></a>

### MetadataEditorState

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="draft"></a> `draft` | `MetadataDraft` | - |
| <a id="errorcount"></a> `errorCount` | `number` | - |
| <a id="initial"></a> `initial` | `MetadataDraft` | Snapshot for `isDirty` / `reset` — same reference-compare semantics as the document editor's `tree !== initial`. |

***

<a id="storagedeletefailure"></a>

### StorageDeleteFailure

One entry's failure in a bulk run. `error` is the typed
 `StorageError` (`.code` e.g. `storage/unauthorized`).

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="error-1"></a> `error` | `Error` |
| <a id="fullpath"></a> `fullPath` | `string` |

***

<a id="storagedeleteoutcome"></a>

### StorageDeleteOutcome

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="deleted"></a> `deleted` | `string`[] | fullPaths of entries fully deleted. |
| <a id="failed"></a> `failed` | [`StorageDeleteFailure`](#storagedeletefailure)[] | - |

***

<a id="storagedeleteprogress"></a>

### StorageDeleteProgress

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="deletedcount"></a> `deletedCount` | `number` | Objects deleted so far in this folder walk. |
| <a id="done"></a> `done` | `boolean` | True for the final emission. |

***

<a id="storagegateverdict"></a>

### StorageGateVerdict

Per-path verdict. `pyric/storage`'s rules subset has exactly two
verbs (`read` | `write` — the granular get/list/create/update/
delete forms are a parser follow-up), so `delete` and `upload` are
DERIVED aliases of `write`: Firebase Storage's `write` permission
governs create, overwrite, AND delete.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="delete"></a> `delete` | `boolean` | Derived — always `=== write` under the two-verb subset. |
| <a id="read"></a> `read` | `boolean` | - |
| <a id="reasons"></a> `reasons` | \{ `read`: `string`[]; `write`: `string`[]; \} | Evaluator reason traces for DENIED verbs (`"no rule matches…"` / `"match /… : condition false"`); empty arrays when allowed. Feed into disabled-state tooltips and `data-*-reason` attributes. |
| `reasons.read` | `string`[] | - |
| `reasons.write` | `string`[] | - |
| <a id="upload"></a> `upload` | `boolean` | Derived — always `=== write` under the two-verb subset. |
| <a id="write"></a> `write` | `boolean` | - |

***

<a id="storagelistentry"></a>

### StorageListEntry

One row of the merged folder/object model, the prefix→folder
synthesis ported (as an idea, not code) from the emulator UI's
`useStorageFiles`: `listAll`'s `prefixes` become `kind: 'folder'`
rows, its `items` become `kind: 'object'` rows, folders first.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="fullpath-1"></a> `fullPath` | `string` | Bucket-rooted path (no trailing slash, even for folders). |
| <a id="kind"></a> `kind` | `"object"` \| `"folder"` | - |
| <a id="name"></a> `name` | `string` | Last path segment, display name. |
| <a id="ref"></a> `ref` | `StorageReference` | - |

***

<a id="storagerecursivedeleteimpl"></a>

### StorageRecursiveDeleteImpl

Recursive folder delete implementation — the same injection seam
as the Firestore half's `RecursiveDeleteImpl`. Unlike Firestore
(where tree-walking needs sandbox introspection or a Cloud
Function), the public storage surface CAN walk a prefix, so the
package ships [createListAllDeleteImpl](#createlistalldeleteimpl) as the default;
inject your own for server-driven deletes.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="start"></a> `start` | (`target`: `StorageReference`) => `AsyncIterableIterator`\<[`StorageDeleteProgress`](#storagedeleteprogress)\> |

***

<a id="storageselectionentry"></a>

### StorageSelectionEntry

What the selection tracks per row — a structural subset of
`StorageListEntry`, so `useStorageList`'s entries pass straight
in. The `kind` decides the delete verb later (object →
`deleteObject`, folder → recursive).

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="fullpath-2"></a> `fullPath` | `string` |
| <a id="kind-1"></a> `kind` | `"object"` \| `"folder"` |

***

<a id="uploadentry"></a>

### UploadEntry

Explicit-path upload input. `path` is relative to the hook's
 `path` option (the destination folder).

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="data"></a> `data` | `Blob` \| `ArrayBuffer` \| `Uint8Array`\<`ArrayBufferLike`\> |
| <a id="metadata"></a> `metadata?` | `SettableMetadata` |
| <a id="path"></a> `path` | `string` |

***

<a id="uploadtask"></a>

### UploadTask

One file's upload, TASK-SHAPED for resumable forward-compat: the
byte counters and the `onProgress` callback are in the type NOW so
a future `uploadBytesResumable`-backed implementation emits real
intermediate snapshots without a breaking change. Today
(`pyric/storage` has no resumable uploads — COMPAT) a task
completes in one tick: `onProgress` fires once at 0 bytes and once
at `totalBytes`.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="bytestransferred"></a> `bytesTransferred` | `number` | - |
| <a id="error-2"></a> `error?` | `Error` | Populated on `'error'` — a typed `StorageError` from the sandbox (`.code` is `storage/<code>`, e.g. `storage/unauthorized` for a rules-denied write). |
| <a id="fullpath-3"></a> `fullPath` | `string` | Bucket-rooted destination path. |
| <a id="id-1"></a> `id` | `string` | Stable id — key task rows on this, not on `fullPath` (two uploads can target the same path). |
| <a id="metadata-1"></a> `metadata?` | `FullMetadata` | Populated on `'success'`. |
| <a id="status"></a> `status` | [`UploadTaskStatus`](#uploadtaskstatus-1) | - |
| <a id="totalbytes"></a> `totalBytes` | `number` | - |

***

<a id="usemetadataeditoroptions"></a>

### UseMetadataEditorOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="initial-1"></a> `initial?` | `SettableMetadata` | The metadata being edited — the same shape `useStorageObject`'s `metadata` carries. Read once on mount (the editor is a stateful workspace, like the document editor); `reset()` + remount to re-initialize. |

***

<a id="usemetadataeditorresult"></a>

### UseMetadataEditorResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="addcustomentry"></a> `addCustomEntry` | (`key?`: `string`, `value?`: `string`) => `void` | - |
| <a id="cachecontrol"></a> `cacheControl` | `string` | - |
| <a id="contenttype"></a> `contentType` | `string` | - |
| <a id="custom"></a> `custom` | [`CustomMetadataEntry`](#custommetadataentry)[] | - |
| <a id="dispatch"></a> `dispatch` | (`action`: [`MetadataEditorAction`](#metadataeditoraction)) => `void` | Raw dispatch — prefer the named helpers. |
| <a id="errorcount-1"></a> `errorCount` | `number` | - |
| <a id="isdirty"></a> `isDirty` | `boolean` | `true` once any modifying action fired since the last `reset`/successful `save`. Reference-compare semantics — manual re-entry of the original values does NOT clear it. |
| <a id="issaving"></a> `isSaving` | `boolean` | - |
| <a id="isvalid"></a> `isValid` | `boolean` | Convenience: `errorCount === 0`. |
| <a id="removecustomentry"></a> `removeCustomEntry` | (`id`: `string`) => `void` | - |
| <a id="reset"></a> `reset` | () => `void` | Restore the initial values. Clears `isDirty`. |
| <a id="save"></a> `save` | () => `Promise`\<`any`\> | `updateMetadata(ref(storage, path), toPatch())`. Errors surface via `saveError` (typed `StorageError`), not throws — resolves `undefined` on failure or when the draft is invalid. On success the draft becomes the new baseline (`isDirty` clears) and the fresh `FullMetadata` is returned. |
| <a id="saveerror"></a> `saveError` | `Error` | - |
| <a id="setcachecontrol"></a> `setCacheControl` | (`value`: `string`) => `void` | - |
| <a id="setcontenttype"></a> `setContentType` | (`value`: `string`) => `void` | - |
| <a id="setcustomkey"></a> `setCustomKey` | (`id`: `string`, `key`: `string`) => `void` | - |
| <a id="setcustomvalue"></a> `setCustomValue` | (`id`: `string`, `value`: `string`) => `void` | - |
| <a id="topatch"></a> `toPatch` | () => `SettableMetadata` | Serialize the draft to an `updateMetadata` patch. Empty `contentType`/`cacheControl` become `undefined` — which LEAVES the previous value (the sandbox doesn't model null-clears; see `pyric/storage`'s `updateMetadata` doc). `customMetadata` is always included and replaces wholesale, so row removal works. |

***

<a id="useobjectuploadoptions"></a>

### UseObjectUploadOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="list"></a> `list?` | `Pick`\<[`UseStorageListResult`](#usestoragelistresult), `"insertItem"` \| `"removeItem"`\> | Optimistic seam from `useStorageList`: each upload inserts its path immediately and rolls back via `removeItem` on failure. Caveat: rolling back an upload that was OVERWRITING an existing object drops that object's row locally (the seam can't tell an optimistic row from a listed one) — `refresh()` restores server truth. |
| <a id="oncomplete"></a> `onComplete?` | (`task`: [`UploadTask`](#uploadtask)) => `void` | Fired once per task reaching `'success'`. |
| <a id="onerror"></a> `onError?` | (`task`: [`UploadTask`](#uploadtask)) => `void` | Fired once per task reaching `'error'`. |
| <a id="onprogress"></a> `onProgress?` | (`task`: [`UploadTask`](#uploadtask)) => `void` | Task-shaped progress callback (see [UploadTask](#uploadtask)). |
| <a id="path-1"></a> `path?` | `string` | Destination folder, bucket-rooted. Default `''` (root). Wire to `usePathState().path` so uploads land in the browsed folder. |

***

<a id="useobjectuploadresult"></a>

### UseObjectUploadResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="clearcompleted"></a> `clearCompleted` | () => `void` | Drop settled (`success`/`error`) tasks from `tasks`. |
| <a id="createfolder"></a> `createFolder` | (`name`: `string`) => `Promise`\<`void`\> | Create an empty folder under the hook's `path`: writes the GCS placeholder convention — a zero-byte object named `<path>/` (trailing slash). `listAll` hides the placeholder from `items` at every level (it only surfaces as a prefix), so the folder appears in the browser with no phantom file inside. `ref()` normalizes the trailing slash away, so the placeholder is written through a structural value-object reference the sandbox accepts. Throws the underlying error after rolling back the optimistic prefix insert. ALTERNATIVE: when the store must stay free of placeholder objects (Pyric Studio's choice), use the client-side pending-prefix mechanism instead — see `pendingPrefixes.ts` for the reducer and the recorded tradeoff. |
| <a id="isuploading"></a> `isUploading` | `boolean` | `true` while any task is `'running'`. |
| <a id="tasks"></a> `tasks` | [`UploadTask`](#uploadtask)[] | Every task started by this hook instance, oldest first. |
| <a id="upload-1"></a> `upload` | (`input`: [`UploadInput`](#uploadinput) \| [`UploadInput`](#uploadinput)[]) => `Promise`\<[`UploadTask`](#uploadtask)[]\> | Upload one or many files. Tasks run concurrently; the promise resolves with the settled tasks once ALL finish and never rejects — per-file failures land on `task.error` (and `onError`), so one bad file doesn't mask the others. |

***

<a id="usepathstateoptions"></a>

### UsePathStateOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="defaultpath"></a> `defaultPath?` | `string` | Uncontrolled initial value. Default `''` (bucket root). |
| <a id="onpathchange"></a> `onPathChange?` | (`path`: `string`) => `void` | Fired with the normalized next path on every navigation. Called in both modes. |
| <a id="path-2"></a> `path?` | `string` | Controlled value. When provided, the hook derives everything from it and navigation calls only fire `onPathChange` — the owner owns the state (e.g. a router binding `?path=`). |

***

<a id="usepathstateresult"></a>

### UsePathStateResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="enter"></a> `enter` | (`nameOrPath`: `string`) => `void` | Descend into a child folder — accepts a bare name (`'sub'`) or an absolute path (`'docs/sub'`, e.g. a prefix's `fullPath`). |
| <a id="navigatetoindex"></a> `navigateToIndex` | (`index`: `number`) => `void` | Jump to the ancestor ending at `segments[index]` — the breadcrumb click. `navigateToIndex(-1)` (or any negative) is the root. |
| <a id="path-3"></a> `path` | `string` | Current normalized path. `''` is the bucket root. |
| <a id="segments"></a> `segments` | `string`[] | Path split into segments. `[]` at root. |
| <a id="setpath"></a> `setPath` | (`path`: `string`) => `void` | Jump to an absolute path (normalized). |
| <a id="up"></a> `up` | () => `void` | Ascend one level. No-op at root. |

***

<a id="usestoragedeleteoptions"></a>

### UseStorageDeleteOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="impl"></a> `impl?` | [`StorageRecursiveDeleteImpl`](#storagerecursivedeleteimpl) | Folder-walk implementation. Default [createListAllDeleteImpl](#createlistalldeleteimpl). |
| <a id="list-1"></a> `list?` | `Pick`\<[`UseStorageListResult`](#usestoragelistresult), `"insertItem"` \| `"removeItem"`\> | Optimistic seam from `useStorageList`: entries vanish from the local list immediately and roll back (object → item, folder → trailing-slash prefix insert) on failure. |

***

<a id="usestoragedeleteresult"></a>

### UseStorageDeleteResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="deleteentries"></a> `deleteEntries` | (`entries`: [`StorageSelectionEntry`](#storageselectionentry)[]) => `Promise`\<[`StorageDeleteOutcome`](#storagedeleteoutcome)\> | Delete a mixed object/folder selection (objects via `deleteObject`, folders via the recursive impl), sequentially in selection order. Resolves with the outcome and never rejects — per-entry failures land in `outcome.failed` (and `error` keeps the first one for simple renders). |
| <a id="error-3"></a> `error` | `Error` | First failure of the current/last run. Cleared on the next call. |
| <a id="isrunning"></a> `isRunning` | `boolean` | - |
| <a id="progress"></a> `progress` | `number` | Objects deleted in the current/last run (folder walks included). |

***

<a id="usestoragelistresult"></a>

### UseStorageListResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="entries"></a> `entries` | [`StorageListEntry`](#storagelistentry)[] | Folders-first merged row model. Derived from `prefixes` + `items`. |
| <a id="error-4"></a> `error` | `Error` | `StorageError` (with a typed `storage/<code>` on `.code`) from the sandbox. A denied list is `error.code === 'storage/unauthorized'` (ST-B2). |
| <a id="insertitem"></a> `insertItem` | (`fullPath`: `string`) => `void` | Optimistic seam (consumed by M3 upload / M6 bulk ops, exposed now so those hooks layer on without reshaping this one). Inserts `fullPath` into the local list immediately, applying the same prefix→folder synthesis `listAll` would: a direct child becomes an item, a deeper descendant surfaces as its first-segment folder. A trailing slash declares a folder (the GCS placeholder convention `useObjectUpload.createFolder` writes): a direct trailing-slash child inserts a prefix, not an item. No-op for paths outside the listed path, duplicates, or when `status` is `'idle'`. What each call ACTUALLY inserted is recorded (keyed by the given `fullPath`) so `removeItem` can reverse it precisely. Rollback = `removeItem` or `refresh`. |
| <a id="items"></a> `items` | `StorageReference`[] | Direct child objects under `path`. Sorted by `fullPath`. |
| <a id="prefixes"></a> `prefixes` | `StorageReference`[] | Synthetic folder prefixes under `path`. Sorted by `fullPath`. |
| <a id="refresh"></a> `refresh` | () => `void` | Re-run `listAll` for the current path. |
| <a id="removeitem"></a> `removeItem` | (`fullPath`: `string`) => `void` | Optimistic counterpart. When `fullPath` was previously given to `insertItem`, this reverses EXACTLY what that call inserted: a deep upload that synthesized a first-segment folder row removes that folder row, and an insert that was a no-op (the row already existed — e.g. a real, listed folder) removes NOTHING, so a failed upload can never delete server-truth rows. For paths never seen by `insertItem` it removes the matching item/folder row directly (the optimistic-delete use). Rollback = `refresh`. |
| <a id="status-1"></a> `status` | [`StorageListStatus`](#storageliststatus) | `'idle'` only when `storage` is null/undefined. |

***

<a id="usestorageobjectresult"></a>

### UseStorageObjectResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="blob"></a> `blob` | `Blob` | - |
| <a id="bloberror"></a> `blobError` | `Error` | - |
| <a id="blobstatus"></a> `blobStatus` | [`StorageObjectStatus`](#storageobjectstatus) | Blob read state. Stays `'idle'` until `loadBlob()`, the blob is LAZY; metadata alone never downloads bytes. |
| <a id="bloburl"></a> `blobUrl` | `string` | `URL.createObjectURL` handle for the loaded blob, used as the local preview channel. Revoked automatically when the blob is replaced, the path changes, or the hook unmounts. |
| <a id="error-5"></a> `error` | `Error` | Typed `StorageError` (`storage/object-not-found`, `storage/unauthorized`, …). |
| <a id="loadblob"></a> `loadBlob` | () => `void` | Fetch the bytes via `getBlob`. Subsequent calls re-fetch. |
| <a id="metadata-2"></a> `metadata` | `any` | - |
| <a id="refresh-1"></a> `refresh` | () => `void` | Re-read the metadata (also resets the blob, the object may have been overwritten). |
| <a id="status-2"></a> `status` | [`StorageObjectStatus`](#storageobjectstatus) | Metadata read state. `'idle'` when `storage` or `path` is null. |

***

<a id="usestoragerulesgateoptions"></a>

### UseStorageRulesGateOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="identity"></a> `identity?` | `any` | Identity override. `null` is anonymous; OMIT the field to use the handle's own identity (the sandbox context's `auth`). |
| <a id="paths"></a> `paths?` | `string` \| readonly `string`[] | Path (or paths) to pre-evaluate into `verdicts`, keyed by the normalized path. Ad-hoc paths (e.g. browser rows) go through `verdictFor` instead — the two are the same evaluation. |
| <a id="rules"></a> `rules?` | `any` | Explicit rules source — raw rules text (parsed here; a malformed string surfaces as `status: 'error'`) or a pre-parsed `StorageRules` handle. Overrides the sandbox's deployed ruleset when both exist. |
| <a id="writeresource"></a> `writeResource?` | \{ `contentType?`: `string`; `size`: `number`; \} | The about-to-write payload bound to `request.resource` for the WRITE evaluation — pass `{ size, contentType }` when gating a specific upload so size/contentType-conditioned rules evaluate truthfully. When omitted, `request.resource` is unset, which is exactly DELETE semantics (deletes carry no inbound payload) — a rule like `request.resource.size < N` then denies, the conservative answer for uploads. |
| `writeResource.contentType?` | `string` | - |
| `writeResource.size` | `number` | - |

***

<a id="usestoragerulesgateresult"></a>

### UseStorageRulesGateResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="advisory"></a> `advisory` | `boolean` | Always false: `pyric/storage` handles are sandbox mirrors. |
| <a id="error-6"></a> `error` | `Error` | Rules-resolution failure (e.g. a malformed `rules` string). |
| <a id="identity-1"></a> `identity` | `any` | The identity the verdicts evaluate under. |
| <a id="source"></a> `source` | [`StorageRulesSource`](#storagerulessource) | Where the active ruleset came from. |
| <a id="status-3"></a> `status` | [`StorageRulesGateStatus`](#storagerulesgatestatus) | `'idle'` only when `storage` is null/undefined. |
| <a id="verdictfor"></a> `verdictFor` | (`path`: `string`) => [`StorageGateVerdict`](#storagegateverdict) | Evaluate an arbitrary path under the current ruleset + identity. Pure and synchronous once `status` is `'ready'`; before that (and whenever no rules are reachable) it returns the allow-all verdict — the gate FAILS OPEN, because affordances are advisory and the real enforcement (sandbox throw / server denial) stays authoritative. |
| <a id="verdicts"></a> `verdicts` | `Record`\<`string`, [`StorageGateVerdict`](#storagegateverdict)\> | Pre-evaluated verdicts for `options.paths`, keyed by normalized path. |

***

<a id="usestorageselectionresult"></a>

### UseStorageSelectionResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="clear"></a> `clear` | () => `void` | - |
| <a id="deselect"></a> `deselect` | (`fullPath`: `string`) => `void` | - |
| <a id="isselected"></a> `isSelected` | (`fullPath`: `string`) => `boolean` | - |
| <a id="select"></a> `select` | (`entry`: [`StorageSelectionEntry`](#storageselectionentry)) => `void` | - |
| <a id="selectall"></a> `selectAll` | (`entries`: [`StorageSelectionEntry`](#storageselectionentry)[]) => `void` | Replace the selection (e.g. a "select all" over `list.entries`). |
| <a id="selected"></a> `selected` | [`StorageSelectionEntry`](#storageselectionentry)[] | Selected entries in selection order. |
| <a id="size"></a> `size` | `number` | - |
| <a id="toggle"></a> `toggle` | (`entry`: [`StorageSelectionEntry`](#storageselectionentry)) => `void` | Add/remove — the checkbox verb. |

## Type Aliases

<a id="metadataeditoraction"></a>

### MetadataEditorAction

```ts
type MetadataEditorAction =
  | {
  type: "setContentType";
  value: string;
}
  | {
  type: "setCacheControl";
  value: string;
}
  | {
  id: string;
  key: string;
  type: "setCustomKey";
}
  | {
  id: string;
  type: "setCustomValue";
  value: string;
}
  | {
  key?: string;
  type: "addCustomEntry";
  value?: string;
}
  | {
  id: string;
  type: "removeCustomEntry";
}
  | {
  type: "reset";
}
  | {
  type: "commit";
};
```

#### Type Declaration

```ts
{
  type: "setContentType";
  value: string;
}
```

##### type

```ts
type: "setContentType";
```

##### value

```ts
value: string;
```

```ts
{
  type: "setCacheControl";
  value: string;
}
```

##### type

```ts
type: "setCacheControl";
```

##### value

```ts
value: string;
```

```ts
{
  id: string;
  key: string;
  type: "setCustomKey";
}
```

##### id

```ts
id: string;
```

##### key

```ts
key: string;
```

##### type

```ts
type: "setCustomKey";
```

```ts
{
  id: string;
  type: "setCustomValue";
  value: string;
}
```

##### id

```ts
id: string;
```

##### type

```ts
type: "setCustomValue";
```

##### value

```ts
value: string;
```

```ts
{
  key?: string;
  type: "addCustomEntry";
  value?: string;
}
```

##### key?

```ts
optional key: string;
```

##### type

```ts
type: "addCustomEntry";
```

##### value?

```ts
optional value: string;
```

```ts
{
  id: string;
  type: "removeCustomEntry";
}
```

##### id

```ts
id: string;
```

##### type

```ts
type: "removeCustomEntry";
```

```ts
{
  type: "reset";
}
```

##### type

```ts
type: "reset";
```

```ts
{
  type: "commit";
}
```

##### type

```ts
type: "commit";
```

Internal — a successful save makes the draft the new baseline.

***

<a id="storageliststatus"></a>

### StorageListStatus

```ts
type StorageListStatus = "idle" | "loading" | "success" | "error";
```

***

<a id="storageobjectstatus"></a>

### StorageObjectStatus

```ts
type StorageObjectStatus = "idle" | "loading" | "success" | "error";
```

***

<a id="storagerulesgatestatus"></a>

### StorageRulesGateStatus

```ts
type StorageRulesGateStatus = "idle" | "loading" | "ready" | "error";
```

***

<a id="storagerulessource"></a>

### StorageRulesSource

```ts
type StorageRulesSource = "option" | "sandbox" | "none";
```

Where the active ruleset came from:
- `'option'` — the explicit `rules` option (string or pre-parsed).
- `'sandbox'` — the ruleset deployed on the sandbox handle
  (`getStorageSandbox(ctx, { rules })`), read off the handle's
  `StorageService`.
- `'none'` — no rules reachable. Every verdict allows
  (open-by-default, the same semantics `pyric/storage`'s
  enforcement layer applies when no rules are configured).

***

<a id="uploadinput"></a>

### UploadInput

```ts
type UploadInput = File | UploadEntry;
```

`upload()` accepts plain `File`s (destination = the file's
`webkitRelativePath` when present — folder drops keep their
structure — else its `name`) or explicit [UploadEntry](#uploadentry)s.

***

<a id="uploadtaskstatus-1"></a>

### UploadTaskStatus

```ts
type UploadTaskStatus = "running" | "success" | "error";
```

## Functions

<a id="createlistalldeleteimpl"></a>

### createListAllDeleteImpl()

```ts
function createListAllDeleteImpl(api?: Pick<StorageApi, "listAll" | "deleteObject">): StorageRecursiveDeleteImpl;
```

The default, `listAll`-driven impl: walks the prefix tree,
`deleteObject`s every item (yielding progress per object), then
sweeps each visited folder's `<path>/` placeholder so emptied
create-folder folders disappear too (`listAll` hides placeholders,
so the walk alone would leave ghost folders). Placeholder sweeps
are best-effort — `deletedCount` counts listed objects only.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `api?` | `Pick`\<`StorageApi`, `"listAll"` \| `"deleteObject"`\> |

#### Returns

[`StorageRecursiveDeleteImpl`](#storagerecursivedeleteimpl)

***

<a id="initmetadataeditorstate"></a>

### initMetadataEditorState()

```ts
function initMetadataEditorState(initial: any): MetadataEditorState;
```

Build the edit state from the metadata a `getMetadata` /
 `useStorageObject` read returned.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `initial` | `any` |

#### Returns

[`MetadataEditorState`](#metadataeditorstate)

***

<a id="metadataeditorreducer"></a>

### metadataEditorReducer()

```ts
function metadataEditorReducer(state: MetadataEditorState, action: MetadataEditorAction): MetadataEditorState;
```

Pure reducer — exported (with [initMetadataEditorState](#initmetadataeditorstate)) so
 the edit state is testable without React, mirroring the document
 editor's reducer/hook split.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `state` | [`MetadataEditorState`](#metadataeditorstate) |
| `action` | [`MetadataEditorAction`](#metadataeditoraction) |

#### Returns

[`MetadataEditorState`](#metadataeditorstate)

***

<a id="normalizestoragepath"></a>

### normalizeStoragePath()

```ts
function normalizeStoragePath(path: string): string;
```

Strip leading/trailing slashes and collapse repeats — mirrors
 `pyric/storage`'s reference normalization so `usePathState` and
 `useStorageList` always agree on what a path is.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

#### Returns

`string`

***

<a id="usemetadataeditor"></a>

### useMetadataEditor()

```ts
function useMetadataEditor(
   storage: any,
   path: string,
   options?: UseMetadataEditorOptions): UseMetadataEditorResult;
```

Headless metadata editor — the `useDocumentEditor` reducer pattern
over `updateMetadata`: a pure reducer owns the draft (contentType,
cacheControl, customMetadata k/v rows with stable ids +
empty/duplicate-key validation); the hook adds named dispatch
helpers and the save half.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `storage` | `any` |
| `path` | `string` |
| `options?` | [`UseMetadataEditorOptions`](#usemetadataeditoroptions) |

#### Returns

[`UseMetadataEditorResult`](#usemetadataeditorresult)

***

<a id="useobjectupload"></a>

### useObjectUpload()

```ts
function useObjectUpload(storage: any, options?: UseObjectUploadOptions): UseObjectUploadResult;
```

Multi-file upload over the package's single Storage handle prop.
Headless: returns task state; render it however you like (the
`<UploadDropzone>` component is one producer of `upload()` calls).

Optimistic-with-rollback: with the `list` seam wired, each upload's
row appears in `useStorageList` immediately and disappears again if
the write fails (typed `StorageError` on `task.error`).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `storage` | `any` |
| `options?` | [`UseObjectUploadOptions`](#useobjectuploadoptions) |

#### Returns

[`UseObjectUploadResult`](#useobjectuploadresult)

***

<a id="usepathstate"></a>

### usePathState()

```ts
function usePathState(options?: UsePathStateOptions): UsePathStateResult;
```

Path navigation state for the storage browser. Controlled when
`path` is provided (the owner re-renders with the next value),
uncontrolled otherwise — standard React value/defaultValue
semantics. All emitted paths are normalized (`normalizeStoragePath`).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `options?` | [`UsePathStateOptions`](#usepathstateoptions) |

#### Returns

[`UsePathStateResult`](#usepathstateresult)

***

<a id="usestoragedelete"></a>

### useStorageDelete()

```ts
function useStorageDelete(storage: any, options?: UseStorageDeleteOptions): UseStorageDeleteResult;
```

Drive bulk + recursive deletes from a React component — the
storage counterpart of `useRecursiveDelete` (same progress /
isRunning / error shape, same stale-run generation token), bulk
because storage selections are flat multi-row affairs.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `storage` | `any` |
| `options?` | [`UseStorageDeleteOptions`](#usestoragedeleteoptions) |

#### Returns

[`UseStorageDeleteResult`](#usestoragedeleteresult)

***

<a id="usestoragelist"></a>

### useStorageList()

```ts
function useStorageList(storage: any, path: string): UseStorageListResult;
```

List the objects + synthetic folders directly under `path` :
`listAll` over the package's sandbox Storage handle. Read-via-get,
not realtime: the list updates on `refresh`, path change, or the
optimistic seam. Pass `''` (or the result of `usePathState`) for
the bucket root.

`listAll` has no pagination; a very large prefix arrives as one flat
result (virtualize the rendering, which `<ObjectBrowser>` does).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `storage` | `any` |
| `path` | `string` |

#### Returns

[`UseStorageListResult`](#usestoragelistresult)

***

<a id="usestorageobject"></a>

### useStorageObject()

```ts
function useStorageObject(storage: any, path: string): UseStorageObjectResult;
```

One object's metadata + lazily-loaded bytes, the data source for
`<ObjectInspector>`. Read-via-get like the rest of the storage
half: updates on `refresh`, `path` change, or `loadBlob`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `storage` | `any` |
| `path` | `string` |

#### Returns

[`UseStorageObjectResult`](#usestorageobjectresult)

***

<a id="usestoragerulesgate"></a>

### useStorageRulesGate()

```ts
function useStorageRulesGate(storage: any, options?: UseStorageRulesGateOptions): UseStorageRulesGateResult;
```

Pre-flight rules evaluation — the M7 differentiator. Evaluates the
current identity against paths BEFORE the click, so components can
annotate denied affordances (`data-pyric-denied`, disabled-with-
reason) instead of letting the user discover a denial via a thrown
`storage/unauthorized`.

Rules discovery: a sandbox handle carries its deployed ruleset
(`getStorageSandbox(ctx, { rules })` parses it into the handle's
`StorageService`) — the hook reads it through the handle's target,
so sandbox callers pass nothing. Identity likewise defaults to the
handle's `SandboxContext.auth`. An explicit `rules` or `identity`
option overrides the handle when evaluating a what-if scenario.

Evaluation contract (mirrors `pyric/storage`'s own enforcement):
`resource` (the existing object) is bound as `null` — the gate
pre-evaluates without fetching per-path metadata, matching how the
sandbox enforces `listAll`. Rules conditioned on existing-object
state (`resource.*`) evaluate as if the object doesn't exist; the
common identity/path/payload-shaped rules evaluate exactly.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `storage` | `any` |
| `options?` | [`UseStorageRulesGateOptions`](#usestoragerulesgateoptions) |

#### Returns

[`UseStorageRulesGateResult`](#usestoragerulesgateresult)

***

<a id="usestorageselection"></a>

### useStorageSelection()

```ts
function useStorageSelection(): UseStorageSelectionResult;
```

Multi-select state over storage rows, keyed by `fullPath`.
Deliberately dumb: it doesn't watch the list, so clear it on path
change (or after a bulk op via the delete hook's outcome) — the
consumer owns that policy.

#### Returns

[`UseStorageSelectionResult`](#usestorageselectionresult)
