---
title: "<CopyButton>"
group: "@pyric/ui"
section: "Primitives"
order: 40
---
# `<CopyButton>`

Clipboard button that exposes a `data-copied` attribute on the underlying `<button>` so consumers can style the success state. Ships no visual treatment of its own.

```ts
import { CopyButton } from '@pyric/ui/primitives';
```

## Example

```tsx
<CopyButton text="users/alice" className="my-btn" />
```

Style the success state with an attribute selector:

```css
.my-btn[data-copied] {
  background: var(--success-bg);
  color: var(--success-fg);
}
```

## Props

| Prop | Type | Required | Description |
|---|---|---|---|
| `text` | `string` | yes | The value written to the clipboard on click. |
| `children` | `ReactNode` | no | Content inside the button. Defaults to `"Copy"` / `"Copied"` based on state. |
| `resetMs` | `number` | no | Milliseconds before `data-copied` clears. Default `2000`. |
| `className` | `string` | no | Forwarded to the underlying `<button>`. |
| `ariaLabel` | `string` | no | Accessible label in the idle state. Default `"Copy to clipboard"`. The copied state always uses `"Copied"`. |

## Notes

- **Clipboard failures are silent.** If `navigator.clipboard.writeText` rejects (insecure context, permission denied), the button does not flip to the copied state and no error is surfaced. Wrap in a toast at the call site if you want feedback.
- **`children` ignored in default render path** — when you don't pass `children`, the button shows `"Copy"` or `"Copied"` based on state. Pass your own node (`<span className="material-symbols">…</span>`, etc.) to render anything.
