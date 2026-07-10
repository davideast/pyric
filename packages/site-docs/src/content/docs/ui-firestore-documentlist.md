---
title: "<DocumentList>"
group: "@pyric/ui"
section: "Firestore"
order: 196
---
# `<DocumentList>`

Headless list renderer for documents in a collection. Above `virtualizeThreshold` (default 100), switches to virtualized rendering via `<VirtualList>`; below, renders a plain `<ul>`.
```ts
import { DocumentList } from '@pyric/ui/firestore';
```
## Example
```tsx
import { useDocumentList } from '@pyric/ui/firestore/hooks';

function DocsPane({ collection }) {
  const {
    documents,
    hasMore,
    loadMore,
    isLoading,
    error,
  } = useDocumentList({ collection, pageSize: 50 });

  return (
    <DocumentList
      documents={documents}
      isLoading={isLoading}
      error={error}
      hasMore={hasMore}
      onLoadMore={loadMore}
      onSelect={(ref) => navigate(ref.path)}
      renderLabel={(doc) => (
        <span className="flex justify-between">
          <span>{doc.id}</span>
          <span className="text-gray-500">
            {Object.keys(doc.data() ?? {}).length} fields
          </span>
        </span>
      )}
    />
  );
}
```
## Props

| Prop | Type | Description |
|---|---|---|
| `documents` | `QueryDocumentSnapshot[]` | The list to render. |
| `isLoading` | `boolean` | Renders the loading state when no documents yet. |
| `error` | `Error` | Renders an `role="alert"` container. |
| `hasMore` | `boolean` | If true AND `onLoadMore` is provided, renders a Load More button. |
| `onSelect` | `(ref: DocumentReference) => void` | Fired on row click. |
| `onLoadMore` | `() => void` | Wire to `useDocumentList.loadMore`. Button is hidden if not provided. |
| `renderLabel` | `(doc: QueryDocumentSnapshot) => ReactNode` | Optional row-label override. Default renders `doc.id`. |
| `emptyState` | `ReactNode` | Rendered when no documents. |
| `className` | `string` | Forwarded to the root. |
| `virtualizeThreshold` | `number` | Default `100`. Set to `Infinity` to disable virtualization. |
| `rowHeight` | `number \| (i: number) => number` | Default `36`. TanStack measures real heights after first paint regardless. |
| `virtualizedHeight` | `number \| string` | Scroll-container height when virtualized. Default `'60vh'`. |

## Pagination

`useDocumentList` exposes cursor-based pagination via `startAfter()` under the hood. The consumer never sees cursors — just `documents` (accumulating across pages), `hasMore`, and `loadMore()`.

This is **read-via-get, not realtime.** For realtime, use `useFirestoreCollection(query)` directly. Combining pagination + realtime is non-trivial; deferred until a real use case demands it.

## Styling hooks
```
[data-pyric-ui="document-list"]
[data-pyric-ui="document-list"][data-pyric-loading]
[data-pyric-ui="document-list"][data-pyric-empty]
[data-pyric-ui="document-list"][data-pyric-error]
[data-pyric-ui="document-list"][data-pyric-virtualized]
[data-pyric-document-list-items]      /* the <ul> in non-virtualized mode */
[data-pyric-document-entry]
[data-pyric-document-entry][data-pyric-document-id="alice"]
[data-pyric-document-select]
[data-pyric-load-more]
```
## Notes

- **Infinite scroll** isn't built in. Wire your own `IntersectionObserver` against the last rendered row's element and call `onLoadMore` when it intersects.
- **`renderLabel` runs per row** — keep it cheap (no async work). React.memo around your custom label is fine if you need it.
- **Snapshot `.ref` access** uses a structural cast under the hood — both backend shapes carry it at runtime but `pyric/firestore`'s modular interface omits it. Safe for both sandbox and prod refs.

## See also

- [`<CollectionList>`](../ui-firestore-collectionlist/) — the collections-under-parent counterpart.
- [`<VirtualList>`](../ui-primitives-virtuallist/) — the underlying virtualizer.
- `useDocumentList`, `useFirestoreCollection` — data sources.
