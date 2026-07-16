# `<ConfirmDialog>` + `useConfirm`

Headless confirmation dialog. Two ways to use:

- **Controlled** — `<ConfirmDialog open onOpenChange title onConfirm>`. You hold the open state.
- **Imperative** — wrap your app in `<ConfirmProvider>` and call `useConfirm()` from anywhere; the returned function opens the dialog and resolves to `Promise<boolean>`.

```ts
import {
  ConfirmDialog,
  ConfirmProvider,
  useConfirm,
} from '@pyric/ui/primitives';
```

## Imperative (recommended)

```tsx
function App() {
  return (
    <ConfirmProvider>
      <Inner />
    </ConfirmProvider>
  );
}

function Inner() {
  const confirm = useConfirm();
  const handleDelete = async () => {
    const ok = await confirm({
      title: 'Delete users/alice?',
      body: 'This cannot be undone.',
      destructive: true,
      confirmLabel: 'Delete',
    });
    if (ok) await deleteDoc(ref);
  };
  return <button onClick={handleDelete}>Delete</button>;
}
```

## Controlled

```tsx
const [open, setOpen] = useState(false);

<ConfirmDialog
  open={open}
  onOpenChange={setOpen}
  title="Apply changes?"
  body="The document will be saved with your latest edits."
  onConfirm={() => {
    save();
    setOpen(false);
  }}
/>
```

The dialog does **not** auto-close on confirm — `onConfirm` runs your action and you dismiss when ready. This lets you keep the dialog open while a slow operation completes and dismiss on success.

## `<ConfirmDialog>` props

| Prop | Type | Required | Description |
|---|---|---|---|
| `open` | `boolean` | yes | Controlled open state. |
| `onOpenChange` | `(open: boolean) => void` | yes | Fires on Escape, overlay click, or cancel button. NOT fired by `onConfirm`. |
| `title` | `string` | yes | Heading. Announced as `aria-labelledby`. |
| `body` | `ReactNode` | no | Optional content. Announced as `aria-describedby`. |
| `destructive` | `boolean` | no | Adds `data-pyric-destructive` to the confirm button + content node. |
| `confirmLabel` | `string` | no | Default `"Confirm"`. |
| `cancelLabel` | `string` | no | Default `"Cancel"`. |
| `onConfirm` | `() => void` | yes | Fired when the confirm button is clicked. |
| `className` | `string` | no | Forwarded to the content node. |

## `useConfirm` API

```ts
const confirm: (options: {
  title: string;
  body?: ReactNode;
  destructive?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
}) => Promise<boolean>;
```

Resolves to `true` on confirm, `false` on cancel / Escape / overlay click. Throws if called without a `<ConfirmProvider>` ancestor.

## Styling hooks

```
[data-pyric-ui="confirm-portal"]
[data-pyric-ui="confirm-overlay"]
[data-pyric-ui="confirm-dialog"]
[data-pyric-ui="confirm-dialog"][data-pyric-destructive]
[data-pyric-confirm-title]
[data-pyric-confirm-body]
[data-pyric-confirm-actions]
[data-pyric-confirm-cancel]
[data-pyric-confirm-confirm]
[data-pyric-confirm-confirm][data-pyric-destructive]
```

## Notes

- **Hand-rolled, not Radix.** Initial M4 implementation tried Radix Dialog; Radix's Presence + Portal stack doesn't render under our bun:test + JSDOM env even with `forceMount`. The hand-rolled component provides focus trap, Escape, overlay click, ARIA wiring, and focus restoration in ~110 lines.
- **Multiple providers are fine.** Each `<ConfirmProvider>` manages its own dialog; nested providers are scoped to their subtree.
- **Initial focus** goes to the confirm button. If you want Cancel as the safer default, focus a different element in your own `onConfirm` opening effect.
