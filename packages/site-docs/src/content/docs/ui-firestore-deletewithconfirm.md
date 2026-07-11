---
title: "<DeleteWithConfirm>"
group: "@pyric/ui"
section: "Firestore"
order: 24010
---
# `<DeleteWithConfirm>`

Composition of [`useConfirm`](../ui-primitives-confirmdialog/) + `useRecursiveDelete` for safe deletion of a document or collection with progress tracking.
```ts
import { DeleteWithConfirm } from '@pyric/ui/firestore';
```
## Example
```tsx
import {
  DeleteWithConfirm,
  type RecursiveDeleteImpl,
} from '@pyric/ui/firestore';
import { ConfirmProvider } from '@pyric/ui/primitives';

// Consumer supplies the impl. Sandbox apps walk the in-process
// tree; production apps usually call a Cloud Function.
const sandboxImpl: RecursiveDeleteImpl = {
  async *start(target) {
    // ... your tree-walk + deleteDoc loop
    yield { deletedCount: 1, done: true };
  },
};

function DocRow({ ref }) {
  return (
    <ConfirmProvider>
      <DeleteWithConfirm
        target={ref}
        impl={sandboxImpl}
        title="Delete document?"
        body="This will remove the document and all its subcollections."
        onDeleted={() => router.replace('/collection-list')}
      />
    </ConfirmProvider>
  );
}
```
## Props

| Prop | Type | Required | Description |
|---|---|---|---|
| `target` | `DocumentReference \| CollectionReference` | yes | What to delete. |
| `impl` | `RecursiveDeleteImpl` | yes | Consumer-supplied async-iterator impl. |
| `title` | `string` | no | Confirm dialog title. Defaults to `Delete ${target.path}?`. |
| `body` | `ReactNode` | no | Confirm dialog body. |
| `confirmLabel` | `string` | no | Default `"Delete"`. |
| `onDeleted` | `() => void` | no | Fired after the iterator's `done` signal, only on success. |
| `renderTrigger` | `({ onClick, isRunning, progress }) => ReactNode` | no | Custom trigger renderer. Default is a destructive `<button>`. |
| `className` | `string` | no | Forwarded to the default trigger. |

## `RecursiveDeleteImpl`
```ts
interface RecursiveDeleteImpl {
  start: (target: DocumentReference | CollectionReference)
    => AsyncIterableIterator<{ deletedCount: number; done: boolean }>;
}
```
Yield progress events as you delete. The final yield must have `done: true`. The hook tracks `deletedCount` from the most recent event and exposes it via `progress`.

Two common implementations:

- **Sandbox** — walk `pyric/sandbox`'s in-process tree, calling `deleteDoc` per path; yield after each.
- **Production** — invoke a Cloud Function that performs the recursive delete server-side; yield from the function's response (HTTP streaming or chunked progress events).

The library doesn't ship either — they're consumer-specific.

## Direct hook access
```tsx
import { useRecursiveDelete } from '@pyric/ui/firestore/hooks';

const { delete: runDelete, progress, isRunning, error } = useRecursiveDelete(impl);

await runDelete(target);  // resolves on completion; errors land on `error`, not thrown
```
Use the hook directly for richer UIs (a progress bar, a Cancel button, etc.).

## Styling hooks
```
[data-pyric-ui="delete-with-confirm"]
[data-pyric-ui="delete-with-confirm"][data-pyric-destructive]
[data-pyric-ui="delete-with-confirm"][data-pyric-running]
```
(Plus the [`<ConfirmDialog>` selectors](../ui-primitives-confirmdialog/#styling-hooks).)

## Notes

- **Requires `<ConfirmProvider>`** in an ancestor. Throws on click otherwise.
- **Stale-run protection.** If the component remounts (or you start a second delete) before a previous iteration finishes, the older run's progress events are dropped via a generation token.
- **Errors don't throw.** The async iterator's failures land in the hook's `error` state. `<DeleteWithConfirm>` skips `onDeleted` when `error` is set; consumers wanting to surface the error should pair with `useToast()`.

## See also

- [`ConfirmDialog`](../ui-primitives-confirmdialog/) — the confirm primitive.
- `useRecursiveDelete`, `useConfirm` — the hooks this composes.
