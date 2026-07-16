---
title: "<Badge>"
group: "@pyric/ui"
section: "Primitives"
order: 23002
---
# `<Badge>`

Headless pill / tag. An inline `<span>` carrying `data-pyric-badge` and an
optional `data-pyric-badge-kind` so consumers style categories with attribute
selectors.

```ts
import { Badge } from '@pyric/ui/primitives';
```

## Example

```tsx
<Badge kind="deny">DENY</Badge>
<Badge kind="get">GET</Badge>
// Terse glyph with a spoken label:
<Badge kind="deny" ariaLabel="denied">✕</Badge>
```

## Props

| Prop | Type | Required | Description |
|---|---|---|---|
| `children` | `ReactNode` | yes | Badge content. |
| `kind` | `string` | no | Freeform category → `data-pyric-badge-kind`. The library doesn't enumerate kinds. |
| `ariaLabel` | `string` | no | When set, the visible glyph becomes `aria-hidden` and screen readers announce this instead. |
| `className` | `string` | no | Forwarded to the `<span>`. |

## Styling hooks

```
[data-pyric-badge]
[data-pyric-badge-kind="allow"]
[data-pyric-badge-kind="deny"]
```

## Notes

- Ships no visual styling — not even `display`. A bare `<Badge>` is an inline
  span until you style it.
