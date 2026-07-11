---
title: "<DocumentEditor>"
group: "@pyric/ui"
section: "Firestore"
order: 200
---
# `<DocumentEditor>`

Compound component over `useDocumentEditor`. The hook owns a reducer-backed normalized field tree; the component renders the tree with per-type Edit widgets and add/remove affordances.
```ts
import { DocumentEditor, type UseDocumentEditorResult } from '@pyric/ui/firestore';
```
## Save-button gating pattern
```tsx
function MyEditor({ snap }: { snap: DocumentSnapshot }) {
  const [editor, setEditor] = useState<UseDocumentEditorResult | null>(null);
  return (
    <>
      <DocumentEditor.Root initial={snap.data() ?? {}} onChange={setEditor}>
        <DocumentEditor.Fields />
      </DocumentEditor.Root>
      <button
        disabled={!editor?.isValid || !editor.isDirty}
        onClick={async () => {
          await setDoc(snap.ref, editor!.toData());
          toast({ title: 'Saved', kind: 'success' });
        }}
      >
        Save
      </button>
    </>
  );
}
```
## `<DocumentEditor.Root>` props

| Prop | Type | Description |
|---|---|---|
| `initial` | `Record<string, unknown>` | Initial document data — same shape as `DocumentSnapshot.data()`. Built into the tree on first mount; later changes do NOT rebuild — call `editor.reset()` for that. |
| `fieldEditors` | `FieldEditorRegistry` | Override or extend the built-in registry. |
| `onChange` | `(state: UseDocumentEditorResult) => void` | Fired on every state change. Capture this to drive the Save button and to call `toData()` on submit. |
| `children` | `ReactNode` | Typically `<DocumentEditor.Fields />` and any custom chrome (Save button, breadcrumb). |
| `className` | `string` | Forwarded to the root. |

The root emits `data-pyric-is-valid` and `data-pyric-is-dirty` attributes when the corresponding hook state is true. Use these to style Save buttons via attribute selectors alone if you prefer not to thread `onChange`.

## `<DocumentEditor.Fields>`

Recursive renderer over the tree's root children. Inserts an `Add field` button at the bottom for adding to the root.

No props. Must render inside a `<DocumentEditor.Root>`.

## Direct hook access

Sometimes the default `<DocumentEditor.Fields>` layout isn't what you want — e.g., you need a custom field order, or only edit a subset. Drop down to the hook:
```tsx
import { useDocumentEditor } from '@pyric/ui/firestore/hooks';

function CustomEditor() {
  const editor = useDocumentEditor({ initial: { name: 'Alice' } });
  // Render `editor.tree` yourself.
  return <pre>{JSON.stringify(editor.tree, null, 2)}</pre>;
}
```
Inside a `<DocumentEditor.Root>`, `useDocumentEditorContext()` gives you the same hook return value:
```tsx
import { DocumentEditor, useDocumentEditorContext } from '@pyric/ui/firestore';

function Inner() {
  const editor = useDocumentEditorContext();
  return <span>{editor.errorCount} errors</span>;
}
```
## Field types supported

`string`, `number`, `boolean`, `null`, `timestamp`, `geopoint`, `reference`, `bytes`, `map`, `array`. See [`DocumentPreview.md`](../ui-firestore-documentpreview/) for the read-mode rendering of each; edit-mode widgets:

| Type | Widget |
|---|---|
| `string` | `<input type="text">` |
| `number` | `<input type="number">` — parseFloat, NaN propagates to validator |
| `boolean` | `<select>` with `true`/`false` options (`data-pyric-boolean-select`) |
| `null` | inert placeholder |
| `timestamp` | `<input type="datetime-local">` |
| `geopoint` | two `<input type="number">` for lat/lng |
| `reference` | text input for path; [`<ReferencePicker>`](../ui-firestore-referencepicker/) is a richer alternative |
| `bytes` | base64 `<textarea>` |
| `map` | recursive |
| `array` | recursive; nested arrays rejected at the reducer |

## Styling hooks
```
[data-pyric-ui="document-editor"]
[data-pyric-ui="document-editor"][data-pyric-is-valid]
[data-pyric-ui="document-editor"][data-pyric-is-dirty]
[data-pyric-ui="document-editor"][data-size="narrow|medium|wide"]
[data-pyric-field-entry]
[data-pyric-field-entry][data-pyric-error]
[data-pyric-field-chrome]
[data-pyric-field-key-input]
[data-pyric-field-type-select]
[data-pyric-remove]
[data-pyric-add-map-entry]
[data-pyric-add-array-entry]
[data-pyric-error-message]
[data-pyric-map-children]
[data-pyric-array-children]
```
## Notes

- **`initial` is captured once.** The hook builds the tree on first mount and ignores later changes to the prop. If the underlying document changes externally, remount the editor (`<DocumentEditor.Root key={ref.path}>`) or call `editor.reset()` after updating your local state.
- **`isDirty` is action-based, not value-based.** Once any modifying action fires, dirty stays true until `reset()`. Editing back to the original value doesn't clear it (cheap to check; expensive to do correctly).
- **No optimistic save.** The component holds editor state locally. After `setDoc` succeeds, the underlying snapshot re-emits via `onSnapshot` and the parent re-renders. Decide explicitly whether to remount the editor on that re-render.
