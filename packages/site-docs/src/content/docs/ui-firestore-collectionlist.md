---
title: "<CollectionList>"
group: "@pyric/ui"
section: "Firestore"
order: 23009
---
# `<CollectionList>`

Headless list renderer for collections under a parent. The component is purely presentational — fetching is the consumer's job (via `useCollectionList` or otherwise).

```ts
import { CollectionList } from '@pyric/ui/firestore';
```

## Example

```tsx
import { useCollectionList } from '@pyric/ui/firestore/hooks';

function CollectionsPane({ firestore, parent }) {
  const { collections, isLoading, error } = useCollectionList({
    firestore,
    parent,
    listCollections: mySchemaAwareLister, // see below
  });

  return (
    <CollectionList
      collections={collections}
      isLoading={isLoading}
      error={error}
      onSelect={(coll) => navigate(coll.path)}
      emptyState={<>No collections under this parent.</>}
    />
  );
}
```

## Props

| Prop | Type | Description |
|---|---|---|
| `collections` | `CollectionReference[]` | The list to render. |
| `isLoading` | `boolean` | Renders an empty container with `data-pyric-loading` when no collections yet. |
| `error` | `Error` | Renders an `role="alert"` container with `data-pyric-error`. |
| `onSelect` | `(coll: CollectionReference) => void` | Fired on row click. |
| `emptyState` | `ReactNode` | Rendered when no collections AND no error AND not loading. |
| `className` | `string` | Forwarded to the root. |

## The `listCollections` problem

The modular Web SDK has no `listCollections()` on the client. The full list is only available to admin-SDK callers. `useCollectionList` therefore takes an injected lister:

```ts
useCollectionList({
  firestore,
  parent,                              // null/undefined → root
  listCollections: async (firestore, parent) => {
    // Three plausible implementations:
    //   1. Sandbox introspection — walk pyric/sandbox's in-process tree
    //   2. Server proxy — fetch a known endpoint with admin-SDK access
    //   3. Schema — return a hardcoded or schema-driven list
    return [...];
  },
});
```

See `packages/playground/src/components/FirestoreTab.tsx` for a sandbox-introspection example using `getRunner().readState()`.

## Styling hooks

```
[data-pyric-ui="collection-list"]
[data-pyric-ui="collection-list"][data-pyric-loading]
[data-pyric-ui="collection-list"][data-pyric-empty]
[data-pyric-ui="collection-list"][data-pyric-error]
[data-pyric-collection-entry]
[data-pyric-collection-entry][data-pyric-collection-id="users"]
[data-pyric-collection-select]
```

## See also

- [`<DocumentList>`](../ui-firestore-documentlist/) — the docs-in-collection counterpart.
- `useCollectionList` — fetches + exposes `createCollection`.
