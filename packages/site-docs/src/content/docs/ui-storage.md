---
title: "@pyric/ui/storage"
group: "@pyric/ui"
section: "Storage"
order: 204
---
# `@pyric/ui/storage`

Headless components + hooks for browsing AND administering Firebase Storage —
list/navigate/select (the read path), upload, inspect, metadata editing, and
bulk delete (the write path), plus rules-aware affordances (the gate
pre-evaluates rules so denied actions warn BEFORE the click). Same one-handle
contract as the Firestore half: every hook takes a `FirebaseStorage` handle
(`pyric/storage` sandbox or prod), so the same components work against the
in-browser sandbox and a real bucket.
```ts
import {
  // read path
  useStorageList,
  usePathState,
  ObjectBrowser,
  PathBreadcrumb,
  // write path
  useObjectUpload,
  useStorageObject,
  useMetadataEditor,
  useStorageSelection,
  useStorageDelete,
  // rules-aware affordances
  useStorageRulesGate,
  UploadDropzone,
  ObjectInspector,
  DeleteSelectionWithConfirm,
  defaultStoragePreviews,
} from '@pyric/ui/storage';
// hooks-only entry: '@pyric/ui/storage/hooks'
```
## The wiring (one screen)
```tsx
function StorageAdmin({ storage }) {
  const nav = usePathState();
  const list = useStorageList(storage, nav.path);
  const selection = useStorageSelection();
  const upload = useObjectUpload(storage, { path: nav.path, list });
  const gate = useStorageRulesGate(storage);
  const pathVerdict = gate.verdictFor(nav.path);
  const [inspecting, setInspecting] = useState<string | null>(null);

  return (
    <ToastProvider>
      <ConfirmProvider>
        <PathBreadcrumb path={nav.path} onNavigate={nav.setPath} />
        <UploadDropzone
          disabled={!pathVerdict.upload}
          disabledReason={pathVerdict.reasons.write.join('; ')}
          onFiles={(files) =>
            upload.upload(files.map((f) => ({ path: f.relativePath, data: f.file })))
          }
        >
          <ObjectBrowser
            entries={list.entries}
            status={list.status}
            error={list.error}
            gate={gate}
            onNavigate={(p) => { selection.clear(); nav.enter(p); }}
            onSelect={(ref) => setInspecting(ref.fullPath)}
          />
        </UploadDropzone>
        <DeleteSelectionWithConfirm
          storage={storage}
          entries={selection.selected}
          list={list}
          gate={gate}
          onDeleted={() => { selection.clear(); list.refresh(); }}
        />
        <ObjectInspector storage={storage} path={inspecting} />
      </ConfirmProvider>
    </ToastProvider>
  );
}
```
## Components

- [ObjectBrowser](../ui-storage-objectbrowser/) — the folder/object row list;
  virtualized above 100 rows.
- [PathBreadcrumb](../ui-storage-pathbreadcrumb/) — clickable ancestor trail.
- [UploadDropzone](../ui-storage-uploaddropzone/) — slot-based file + folder drop
  target.
- [ObjectInspector](../ui-storage-objectinspector/) — metadata + content-type-driven
  previews (image/text/json built in, consumer-extensible).
- [DeleteSelectionWithConfirm](../ui-storage-deleteselectionwithconfirm/) — bulk +
  recursive delete behind the confirm dialog, toasts on outcome.

## Concepts

- [Rules-aware affordances](../ui-storage-rules-aware-affordances/) — how the gate's
  verdicts flow into `data-pyric-denied` rows and disabled-with-reason
  states, and the advisory-on-prod caveat.

## Hooks

Hook docs live in the source JSDoc — every hook has an options/return
interface commented per field ([`useStorageRulesGate`](../ui-storage-usestoragerulesgate/)
also has a full page). Summary:

