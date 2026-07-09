---
title: "<ObjectBrowser>"
group: "@pyric/ui"
section: "Storage"
order: 170
---
# `<ObjectBrowser>`

Headless row list for a storage path — folders first, then objects, from `useStorageList`'s `entries`. Folder rows **navigate**, object rows **select**. Above `virtualizeThreshold` (default 100), switches to virtualized rendering via `<VirtualList>`; below, renders a plain `<ul>`.
```ts
import { ObjectBrowser } from '@pyric/ui/storage';
```
## Example
```tsx
import { useStorageList, usePathState } from '@pyric/ui/storage/hooks';

function Browser({ storage }) {
  const nav = usePathState();
  const { entries, status, error } = useStorageList(storage, nav.path);
  const [selected, setSelected] = useState<string>();

  return (
    <ObjectBrowser
      entries={entries}
      status={status}
      error={error}
      onNavigate={nav.enter}
      onSelect={(ref) => setSelected(ref.fullPath)}
      selectedPath={selected}
      renderEntry={(e) => (
        <span className="flex gap-2">
          <span>{e.kind === 'folder' ? '📁' : '📄'}</span>
          <span>{e.name}</span>
        </span>
      )}
      emptyState={<p>No objects here.</p>}
    />
  );
}
```
## Props

| Prop | Type | Description |
|---|---|---|
| `entries` | `StorageListEntry[]` | The folders-first row model from `useStorageList`. |
| `status` | `StorageListStatus` | Drives the loading/idle states. Default `'success'`. |
| `error` | `Error` | Renders a `role="alert"` container with the message. |
| `onNavigate` | `(path: string) => void` | Folder row click — fired with the prefix's `fullPath`. Wire to `usePathState.enter`. |
| `onSelect` | `(ref: StorageReference) => void` | Object row click. |
| `selectedPath` | `string` | Marks the matching **object** row `data-pyric-selected` + `aria-selected`. Folders never select. |
| `gate` | `Pick<UseStorageRulesGateResult, 'verdictFor'>` | Pass `useStorageRulesGate(storage)` — read-denied rows are stamped `data-pyric-denied` with the evaluator trace on `data-pyric-denied-reason`. Rows stay clickable (advisory affordance). |
| `renderEntry` | `(e: StorageListEntry) => ReactNode` | Row-label slot. The button, click wiring, and `data-*` states stay with the component. Default renders `e.name`. |
| `emptyState` | `ReactNode` | Rendered when `entries` is empty and `status` is `'success'`. |
| `className` | `string` | Forwarded to the root. |
| `virtualizeThreshold` | `number` | Default `100`. `Infinity` disables virtualization. |
| `rowHeight` | `number \| (i: number) => number` | Default `36`. |
| `virtualizedHeight` | `number \| string` | Scroll-container height when virtualized. Default `'60vh'`. |

## Styling hooks
```
[data-pyric-ui="object-browser"]                       /* root; also stamps data-size */
[data-pyric-ui="object-browser"][data-pyric-loading]
[data-pyric-ui="object-browser"][data-pyric-idle]      /* storage handle is null */
[data-pyric-ui="object-browser"][data-pyric-empty]
[data-pyric-ui="object-browser"][data-pyric-error]
[data-pyric-ui="object-browser"][data-pyric-virtualized]
[data-pyric-ui="object-browser"][data-size="narrow"]   /* container-query buckets */
[data-pyric-object-browser-items]                      /* the <ul> in plain mode */
[data-pyric-storage-entry]
[data-pyric-storage-entry][data-pyric-entry-kind="folder"]
[data-pyric-storage-entry][data-pyric-entry-kind="object"]
[data-pyric-storage-entry][data-pyric-entry-path="docs/a.txt"]
[data-pyric-storage-entry][data-pyric-denied]          /* read-denied (rules gate) */
[data-pyric-storage-entry][data-pyric-denied-reason]   /* …with the evaluator trace */
[data-pyric-entry-select]                              /* the row button */
[data-pyric-entry-select][data-pyric-selected]
```
## Notes

- **`listAll` has no pagination** — a big prefix arrives as one flat result; virtualization is the defense, which is why the threshold mechanics mirror `<DocumentList>`.
- **Folder rows never fire `onSelect`** and object rows never fire `onNavigate` — the kind decides the verb. A folder "selection" concept (e.g. for bulk delete) arrives with the selection hook in a later milestone.
- **`renderEntry` runs per row** — keep it cheap.
- **Denied rows stay clickable** — the gate stamp is an early warning, not a block; clicking a denied folder surfaces the real `storage/unauthorized` through the `error` prop path. On prod handles verdicts are advisory (see [rules-aware affordances](../ui-storage-rules-aware-affordances/)).

## See also

- [`<PathBreadcrumb>`](../ui-storage-pathbreadcrumb/) — the ancestor trail above the browser.
- [`<VirtualList>`](../ui-primitives-virtuallist/) — the underlying virtualizer.
- [Rules-aware affordances](../ui-storage-rules-aware-affordances/) + [`useStorageRulesGate`](../ui-storage-usestoragerulesgate/) — the `gate` prop's source.
- `useStorageList`, `usePathState` — data + navigation sources.
