# `<ToastProvider>` + `useToast`

Imperative toast queue. One `<ToastProvider>` per scope; any descendant calls `useToast()` to push toasts. Renders to `document.body` via portal.

```ts
import { ToastProvider, useToast } from '@pyric/ui/primitives';
```

## Example

```tsx
function App() {
  return (
    <ToastProvider>
      <Inner />
    </ToastProvider>
  );
}

function Inner() {
  const { toast } = useToast();
  const handleSave = async () => {
    try {
      await setDoc(ref, data);
      toast({ title: 'Saved.', kind: 'success' });
    } catch (e) {
      toast({
        title: 'Save failed',
        body: e instanceof Error ? e.message : String(e),
        kind: 'error',
        duration: 0, // sticky
      });
    }
  };
  return <button onClick={handleSave}>Save</button>;
}
```

## `<ToastProvider>` props

| Prop | Type | Default | Description |
|---|---|---|---|
| `defaultDuration` | `number` | `5000` | Per-toast `duration` override falls back to this. Pass `0` to default to sticky. |
| `className` | `string` | — | Forwarded to the portaled `<ol>` container. |
| `regionLabel` | `string` | `"Notifications"` | `aria-label` on the container. |

## `useToast` API

```ts
const { toast, dismiss, toasts } = useToast();

toast({
  title: 'Permission denied',
  body: 'rules deny write to users/alice',
  kind: 'error',          // 'info' | 'success' | 'warning' | 'error'
  duration: 0,            // ms; 0 = sticky
}): string;               // returns the toast id

dismiss(id: string): void;
toasts: ReadonlyArray<ToastRecord>;
```

Throws if called without a `<ToastProvider>` ancestor.

## Styling hooks

```
[data-pyric-ui="toast-region"]
[data-pyric-toast]
[data-pyric-toast][data-pyric-toast-kind="info" | "success" | "warning" | "error"]
[data-pyric-toast-title]
[data-pyric-toast-body]
[data-pyric-toast-dismiss]
```

Error toasts get `role="alert"`; others get `role="status"`. The container is `aria-live="polite"`.

## Notes

- **Per-toast auto-dismiss timers.** Timers start when the toast is added and fire independently. Dismissing a toast manually before its timer fires is a no-op — the timer's `dismiss` becomes idempotent.
- **Multiple providers.** Each provider has its own queue. Use this to isolate toast streams (e.g. one for the workspace, one for the agent panel) if the UX calls for it.
- **Sticky errors** for permission-denied / network failures — pass `duration: 0` so the user can read and dismiss when ready.
