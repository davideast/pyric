---
title: "<DeleteSelectionWithConfirm>"
group: "@pyric/ui"
section: "Storage"
order: 160
---
# `<DeleteSelectionWithConfirm>`

Bulk + recursive delete behind the confirm-dialog primitive, with **toasts on outcome** — the storage counterpart of the Firestore half's `<DeleteWithConfirm>`. Objects delete via `deleteObject`; folders walk recursively (default impl: `listAll`-driven, including the create-folder placeholder sweep). Requires `<ConfirmProvider>` **and** `<ToastProvider>` ancestors.
```ts
import { DeleteSelectionWithConfirm } from '@pyric/ui/storage';
```
## Example
```tsx
import { useStorageList, useStorageSelection } from '@pyric/ui/storage/hooks';

function Toolbar({ storage, path }) {
  const list = useStorageList(storage, path);
  const selection = useStorageSelection();

  return (
    <>
      {/* rows toggle selection.toggle(entry) — see useStorageSelection */}
      <DeleteSelectionWithConfirm
        storage={storage}
        entries={selection.selected}
        list={list} // optimistic removal + kind-correct rollback
        onDeleted={() => {
          selection.clear();
          list.refresh();
        }}
      />
    </>
  );
}
```
## Props

| Prop | Type | Description |
|---|---|---|
| `storage` | `FirebaseStorage` | The single Storage handle prop. |
| `entries` | `StorageSelectionEntry[]` | `{kind, fullPath}` rows — `useStorageSelection().selected` or any `StorageListEntry`s. Folders delete recursively. |
| `impl` | `StorageRecursiveDeleteImpl` | Folder-walk override (e.g. a server-driven delete). Default: `createListAllDeleteImpl()`. |
| `list` | `{ insertItem, removeItem }` | `useStorageList`'s optimistic seam. |
| `gate` | `Pick<UseStorageRulesGateResult, 'verdictFor'>` | Pass `useStorageRulesGate(storage)` — when ANY selected entry's DELETE verdict denies, the trigger disables with the reason. See [rules-aware affordances](./rules-aware-affordances.md). |
| `title` / `body` | `string` / `ReactNode` | Dialog copy. Defaults: count-derived title, path list body. |
| `confirmLabel` | `string` | Default `'Delete'`. |
| `onDeleted` | `(outcome) => void` | Fired after a run with NO failures. |
| `onFailed` | `(outcome) => void` | Fired after a run with failures (the error toast already showed). |
| `renderTrigger` | `({ onClick, isRunning, progress, disabled, deniedReason }) => ReactNode` | Trigger override. `deniedReason` is set when the rules gate denied the selection. |
| `className` | `string` | Forwarded to the default trigger. |

## Styling hooks
```
[data-pyric-ui="delete-selection"]                       /* default trigger */
[data-pyric-ui="delete-selection"][data-pyric-destructive]
[data-pyric-ui="delete-selection"][data-pyric-running]
[data-pyric-ui="delete-selection"][data-pyric-denied]    /* rules gate denied */
[data-pyric-ui="delete-selection"][data-pyric-denied-reason]  /* …why (also on title) */
[data-pyric-delete-selection-paths]                      /* default dialog body */
[data-pyric-delete-selection-failures]                   /* error-toast body */
```
(The dialog and toasts style via the primitives' own hooks —
`[data-pyric-ui="confirm-dialog"]`, `[data-pyric-toast]`.)

## Notes

- **Outcome toasts are typed-code-driven**: the error toast lists each
  failed path with its `StorageError.code` (`storage/unauthorized`, …) —
  rules denials read as rules denials, not generic failures.
- **Partial failures don't abort the batch** — every entry is attempted;
  failures roll their optimistic removal back (objects re-insert as items,
  folders as prefixes) and collect into the outcome.
- **The gate check is per-entry and pre-flight** — folder entries evaluate
  the folder path itself (an approximation of the recursive walk; exact
  under `{allPaths=**}`-shaped rules). A denial surfaces through the normal
  typed-code error toast.
- **The recursive default sweeps `<path>/` placeholders** after the walk, so
  folders created via `createFolder` actually disappear (`listAll` hides
  placeholders — without the sweep they'd ghost as empty prefixes).
- Headless alternative: `useStorageDelete` + `useConfirm` + `useToast`
  directly when the composition's shape doesn't fit.

## See also

- `useStorageSelection`, `useStorageDelete` — the hooks underneath.
- [`<ConfirmDialog>`](../primitives/ConfirmDialog.md),
  [`<Toast>`](../primitives/Toast.md) — the primitives.
