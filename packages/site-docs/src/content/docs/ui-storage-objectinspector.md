---
title: "<ObjectInspector>"
group: "@pyric/ui"
section: "Storage"
order: 199
---
# `<ObjectInspector>`

Headless inspector for one storage object: metadata fields + a **content-type-driven preview**. Previews come from a registry — `image/*` (blob-URL `<img>`) and `text/* + application/json` (text panel, 256KB cap, JSON pretty-printed) ship built in; consumers extend by prepending their own matchers. Bytes load lazily and only when the matched preview asks; blob URLs are revoked on path change/unmount.
```ts
import { ObjectInspector, defaultStoragePreviews } from '@pyric/ui/storage';
```
## Example
```tsx
function Inspector({ storage, selectedPath }) {
  return (
    <ObjectInspector
      storage={storage}
      path={selectedPath} // null renders the idle shell
      previews={[
        {
          id: 'video',
          match: (md) => (md.contentType ?? '').startsWith('video/'),
          needsBlob: true,
          maxBytes: 20 * 1024 * 1024,
          render: ({ blobUrl }) => <video src={blobUrl} controls />,
        },
      ]}
    >
      {/* slot below the preview — editor, delete button, … */}
    </ObjectInspector>
  );
}
```
## Props

| Prop | Type | Description |
|---|---|---|
| `storage` | `FirebaseStorage` | The single Storage handle prop. |
| `path` | `string \| null` | Object to inspect; `null` = idle shell. Keep the inspector mounted and swap paths. |
| `previews` | `StoragePreview[]` | Tried BEFORE the built-ins; first `match` wins. |
| `renderMetadata` | `(md: FullMetadata) => ReactNode` | Replaces the default metadata `<dl>`. |
| `children` | `ReactNode` | Rendered below the preview. |
| `className` | `string` | Forwarded to the root. |

### `StoragePreview`

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Stamped as `data-pyric-preview="<id>"`. |
| `match` | `(md: FullMetadata) => boolean` | Content-type predicate. |
| `needsBlob` | `boolean` | Ask the inspector to `loadBlob()` first. Default `false`. |
| `maxBytes` | `number` | Objects larger than this skip the preview AND the download (`data-pyric-preview-too-large`). |
| `render` | `(ctx: { metadata, blob, blobUrl }) => ReactNode` | The preview body. |

## Styling hooks
```
[data-pyric-ui="object-inspector"]                 /* root; stamps data-size */
[data-pyric-ui="object-inspector"][data-pyric-idle]
[data-pyric-ui="object-inspector"][data-pyric-loading]
[data-pyric-ui="object-inspector"][data-pyric-error]    /* role="alert" */
[data-pyric-object-name]
[data-pyric-object-metadata]                       /* the default <dl> */
[data-pyric-metadata-field="size"]                 /* …contentType, cacheControl, … */
[data-pyric-metadata-field="customMetadata"][data-pyric-metadata-key="owner"]
[data-pyric-object-preview]                        /* stamps data-pyric-preview="<id>" */
[data-pyric-object-preview][data-pyric-preview-loading]
[data-pyric-object-preview][data-pyric-preview-error]
[data-pyric-object-preview][data-pyric-preview-too-large]
[data-pyric-object-preview][data-pyric-preview-none]    /* metadata-only fallback */
[data-pyric-preview-image]                         /* the built-in <img> */
[data-pyric-preview-text]                          /* the built-in <pre> */
```
## Notes

- **No `getDownloadURL` anywhere** — previews go `getBlob` →
  `URL.createObjectURL`, which behaves identically against the sandbox and a
  real bucket (and kills the emulator UI's download-token hack). The URL is
  revoked automatically; don't cache it past the component.
- **The 256KB text cap** skips the download entirely, not just the render —
  big logs won't be pulled into memory for a preview.
- **Registry, not a prop soup** — overriding the image preview is shipping
  your own `{ id, match, render }` with an `image/` matcher; the built-ins
  are exported (`imagePreview`, `textPreview`, `defaultStoragePreviews`) for
  composition.
- Pair with `useMetadataEditor` in the `children` slot for an edit panel —
  `useStorageObject`'s `metadata` is the editor's `initial`.

## See also

- `useStorageObject` — the hook underneath (metadata + lazy blob).
- [`<DeleteSelectionWithConfirm>`](../ui-storage-deleteselectionwithconfirm/) — the
  usual neighbor in an admin sidebar.
