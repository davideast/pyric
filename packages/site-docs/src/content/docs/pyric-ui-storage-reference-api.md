---
title: "API reference: @pyric/ui/storage"
navLabel: "@pyric/ui/storage"
group: "API reference"
section: "@pyric/ui"
order: 24045
description: "Published declarations for @pyric/ui/storage."
kind: "api"
apiPackage: "@pyric/ui"
apiImportPath: "@pyric/ui/storage"
apiSubpath: "storage"
apiSymbolCount: 76
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

<a id="deleteselectionwithconfirmprops"></a>

### DeleteSelectionWithConfirmProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="body"></a> `body?` | `ReactNode` | Confirm-dialog body. Default lists the selected paths. |
| <a id="classname"></a> `className?` | `string` | Class forwarded to the default trigger button. |
| <a id="confirmlabel"></a> `confirmLabel?` | `string` | - |
| <a id="entries"></a> `entries` | [`StorageSelectionEntry`](#storageselectionentry)[] | What to delete — `useStorageSelection().selected` (or any `{kind, fullPath}` rows). Folders delete recursively. |
| <a id="gate"></a> `gate?` | `Pick`\<[`UseStorageRulesGateResult`](#usestoragerulesgateresult), `"verdictFor"`\> | Rules-aware affordance — pass `useStorageRulesGate(storage)`. When ANY selected entry's DELETE verdict denies, the trigger disables with the reason (default trigger: `data-pyric-denied` + `data-pyric-denied-reason` + `title`; `renderTrigger` receives `deniedReason`). For folder entries the verdict evaluates the folder path itself — an approximation of the recursive walk (descendants matched by `{allPaths=**}` rules share the verdict). |
| <a id="impl"></a> `impl?` | [`StorageRecursiveDeleteImpl`](#storagerecursivedeleteimpl) | Folder-walk impl override (default: the `listAll`-driven one). |
| <a id="list"></a> `list?` | `Pick`\<[`UseStorageListResult`](#usestoragelistresult), `"insertItem"` \| `"removeItem"`\> | Optimistic seam from `useStorageList`. |
| <a id="ondeleted"></a> `onDeleted?` | (`outcome`: [`StorageDeleteOutcome`](#storagedeleteoutcome)) => `void` | Fired after a run with NO failures (e.g. clear the selection + refresh the list). |
| <a id="onfailed"></a> `onFailed?` | (`outcome`: [`StorageDeleteOutcome`](#storagedeleteoutcome)) => `void` | Fired after a run with failures (the toast already showed). |
| <a id="rendertrigger"></a> `renderTrigger?` | (`props`: \{ `deniedReason?`: `string`; `disabled`: `boolean`; `isRunning`: `boolean`; `onClick`: () => `void`; `progress`: `number`; \}) => `ReactNode` | Render override for the trigger button. |
| <a id="storage"></a> `storage` | `any` | The package's single Storage handle prop. |
| <a id="title"></a> `title?` | `string` | Confirm-dialog title. Default derives from the entry count. |

***

<a id="droppedfile"></a>

### DroppedFile

One dropped file, flattened from the drop's file/folder tree.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="file"></a> `file` | `File` | - |
| <a id="relativepath"></a> `relativePath` | `string` | Path relative to the drop — `'a.txt'` for a plain file drop, `'photos/cat.png'` for a file inside a dropped folder. Feed straight into `useObjectUpload`: `upload(files.map((f) => ({ path: f.relativePath, data: f.file })))`. |

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

<a id="objectbrowserprops"></a>

### ObjectBrowserProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="classname-1"></a> `className?` | `string` | - |
| <a id="emptystate"></a> `emptyState?` | `ReactNode` | - |
| <a id="entries-1"></a> `entries` | [`StorageListEntry`](#storagelistentry)[] | The folders-first row model from `useStorageList`. |
| <a id="error-1"></a> `error?` | `Error` | Renders a `role="alert"` container with the message. Pair with the hook's typed `StorageError` for code-driven copy. |
| <a id="gate-1"></a> `gate?` | `Pick`\<[`UseStorageRulesGateResult`](#usestoragerulesgateresult), `"verdictFor"`\> | Rules-aware affordances — pass `useStorageRulesGate(storage)`. Rows whose READ verdict denies are stamped `data-pyric-denied` (with the evaluator's reason trace on `data-pyric-denied-reason`). A denied folder row would throw `storage/unauthorized` on `listAll`; the stamp warns BEFORE the click. Rows stay clickable — the affordance is advisory and the sandbox enforcement layer remains authoritative. |
| <a id="onnavigate"></a> `onNavigate?` | (`path`: `string`) => `void` | Folder row click — fired with the prefix's `fullPath`. Wire to `usePathState.enter` (or `setPath`). |
| <a id="onselect"></a> `onSelect?` | (`ref`: `StorageReference`) => `void` | Object row click — fired with the object's reference. |
| <a id="renderentry"></a> `renderEntry?` | (`entry`: [`StorageListEntry`](#storagelistentry)) => `ReactNode` | Row-label slot. Default renders the entry name. The row button, its click wiring, and the `data-*` states stay with the component — the slot only owns the label content. |
| <a id="renderrowaction"></a> `renderRowAction?` | (`entry`: [`StorageListEntry`](#storagelistentry)) => `ReactNode` | Optional per-row action rendered as a sibling of the navigation/select button. Use this for independent controls such as selection checkboxes. |
| <a id="rowheight"></a> `rowHeight?` | `number` \| (`index`: `number`) => `number` | Estimated row height when virtualizing. Default 36. |
| <a id="selectedpath"></a> `selectedPath?` | `string` | Marks the matching object row `data-pyric-selected` + `aria-selected`. |
| <a id="status"></a> `status?` | [`StorageListStatus`](#storageliststatus) | Drives the loading state (`'loading'` with no rows yet) and the idle short-circuit. Default `'success'` for static usage. |
| <a id="virtualizedheight"></a> `virtualizedHeight?` | `string` \| `number` | Scroll-container height when virtualized. Default `'60vh'`. |
| <a id="virtualizethreshold"></a> `virtualizeThreshold?` | `number` | Above this row count, the list switches to virtualization via `<VirtualList>` — `listAll` has no pagination, so a big prefix arrives as one flat result and virtualization is the only defense. Default 100 (same as `<DocumentList>`). `Infinity` disables. |

***

<a id="objectinspectorprops"></a>

### ObjectInspectorProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="children"></a> `children?` | `ReactNode` | Extra content below the preview (metadata editor, delete button, …). |
| <a id="classname-2"></a> `className?` | `string` | - |
| <a id="path"></a> `path` | `string` | Object path to inspect. `null` renders the idle shell — keep the inspector mounted and swap paths as the user selects rows. |
| <a id="previews"></a> `previews?` | [`StoragePreview`](#storagepreview)[] | Consumer previews, tried BEFORE the built-ins (first match wins) — the extension channel of the preview registry. |
| <a id="rendermetadata"></a> `renderMetadata?` | (`metadata`: `FullMetadata`) => `ReactNode` | Metadata-section slot. Default renders the standard field list. The header, preview, and state wiring stay with the component. |
| <a id="storage-1"></a> `storage` | `any` | The package's sandbox Storage handle. |

***

<a id="pathbreadcrumbprops"></a>

### PathBreadcrumbProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="classname-3"></a> `className?` | `string` | - |
| <a id="onnavigate-1"></a> `onNavigate?` | (`path`: `string`) => `void` | Fired with the absolute path of the clicked crumb (`''` for root). Wire to `usePathState.setPath`. |
| <a id="path-1"></a> `path` | `string` | Current path. `''` renders just the root crumb. |
| <a id="rootlabel"></a> `rootLabel?` | `ReactNode` | Label for the root crumb. Default `'/'` — pass the bucket name for a `gs://bucket` feel. |
| <a id="separator"></a> `separator?` | `ReactNode` | Rendered between crumbs. Default `'/'`. |

***

<a id="storagedeletefailure"></a>

### StorageDeleteFailure

One entry's failure in a bulk run. `error` is the typed
 `StorageError` (`.code` e.g. `storage/unauthorized`).

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="error-2"></a> `error` | `Error` |
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

<a id="storagepreview"></a>

### StoragePreview

One entry in the content-type preview registry — the storage
counterpart of the Firestore field-editor registry, keyed by a
`match` predicate instead of a type name because content types are
open-ended. First match wins; consumer previews run BEFORE the
built-ins, so overriding `image/*` is just shipping your own
matcher.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="id-1"></a> `id` | `string` | Diagnostic id — also stamped on the preview container as `data-pyric-preview="<id>"`. |
| <a id="match"></a> `match` | (`metadata`: `FullMetadata`) => `boolean` | - |
| <a id="maxbytes"></a> `maxBytes?` | `number` | Skip the preview (and the blob download) for objects larger than this — the inspector renders its `data-pyric-preview-too-large` fallback instead. `undefined` = no cap. |
| <a id="needsblob"></a> `needsBlob?` | `boolean` | Ask the inspector to `loadBlob()` before rendering. Default `false` (metadata-only previews render immediately). |
| <a id="render"></a> `render` | (`ctx`: [`StoragePreviewContext`](#storagepreviewcontext)) => `ReactNode` | - |

***

<a id="storagepreviewcontext"></a>

### StoragePreviewContext

What a preview's `render` receives. `blob`/`blobUrl` are only
 populated for previews that declared `needsBlob`.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="blob"></a> `blob` | `Blob` |
| <a id="bloburl"></a> `blobUrl` | `string` |
| <a id="metadata"></a> `metadata` | `FullMetadata` |

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

<a id="uploaddropzoneprops"></a>

### UploadDropzoneProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="children-1"></a> `children?` | `ReactNode` | Slot — the dropzone chrome ("Drop files here…", a browse `<input type="file">`, anything). The component owns only the drag wiring + `data-*` states. |
| <a id="classname-4"></a> `className?` | `string` | - |
| <a id="disabled"></a> `disabled?` | `boolean` | Ignore drops + suppress the dragging state. |
| <a id="disabledreason"></a> `disabledReason?` | `string` | Why the dropzone is disabled — stamped on `data-disabled-reason` (and only while `disabled`) so the chrome/styling can surface it. The canonical source is the rules gate: `disabled={!gate.verdictFor(path).upload}` + `disabledReason={gate.verdictFor(path).reasons.write.join('; ')}`. |
| <a id="onfiles"></a> `onFiles` | (`files`: [`DroppedFile`](#droppedfile)[]) => `void` | Fired once per drop with the flattened file list (folder drops are traversed recursively via `webkitGetAsEntry`; empty folders yield nothing — wire `useObjectUpload.createFolder` to your own "new folder" affordance instead). Not fired for empty drops. |

***

<a id="uploadentry"></a>

### UploadEntry

Explicit-path upload input. `path` is relative to the hook's
 `path` option (the destination folder).

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="data"></a> `data` | `Blob` \| `ArrayBuffer` \| `Uint8Array`\<`ArrayBufferLike`\> |
| <a id="metadata-1"></a> `metadata?` | `SettableMetadata` |
| <a id="path-2"></a> `path` | `string` |

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
| <a id="error-3"></a> `error?` | `Error` | Populated on `'error'` — a typed `StorageError` from the sandbox (`.code` is `storage/<code>`, e.g. `storage/unauthorized` for a rules-denied write). |
| <a id="fullpath-3"></a> `fullPath` | `string` | Bucket-rooted destination path. |
| <a id="id-2"></a> `id` | `string` | Stable id — key task rows on this, not on `fullPath` (two uploads can target the same path). |
| <a id="metadata-2"></a> `metadata?` | `FullMetadata` | Populated on `'success'`. |
| <a id="status-1"></a> `status` | [`UploadTaskStatus`](#uploadtaskstatus-1) | - |
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
| <a id="list-1"></a> `list?` | `Pick`\<[`UseStorageListResult`](#usestoragelistresult), `"insertItem"` \| `"removeItem"`\> | Optimistic seam from `useStorageList`: each upload inserts its path immediately and rolls back via `removeItem` on failure. Caveat: rolling back an upload that was OVERWRITING an existing object drops that object's row locally (the seam can't tell an optimistic row from a listed one) — `refresh()` restores server truth. |
| <a id="oncomplete"></a> `onComplete?` | (`task`: [`UploadTask`](#uploadtask)) => `void` | Fired once per task reaching `'success'`. |
| <a id="onerror"></a> `onError?` | (`task`: [`UploadTask`](#uploadtask)) => `void` | Fired once per task reaching `'error'`. |
| <a id="onprogress"></a> `onProgress?` | (`task`: [`UploadTask`](#uploadtask)) => `void` | Task-shaped progress callback (see [UploadTask](#uploadtask)). |
| <a id="path-3"></a> `path?` | `string` | Destination folder, bucket-rooted. Default `''` (root). Wire to `usePathState().path` so uploads land in the browsed folder. |

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
| <a id="path-4"></a> `path?` | `string` | Controlled value. When provided, the hook derives everything from it and navigation calls only fire `onPathChange` — the owner owns the state (e.g. a router binding `?path=`). |

***

<a id="usepathstateresult"></a>

### UsePathStateResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="enter"></a> `enter` | (`nameOrPath`: `string`) => `void` | Descend into a child folder — accepts a bare name (`'sub'`) or an absolute path (`'docs/sub'`, e.g. a prefix's `fullPath`). |
| <a id="navigatetoindex"></a> `navigateToIndex` | (`index`: `number`) => `void` | Jump to the ancestor ending at `segments[index]` — the breadcrumb click. `navigateToIndex(-1)` (or any negative) is the root. |
| <a id="path-5"></a> `path` | `string` | Current normalized path. `''` is the bucket root. |
| <a id="segments"></a> `segments` | `string`[] | Path split into segments. `[]` at root. |
| <a id="setpath"></a> `setPath` | (`path`: `string`) => `void` | Jump to an absolute path (normalized). |
| <a id="up"></a> `up` | () => `void` | Ascend one level. No-op at root. |

***

<a id="usestoragedeleteoptions"></a>

### UseStorageDeleteOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="impl-1"></a> `impl?` | [`StorageRecursiveDeleteImpl`](#storagerecursivedeleteimpl) | Folder-walk implementation. Default [createListAllDeleteImpl](#createlistalldeleteimpl). |
| <a id="list-2"></a> `list?` | `Pick`\<[`UseStorageListResult`](#usestoragelistresult), `"insertItem"` \| `"removeItem"`\> | Optimistic seam from `useStorageList`: entries vanish from the local list immediately and roll back (object → item, folder → trailing-slash prefix insert) on failure. |

***

<a id="usestoragedeleteresult"></a>

### UseStorageDeleteResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="deleteentries"></a> `deleteEntries` | (`entries`: [`StorageSelectionEntry`](#storageselectionentry)[]) => `Promise`\<[`StorageDeleteOutcome`](#storagedeleteoutcome)\> | Delete a mixed object/folder selection (objects via `deleteObject`, folders via the recursive impl), sequentially in selection order. Resolves with the outcome and never rejects — per-entry failures land in `outcome.failed` (and `error` keeps the first one for simple renders). |
| <a id="error-4"></a> `error` | `Error` | First failure of the current/last run. Cleared on the next call. |
| <a id="isrunning"></a> `isRunning` | `boolean` | - |
| <a id="progress"></a> `progress` | `number` | Objects deleted in the current/last run (folder walks included). |

***

<a id="usestoragelistresult"></a>

### UseStorageListResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="entries-2"></a> `entries` | [`StorageListEntry`](#storagelistentry)[] | Folders-first merged row model. Derived from `prefixes` + `items`. |
| <a id="error-5"></a> `error` | `Error` | `StorageError` (with a typed `storage/<code>` on `.code`) from the sandbox. A denied list is `error.code === 'storage/unauthorized'` (ST-B2). |
| <a id="insertitem"></a> `insertItem` | (`fullPath`: `string`) => `void` | Optimistic seam (consumed by M3 upload / M6 bulk ops, exposed now so those hooks layer on without reshaping this one). Inserts `fullPath` into the local list immediately, applying the same prefix→folder synthesis `listAll` would: a direct child becomes an item, a deeper descendant surfaces as its first-segment folder. A trailing slash declares a folder (the GCS placeholder convention `useObjectUpload.createFolder` writes): a direct trailing-slash child inserts a prefix, not an item. No-op for paths outside the listed path, duplicates, or when `status` is `'idle'`. What each call ACTUALLY inserted is recorded (keyed by the given `fullPath`) so `removeItem` can reverse it precisely. Rollback = `removeItem` or `refresh`. |
| <a id="items"></a> `items` | `StorageReference`[] | Direct child objects under `path`. Sorted by `fullPath`. |
| <a id="prefixes"></a> `prefixes` | `StorageReference`[] | Synthetic folder prefixes under `path`. Sorted by `fullPath`. |
| <a id="refresh"></a> `refresh` | () => `void` | Re-run `listAll` for the current path. |
| <a id="removeitem"></a> `removeItem` | (`fullPath`: `string`) => `void` | Optimistic counterpart. When `fullPath` was previously given to `insertItem`, this reverses EXACTLY what that call inserted: a deep upload that synthesized a first-segment folder row removes that folder row, and an insert that was a no-op (the row already existed — e.g. a real, listed folder) removes NOTHING, so a failed upload can never delete server-truth rows. For paths never seen by `insertItem` it removes the matching item/folder row directly (the optimistic-delete use). Rollback = `refresh`. |
| <a id="status-2"></a> `status` | [`StorageListStatus`](#storageliststatus) | `'idle'` only when `storage` is null/undefined. |

***

<a id="usestorageobjectresult"></a>

### UseStorageObjectResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="blob-1"></a> `blob` | `Blob` | - |
| <a id="bloberror"></a> `blobError` | `Error` | - |
| <a id="blobstatus"></a> `blobStatus` | [`StorageObjectStatus`](#storageobjectstatus) | Blob read state. Stays `'idle'` until `loadBlob()`, the blob is LAZY; metadata alone never downloads bytes. |
| <a id="bloburl-1"></a> `blobUrl` | `string` | `URL.createObjectURL` handle for the loaded blob, used as the local preview channel. Revoked automatically when the blob is replaced, the path changes, or the hook unmounts. |
| <a id="error-6"></a> `error` | `Error` | Typed `StorageError` (`storage/object-not-found`, `storage/unauthorized`, …). |
| <a id="loadblob"></a> `loadBlob` | () => `void` | Fetch the bytes via `getBlob`. Subsequent calls re-fetch. |
| <a id="metadata-3"></a> `metadata` | `any` | - |
| <a id="refresh-1"></a> `refresh` | () => `void` | Re-read the metadata (also resets the blob, the object may have been overwritten). |
| <a id="status-3"></a> `status` | [`StorageObjectStatus`](#storageobjectstatus) | Metadata read state. `'idle'` when `storage` or `path` is null. |

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
| <a id="error-7"></a> `error` | `Error` | Rules-resolution failure (e.g. a malformed `rules` string). |
| <a id="identity-1"></a> `identity` | `any` | The identity the verdicts evaluate under. |
| <a id="source"></a> `source` | [`StorageRulesSource`](#storagerulessource) | Where the active ruleset came from. |
| <a id="status-4"></a> `status` | [`StorageRulesGateStatus`](#storagerulesgatestatus) | `'idle'` only when `storage` is null/undefined. |
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

<a id="pendingprefixaction"></a>

### PendingPrefixAction

```ts
type PendingPrefixAction =
  | {
  path: string;
  type: "create";
}
  | {
  path: string;
  type: "materialize";
}
  | {
  path: string;
  type: "discard";
}
  | {
  type: "clear";
};
```

#### Type Declaration

```ts
{
  path: string;
  type: "create";
}
```

##### path

```ts
path: string;
```

##### type

```ts
type: "create";
```

Create a folder at `path` (absolute, bucket-rooted; nested paths
 allowed) — adds the full ancestor chain.

```ts
{
  path: string;
  type: "materialize";
}
```

##### path

```ts
path: string;
```

##### type

```ts
type: "materialize";
```

An object now exists directly under `path`: drop `path` and its
 ancestors from pending (they are real prefixes now).

```ts
{
  path: string;
  type: "discard";
}
```

##### path

```ts
path: string;
```

##### type

```ts
type: "discard";
```

Remove a session-only folder and every pending descendant beneath it.

```ts
{
  type: "clear";
}
```

##### type

```ts
type: "clear";
```

***

<a id="pendingprefixstate"></a>

### PendingPrefixState

```ts
type PendingPrefixState = readonly string[];
```

Sorted, deduped, normalized pending prefix paths.

***

<a id="storageapi"></a>

### StorageApi

```ts
type StorageApi = Pick<any,
  | "ref"
  | "listAll"
  | "getMetadata"
  | "getBlob"
  | "uploadBytes"
| "deleteObject">;
```

The modular Storage fns the browse/inspect hooks call, as an INJECTABLE
bundle (same pattern as `@pyric/ui`'s FirestoreApi / AuthApi).

Default = in-process `pyric/storage`, so existing consumers are unchanged.
Pyric Studio served mode injects the SharedWorker client bundle so the Storage
surface browses the live worker object store. These ops are already async, so
no sync/async wrinkle (unlike auth `listUsers`); the worker handles/refs are
runtime-compatible at the surface the hooks use (`.fullPath` / `.name`).

`uploadBytes` rides the same seam so `useObjectUpload` follows the injected
backend: in-process writes are uncapped; the worker client's `uploadBytes`
(base64 `storage.putBytes` over the MessagePort) enforces an 8 MiB payload
cap on both ends — an over-cap upload fails that file's task with the typed
`storage/...` too-large error and the rest of the batch proceeds.

NOTE the rules gate (`useStorageRulesGate`) is NOT here: it reads in-process
rules internals and no-ops on a handle without them (worker handles), which is
the correct degrade (the worker enforces read rules on `listAll` server-side).

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

## Variables

<a id="defaultstoragepreviews"></a>

### defaultStoragePreviews

```ts
const defaultStoragePreviews: ReadonlyArray<StoragePreview>;
```

The section 3 defaults: image, text/json; everything else is
 metadata-only (the inspector's `data-pyric-preview-none` state).

***

<a id="imagepreview"></a>

### imagePreview

```ts
const imagePreview: StoragePreview;
```

`image/*` → blob-URL `<img>`.

***

<a id="initialpendingprefixes"></a>

### initialPendingPrefixes

```ts
const initialPendingPrefixes: PendingPrefixState;
```

***

<a id="text_preview_max_bytes"></a>

### TEXT\_PREVIEW\_MAX\_BYTES

```ts
const TEXT_PREVIEW_MAX_BYTES: number;
```

256KB — the section 3 default cap for the text-family preview.

***

<a id="textpreview"></a>

### textPreview

```ts
const textPreview: StoragePreview;
```

`text/*` + `application/json` → text panel, 256KB cap (bigger
 objects fall through to the too-large fallback). JSON is
 pretty-printed when parseable.

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
| `api?` | `Pick`\<[`StorageApi`](#storageapi), `"listAll"` \| `"deleteObject"`\> |

#### Returns

[`StorageRecursiveDeleteImpl`](#storagerecursivedeleteimpl)

***

<a id="deleteselectionwithconfirm"></a>

### DeleteSelectionWithConfirm()

```ts
function DeleteSelectionWithConfirm(__namedParameters: DeleteSelectionWithConfirmProps): Element;
```

Bulk delete behind the confirm-dialog primitive, with toasts on
outcome — wires `useConfirm` + `useStorageDelete` + `useToast` the
way `<DeleteWithConfirm>` wires the Firestore trio. Requires
`<ConfirmProvider>` AND `<ToastProvider>` ancestors.

Outcome toasts: all-success → one `success` toast with the count;
any failure → an `error` toast listing each failed path with its
typed `StorageError.code`.

The default trigger styles via `[data-pyric-ui="delete-selection"]`
(+ `[data-pyric-destructive]`, `[data-pyric-running]`,
`[data-pyric-denied]` with the reason on
`data-pyric-denied-reason`/`title`); it disables while running,
when `entries` is empty, or when the rules `gate` denies the
selection.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`DeleteSelectionWithConfirmProps`](#deleteselectionwithconfirmprops) |

#### Returns

`Element`

***

<a id="expandpathchain"></a>

### expandPathChain()

```ts
function expandPathChain(path: string): string[];
```

`'a/b/c'` → `['a', 'a/b', 'a/b/c']`; `''` → `[]`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

#### Returns

`string`[]

***

<a id="folderinputerror"></a>

### folderInputError()

```ts
function folderInputError(input: string): string;
```

Validate a create-folder input (relative to the current folder;
nested `a/b/c` allowed — VS Code semantics). Returns an error
message or `null` when valid. Normalization tolerates stray/repeat
slashes; `.`/`..` segments are rejected (GCS object names have no
dot-segment semantics — accepting them would create unreachable
names).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `input` | `string` |

#### Returns

`string`

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

<a id="ispendingprefix"></a>

### isPendingPrefix()

```ts
function isPendingPrefix(state: PendingPrefixState, path: string): boolean;
```

Whether `path` itself is a pending (session-only) folder.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `state` | [`PendingPrefixState`](#pendingprefixstate) |
| `path` | `string` |

#### Returns

`boolean`

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

<a id="objectbrowser"></a>

### ObjectBrowser()

```ts
function ObjectBrowser(__namedParameters: ObjectBrowserProps): Element;
```

Headless storage browser shell — renders `useStorageList`'s merged
folder/object rows. Folder rows navigate (`onNavigate` with the
prefix path), object rows select (`onSelect` with the ref). Below
`virtualizeThreshold` renders a plain `<ul>`; above it, composes
the package's `<VirtualList>`.

Ships no visual styling. Consumers style via:
- `[data-pyric-ui="object-browser"]` — the root (stamps `data-size`)
- `…[data-pyric-loading]` / `[data-pyric-empty]` / `[data-pyric-error]`
- `…[data-pyric-virtualized]` — virtualized mode
- `[data-pyric-object-browser-items]` — the `<ul>` in plain mode
- `[data-pyric-storage-entry]` — each row
- `[data-pyric-storage-entry][data-pyric-entry-kind="folder"|"object"]`
- `[data-pyric-storage-entry][data-pyric-entry-path="docs/a.txt"]`
- `[data-pyric-storage-entry][data-pyric-denied]` — read-denied row
  (rules gate; reason on `data-pyric-denied-reason`)
- `[data-pyric-entry-select]` — the row button
- `[data-pyric-entry-select][data-pyric-selected]` — the selected object
- `[data-pyric-storage-action]` — optional sibling row action

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`ObjectBrowserProps`](#objectbrowserprops) |

#### Returns

`Element`

***

<a id="objectinspector"></a>

### ObjectInspector()

```ts
function ObjectInspector(__namedParameters: ObjectInspectorProps): Element;
```

Headless inspector for one storage object: metadata + a
content-type-driven preview. Previews come from the registry
(`image/*` and `text/* + application/json` built in; extend via
`previews`). Blob bytes load lazily and ONLY when the matched
preview asks (`needsBlob`) and the object is within the preview's
`maxBytes` cap; the blob URL is revoked on unmount/path change
(see `useStorageObject`).

Ships no visual styling. Consumers style via:
- `[data-pyric-ui="object-inspector"]` — root (stamps `data-size`)
- `…[data-pyric-idle]` / `[data-pyric-loading]` / `[data-pyric-error]`
- `[data-pyric-object-name]` / `[data-pyric-object-metadata]`
- `[data-pyric-metadata-field="<field>"]` — each metadata row
- `[data-pyric-object-preview]` — the preview container, stamping
  `data-pyric-preview="<id>"` for the matched registry entry
- `…[data-pyric-preview-loading]` — blob in flight
- `…[data-pyric-preview-error]` — blob load failed
- `…[data-pyric-preview-too-large]` — over the preview's cap
- `…[data-pyric-preview-none]` — no registry match (metadata-only)

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`ObjectInspectorProps`](#objectinspectorprops) |

#### Returns

`Element`

***

<a id="parsecopycounter"></a>

### parseCopyCounter()

```ts
function parseCopyCounter(stem: string): {
  base: string;
  counter: number;
};
```

Trailing ` (n)` counter: `photo (3)` → base `photo`, counter 3.
 `counter: null` when the stem carries none. A counter beyond
 `Number.MAX_SAFE_INTEGER` is treated as plain text (no counter):
 incrementing it would be lossy — `n + 1 === n` in float land, which
 turns [resolveCollision](#resolvecollision)'s probe loop into a hang — and the
 candidate would render in scientific notation anyway.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `stem` | `string` |

#### Returns

```ts
{
  base: string;
  counter: number;
}
```

##### base

```ts
base: string;
```

##### counter

```ts
counter: number;
```

***

<a id="pathbreadcrumb"></a>

### PathBreadcrumb()

```ts
function PathBreadcrumb(__namedParameters: PathBreadcrumbProps): Element;
```

Headless breadcrumb for storage paths. Every crumb (including the
current one) is a real `<button>` — clicking the current crumb is
a cheap "refresh this level" affordance for consumers that wire
`onNavigate` to a path-keyed loader.

Ships no visual styling. Consumers style via:
- `[data-pyric-ui="path-breadcrumb"]` — the `<nav>` root
- `[data-pyric-breadcrumb-item]` — each `<li>`
- `[data-pyric-breadcrumb-link]` — each crumb button
- `[data-pyric-breadcrumb-link][data-pyric-current]` — the current level
- `[data-pyric-breadcrumb-root]` — the root crumb's button
- `[data-pyric-breadcrumb-separator]` — the separators

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`PathBreadcrumbProps`](#pathbreadcrumbprops) |

#### Returns

`Element`

***

<a id="pendingchildfolders"></a>

### pendingChildFolders()

```ts
function pendingChildFolders(state: PendingPrefixState, parentPath: string): string[];
```

Direct-child folder NAMES pending under `parentPath` (`''` = root),
 sorted. The chain expansion guarantees every level is present, so a
 simple parent match is exact.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `state` | [`PendingPrefixState`](#pendingprefixstate) |
| `parentPath` | `string` |

#### Returns

`string`[]

***

<a id="pendingprefixreducer"></a>

### pendingPrefixReducer()

```ts
function pendingPrefixReducer(state: PendingPrefixState, action: PendingPrefixAction): PendingPrefixState;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `state` | [`PendingPrefixState`](#pendingprefixstate) |
| `action` | [`PendingPrefixAction`](#pendingprefixaction) |

#### Returns

[`PendingPrefixState`](#pendingprefixstate)

***

<a id="planbatchnames"></a>

### planBatchNames()

```ts
function planBatchNames(relativePaths: readonly string[], taken: ReadonlySet<string>): string[];
```

Resolve a whole drop/pick batch against the destination folder's
existing names, with OS drop semantics: collisions are detected and
renamed at the batch's TOP LEVEL only (the names the OS drop
"creates" in the destination — a plain file's name, or a dropped
folder's root segment). Files inside a dropped folder ride their
folder's rename and keep their inner structure untouched — exactly
like dropping `photos/` next to an existing `photos/` yields
`photos (1)/…` with the contents intact.

Within one batch:
- all paths sharing a top-level FOLDER segment share its resolution
  (one dropped folder = one rename), and
- top-level FILES resolve individually in order, each claiming its
  resolved name, so two same-named files in one batch get successive
  counters.

Only the destination's DIRECT children can be checked — that is all
the drop target (one `listAll` level) knows. Deeper paths follow GCS
overwrite semantics, which the folder-level rename already shields
in practice (a colliding folder is renamed wholesale).

Returns resolved paths in input order.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `relativePaths` | readonly `string`[] |
| `taken` | `ReadonlySet`\<`string`\> |

#### Returns

`string`[]

***

<a id="resolvecollision"></a>

### resolveCollision()

```ts
function resolveCollision(name: string, taken: ReadonlySet<string>): string;
```

Resolve one name against a set of taken sibling names. Returns the
name unchanged when free; otherwise the first ` (n)` candidate that
is free, per the module rule above.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `name` | `string` |
| `taken` | `ReadonlySet`\<`string`\> |

#### Returns

`string`

***

<a id="selectstoragepreview"></a>

### selectStoragePreview()

```ts
function selectStoragePreview(metadata: FullMetadata, consumerPreviews: readonly StoragePreview[]): StoragePreview;
```

Pick the preview for `metadata`: consumer previews first (override
channel), then the built-ins, first `match` wins. `undefined`
means metadata-only.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `metadata` | `FullMetadata` |
| `consumerPreviews` | readonly [`StoragePreview`](#storagepreview)[] |

#### Returns

[`StoragePreview`](#storagepreview)

***

<a id="splitstoragename"></a>

### splitStorageName()

```ts
function splitStorageName(name: string): {
  ext: string;
  stem: string;
};
```

`name` split as the rule defines: `ext` includes the leading dot,
 or is `''` when the name has no extension (dotfiles, trailing dots,
 extensionless names).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `name` | `string` |

#### Returns

```ts
{
  ext: string;
  stem: string;
}
```

##### ext

```ts
ext: string;
```

##### stem

```ts
stem: string;
```

***

<a id="storageapiprovider"></a>

### StorageApiProvider()

```ts
function StorageApiProvider(__namedParameters: {
  children: ReactNode;
  value: StorageApi;
}): FunctionComponentElement<ProviderProps<StorageApi>>;
```

Provide a Storage API bundle to the subtree (Studio's worker client).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | \{ `children`: `ReactNode`; `value`: [`StorageApi`](#storageapi); \} |
| `__namedParameters.children` | `ReactNode` |
| `__namedParameters.value` | [`StorageApi`](#storageapi) |

#### Returns

`FunctionComponentElement`\<`ProviderProps`\<[`StorageApi`](#storageapi)\>\>

***

<a id="uploaddropzone"></a>

### UploadDropzone()

```ts
function UploadDropzone(__namedParameters: UploadDropzoneProps): Element;
```

Headless drop target for file + folder uploads. Slot-based: the
children render the chrome; the component owns drag wiring and
stamps `data-dragging` while a drag hovers (a counter tracks
enter/leave pairs so crossing child elements doesn't flicker).

Ships no visual styling. Consumers style via:
- `[data-pyric-ui="upload-dropzone"]` — the root
- `…[data-dragging]` — a drag is hovering
- `…[data-disabled]`
- `…[data-disabled-reason="…"]` — why (e.g. a denied write verdict)

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`UploadDropzoneProps`](#uploaddropzoneprops) |

#### Returns

`Element`

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

<a id="usestorageapi"></a>

### useStorageApi()

```ts
function useStorageApi(): StorageApi;
```

Read the active Storage API bundle (defaults to in-process `pyric/storage`).

#### Returns

[`StorageApi`](#storageapi)

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
