---
title: "<UploadDropzone>"
group: "@pyric/ui"
section: "Storage"
order: 23021
---
# `<UploadDropzone>`

Headless drop target for file **and folder** uploads. Slot-based — the children render the chrome; the component owns the drag wiring, flattens the drop (folders traverse recursively via `webkitGetAsEntry`), and emits `DroppedFile { file, relativePath }[]` ready for `useObjectUpload`.

```ts
import { UploadDropzone } from '@pyric/ui/storage';
```

## Example

```tsx
import { useObjectUpload, useStorageList, usePathState } from '@pyric/ui/storage/hooks';

function Uploader({ storage }) {
  const nav = usePathState();
  const list = useStorageList(storage, nav.path);
  const { upload, tasks, isUploading } = useObjectUpload(storage, {
    path: nav.path,
    list, // optimistic insert + rollback
  });

  return (
    <UploadDropzone
      onFiles={(files) =>
        upload(files.map((f) => ({ path: f.relativePath, data: f.file })))
      }
    >
      <p>{isUploading ? `Uploading ${tasks.length}…` : 'Drop files or folders here'}</p>
      {/* click-to-browse lives in the slot: */}
      <input
        type="file"
        multiple
        onChange={(e) => upload(Array.from(e.target.files ?? []))}
      />
    </UploadDropzone>
  );
}
```

## Props

| Prop | Type | Description |
|---|---|---|
| `onFiles` | `(files: DroppedFile[]) => void` | Fired once per drop with the flattened list. `relativePath` keeps dropped-folder structure (`photos/cat.png`). Not fired for empty drops. |
| `children` | `ReactNode` | The chrome slot (copy, browse input, task list, …). |
| `disabled` | `boolean` | Ignore drops + suppress the dragging state. |
| `disabledReason` | `string` | Why — stamped on `data-disabled-reason` (only while `disabled`, alongside `aria-disabled`). Canonical source is the rules gate: `disabled={!gate.verdictFor(path).upload}` + `disabledReason={verdict.reasons.write.join('; ')}` — see [rules-aware affordances](../ui-storage-rules-aware-affordances/). |
| `className` | `string` | Forwarded to the root. |

## Styling hooks

```
[data-pyric-ui="upload-dropzone"]                 /* root */
[data-pyric-ui="upload-dropzone"][data-dragging]  /* a drag is hovering */
[data-pyric-ui="upload-dropzone"][data-disabled]
[data-pyric-ui="upload-dropzone"][data-disabled-reason]  /* why (rules gate) */
```

## Notes

- **Folder drops** traverse the `webkitGetAsEntry` tree (batched
  `readEntries`, so >100-child folders work). Browsers only expose folder
  structure through this channel — items without it fall back to
  `getAsFile`, and a bare `DataTransfer` falls back to `files`.
- **Empty folders yield nothing.** A dropped empty directory produces no
  files; wire `useObjectUpload.createFolder` to your own "new folder"
  affordance instead (it writes the zero-byte `<path>/` placeholder, hidden
  from `items`).
- **`data-dragging` doesn't flicker** when the drag crosses child elements —
  an enter/leave depth counter handles the pairing.
- **No built-in browse input** — render your own in the slot (see the
  example) and pass the `FileList` straight to `upload()`.

## See also

- `useObjectUpload` — the task-shaped upload hook this feeds.
- [`<ObjectBrowser>`](../ui-storage-objectbrowser/) — typically rendered inside the
  dropzone so the whole table is a drop target.
