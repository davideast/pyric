---
title: "<ReferencePicker>"
group: "@pyric/ui"
section: "Firestore"
order: 203
---
# `<ReferencePicker>`

Pick a `DocumentReference` by typing a path OR by browsing the tree. Improvement over firebase-tools-ui's plain text input.
```ts
import { ReferencePicker } from '@pyric/ui/firestore';
```
## Example
```tsx
<ReferencePicker
  firestore={fs}
  listCollections={mySchemaAwareLister}
  initialPath="users/alice"
  onPick={(ref) => {
    // Commit the picked ref into wherever you need it — typically
    // a useDocumentEditor field.
    editor.setValue(nodeId, ref);
  }}
/>
```
## Props

| Prop | Type | Required | Description |
|---|---|---|---|
| `firestore` | `Firestore` | yes | Backend handle. Used to parse the path input via `doc(firestore, path)`. |
| `listCollections` | `(firestore, parent: DocumentReference \| null) => Promise<CollectionReference[]>` | yes | Injected lister. See `CollectionList.md` for the three plausible implementations. |
| `initialPath` | `string` | no | Pre-populates the text input. |
| `onPick` | `(ref: DocumentReference) => void` | no | Fired when the user commits via the button OR clicks a doc in the browse panel. |
| `pathLabel` | `string` | no | Label on the path input. Default `'Document path'`. |
| `className` | `string` | no | Forwarded to the root. |

## Two ways to commit

1. **Type + Commit.** The path input parses on every keystroke; the Commit button is enabled only when the path resolves to a valid `DocumentReference`. Click Commit → `onPick(ref)` fires.
2. **Browse + Click.** Toggle the Browse panel; drill into collections via the row buttons, then click a document. `onPick(ref)` fires immediately.

Either way, the text input updates to reflect the committed path so the two paths stay in sync.

## Browse panel mechanics

- **Root level** — shows collections from `listCollections(firestore, null)`.
- **Collection level** — fetches the first page (`pageSize` default 20) via `getDocs(query(coll, limit(20)))`. Each row has a Pick button (commit) and a Drill button (descend into that doc's subcollections).
- **Document level** — shows that doc's subcollections via `listCollections(firestore, ref)`.
- **Back** — pops the navigation history. Disabled at root.

## Direct hook access
```tsx
import { useReferencePicker } from '@pyric/ui/firestore/hooks';

const picker = useReferencePicker({ firestore, listCollections });
// {
//   pathInput, reference, error,
//   browseLocation, canDrillBack, collections, documents, isLoading,
//   setPathInput, pick, drillIntoCollection, drillIntoDocument,
//   drillBack, clear,
// }
```
Use the hook directly for custom layouts (popover trigger inside another component, etc).

## Styling hooks
```
[data-pyric-ui="reference-picker"]
[data-pyric-reference-path-label]
[data-pyric-reference-path-input]
[data-pyric-reference-path-input][aria-invalid="true"]
[data-pyric-reference-actions]
[data-pyric-reference-browse-toggle]
[data-pyric-reference-commit]
[data-pyric-reference-commit][disabled]
[data-pyric-ui="reference-browse-panel"]
[data-pyric-ui="reference-browse-panel"][data-pyric-loading]
[data-pyric-browse-header]
[data-pyric-browse-back]
[data-pyric-browse-location]
[data-pyric-browse-collections]
[data-pyric-browse-documents]
[data-pyric-browse-entry][data-pyric-entry-kind="collection|document"]
[data-pyric-browse-select]
[data-pyric-browse-pick]
[data-pyric-browse-drill]
```
## Notes

- **Path validation** uses `doc(firestore, path)` wrapped in try/catch. Empty paths are valid (no commit available). Paths with an odd number of segments fail with `"Must point to a document (even segment count)"`.
- **`listCollections` is ref-stabilized internally.** You can pass an inline arrow function on every render — the hook stores the latest closure in a ref so the fetch effect's deps don't churn.
- **Pre-release.** No popover / modal chrome; the component renders inline. Wrap in your own popover for a tighter UX. A bundled `<ReferencePopover>` may land in a later milestone.