- **`useStorageList(storage, path)`** — `listAll` + the prefix→folder
  synthesis: `{ status, items, prefixes, entries, error, refresh,
  insertItem, removeItem }`. `insertItem`/`removeItem` are the optimistic
  seam the upload/delete hooks plug into (a trailing slash declares a
  folder). A rules-denied list surfaces the typed error
  (`error.code === 'storage/unauthorized'`).
- **`usePathState({ path?, onPathChange?, defaultPath? })`** — navigation
  state, controlled or uncontrolled. `{ path, segments, setPath, enter, up,
  navigateToIndex }`.
- **`useObjectUpload(storage, { path, list, onProgress, onComplete,
  onError })`** — multi-file upload with a **task-shaped API**
  (`UploadTask` carries byte counters; `pyric/storage` has no resumable
  uploads yet, so tasks complete in one tick — the type won't change when
  resumable lands). Optimistic insert + rollback through the `list` seam.
  Also `createFolder(name)` — writes the zero-byte `<path>/` placeholder
  (GCS convention; sandbox-only until `pyric/storage` grows a prod
  channel).
- **`useStorageObject(storage, path)`** — one object's metadata + lazy
  bytes: `{ status, metadata, error, refresh, blobStatus, blob, blobUrl,
  blobError, loadBlob }`. `blobUrl` is a `URL.createObjectURL` handle
  (there's no `getDownloadURL`), revoked automatically on path change and
  unmount.
- **`useMetadataEditor(storage, path, { initial })`** — the
  `useDocumentEditor` reducer pattern over `updateMetadata`: contentType,
  cacheControl, customMetadata k/v rows (stable ids, empty/duplicate-key
  validation), `isDirty`/`isValid`/`reset`/`toPatch`, plus
  `save`/`isSaving`/`saveError`. Note: clearing a text field keeps the old
  value — the storage surface doesn't model null-clears yet.
- **`useStorageSelection()`** — multi-select keyed by `fullPath`;
  `list.entries` rows pass straight in.
- **`useStorageDelete(storage, { impl?, list? })`** — bulk + recursive
  delete. Folders walk via the injectable `StorageRecursiveDeleteImpl`
  (default: `createListAllDeleteImpl()` — `listAll`-driven, sweeps
  create-folder placeholders so emptied folders don't ghost).
- **`useStorageRulesGate(storage, { paths?, rules?, identity?,
  writeResource? })`** — pre-flight rules verdicts (`{ read, write,
  delete, upload, reasons }`; delete/upload derive from write) via the
  pure evaluator. Sandbox handles need zero config (rules + identity come
  off the handle); prod callers pass both explicitly and verdicts are
  **advisory** — the server is authoritative. Fails open. Full page:
  [useStorageRulesGate](../ui-storage-usestoragerulesgate/).

## Constraints worth knowing (from the storage COMPAT)

- **`listAll` only, no pagination** — fine at sandbox scale; a very large
  prod prefix arrives as one flat result. `<ObjectBrowser>` virtualizes, but
  the fetch itself is unpaginated. The recursive delete walks the same way.
- **Read-via-get, not realtime** — lists and inspectors update on `refresh`,
  path change, or the optimistic seam.
- **No `getDownloadURL`** — previews go through `getBlob` →
  `URL.createObjectURL`, identical sandbox/prod.
- **No resumable uploads** — `useObjectUpload` is task-shaped for
  forward-compat; `onProgress` fires start + completion today.
- **Create-folder is sandbox-only** — the `<path>/` placeholder name can't
  be expressed through the JS-SDK-shaped `ref()`; prod support is a
  `pyric/storage` follow-up.

## See also

- design rationale — the
  milestone roadmap (the playground consumer, M8, is next; M7's traffic
  panel is STOP-documented in
  the design rationale).
- [`<VirtualList>`](../ui-primitives-virtuallist/),
  [`<ConfirmDialog>`](../ui-primitives-confirmdialog/),
  [`<Toast>`](../ui-primitives-toast/) — the primitives this half composes.
