---
title: "@pyric/ui/storage"
group: "@pyric/ui"
section: "Storage"
order: 200
---
# `@pyric/ui/storage`

Headless components + hooks for browsing AND administering Firebase Storage —
list/navigate/select (the read path), upload, inspect, metadata editing, and
bulk delete (the write path), plus rules-aware affordances (the gate
pre-evaluates rules so denied actions warn BEFORE the click). Same one-handle
contract as the Firestore half: every hook takes the sandbox
`FirebaseStorage` handle from `pyric/storage`.

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

- [ObjectBrowser](./ObjectBrowser.md) — the folder/object row list;
  virtualized above 100 rows.
- [PathBreadcrumb](./PathBreadcrumb.md) — clickable ancestor trail.
- [UploadDropzone](./UploadDropzone.md) — slot-based file + folder drop
  target.
- [ObjectInspector](./ObjectInspector.md) — metadata + content-type-driven
  previews (image/text/json built in, consumer-extensible).
- [DeleteSelectionWithConfirm](./DeleteSelectionWithConfirm.md) — bulk +
  recursive delete behind the confirm dialog, toasts on outcome.

## Concepts

- [Rules-aware affordances](./rules-aware-affordances.md) — how the gate's
  verdicts flow into `data-pyric-denied` rows and disabled-with-reason
  states.

## Hooks

Hook docs live in the source JSDoc — every hook has an options/return
interface commented per field ([`useStorageRulesGate`](./useStorageRulesGate.md)
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
  (the GCS convention) into the sandbox mirror.
- **`useStorageObject(storage, path)`** — one object's metadata + lazy
  bytes: `{ status, metadata, error, refresh, blobStatus, blob, blobUrl,
  blobError, loadBlob }`. `blobUrl` is a `URL.createObjectURL` handle,
  revoked automatically on path change and unmount.
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
  off the handle). Fails open. Full page:
  [useStorageRulesGate](./useStorageRulesGate.md).

## Constraints worth knowing (from the storage COMPAT)

- **`listAll` only, no pagination** — a very large sandbox prefix arrives
  as one flat result. `<ObjectBrowser>` virtualizes, but
  the fetch itself is unpaginated. The recursive delete walks the same way.
- **Read-via-get, not realtime** — lists and inspectors update on `refresh`,
  path change, or the optimistic seam.
- **`getDownloadURL` is page-local** — it returns a blob URL backed by
  the sandbox object; revoke it with `URL.revokeObjectURL` when done.
- **No resumable uploads** — `useObjectUpload` is task-shaped for
  forward-compat; `onProgress` fires start + completion today.
- **Create-folder uses a structural reference** — the `<path>/` placeholder
  name cannot be expressed through the JS-SDK-shaped `ref()` because it
  normalizes trailing slashes.

## See also

- design rationale — the
  milestone roadmap (the playground consumer, M8, is next; M7's traffic
  panel is STOP-documented in
  the design rationale).
- [`<VirtualList>`](../primitives/VirtualList.md),
  [`<ConfirmDialog>`](../primitives/ConfirmDialog.md),
  [`<Toast>`](../primitives/Toast.md) — the primitives this half composes.
