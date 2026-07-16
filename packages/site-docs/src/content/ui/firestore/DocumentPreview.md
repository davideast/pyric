---
title: "<DocumentPreview>"
group: "@pyric/ui"
section: "Firestore"
order: 130
---
# `<DocumentPreview>`

Read-only renderer for a Firestore document. Iterates top-level fields in lexicographic order; dispatches each value through the field-editor registry on its inferred type.

```ts
import { DocumentPreview } from '@pyric/ui/firestore';
```

## Example

```tsx
import { useFirestoreDoc } from '@pyric/ui/firestore';

function UserPreview({ ref }) {
  const { data, isLoading, error } = useFirestoreDoc(ref);
  if (error) return <ErrorRow message={error.message} />;
  if (isLoading) return <Spinner />;
  return (
    <DocumentPreview
      snapshot={data}
      onReferenceClick={(targetRef) => navigate(targetRef.path)}
      emptyState={<p>No such document.</p>}
    />
  );
}
```

## Props

| Prop | Type | Required | Description |
|---|---|---|---|
| `snapshot` | `DocumentSnapshot \| null \| undefined` | yes | Snapshot from `useFirestoreDoc` or `getDoc`. Null/undefined or non-existent renders the empty state. |
| `fieldEditors` | `FieldEditorRegistry` | no | Override or extend the built-in editors. Merged into the defaults — only the keys you provide override. |
| `emptyState` | `ReactNode` | no | Rendered when snapshot is null or `!exists()`. Default `null`. |
| `className` | `string` | no | Forwarded to the root `<div>`. |
| `onReferenceClick` | `(ref: DocumentReference) => void` | no | When provided, reference fields render as clickable `<button>` with `data-pyric-clickable`. Without it, references stay inert `<span>`s. |

## Field-type rendering

Each field type renders to a different element with a `data-pyric-field-type` attribute:

| Type | Element | Attributes | Notes |
|---|---|---|---|
| `string` | `<span>` | `data-pyric-field-type="string"` | |
| `number` | `<span>` | `data-pyric-field-type="number"` | `String(value)` |
| `boolean` | `<span>` | `data-pyric-field-type="boolean" data-value="true"` | |
| `null` | `<span>` | `data-pyric-field-type="null"` | Renders `"null"` text |
| `timestamp` | `<time>` | `dateTime={iso}` | ISO 8601 |
| `geopoint` | `<span>` | `data-lat data-lng` | `"lat, lng"` text |
| `reference` | `<span>` or `<button>` | `data-target-path` + `data-pyric-clickable` when onClick wired | |
| `bytes` | `<code>` | `data-byte-length` | base64 |
| `map` | `<dl>` | — | Recursive, lex-sorted keys |
| `array` | `<ol>` | — | Recursive, insertion order |

## Container queries

The root emits `data-size="narrow" \| "medium" \| "wide"` (breakpoints: 480 / 768 px) measured against its container via `ResizeObserver`. Style responsively with attribute selectors instead of viewport media queries.

## Customizing per-type rendering

Pass a partial `fieldEditors` registry to override one type. The override merges into the defaults, so unspecified types keep the built-in renderer.

```tsx
import {
  defaultFieldEditors,
  type FieldEditorContract,
} from '@pyric/ui/firestore';

const customString: FieldEditorContract<string> = {
  type: 'string',
  Display: ({ value }) => <em>{value.toUpperCase()}</em>,
};

<DocumentPreview
  snapshot={snap}
  fieldEditors={{ string: customString }}
/>
```

## See also

- [`<DocumentEditor>`](./DocumentEditor.md) — the editable counterpart.
- `useFirestoreDoc(ref)` — fetches the snapshot via `onSnapshot`.
- `inferType(value)` — the type discriminator used internally.
