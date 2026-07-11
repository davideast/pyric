---
title: "<JsonView>"
group: "@pyric/ui"
section: "Primitives"
order: 24005
---
# `<JsonView>`

Headless collapsible JSON tree — one structural step above a `<pre>` dump.
Object/array nodes are independently expandable; there's no editing and no
syntax-color theme, just `data-pyric-*` hooks.
```ts
import { JsonView } from '@pyric/ui/primitives';
```
## Example
```tsx
<JsonView value={{ uid: 'alice', roles: ['admin', 'beta'] }} />

// Collapse everything below the root on first render:
<JsonView value={largePayload} defaultCollapsedDepth={1} />
```
## Props

| Prop | Type | Required | Description |
|---|---|---|---|
| `value` | `unknown` | yes | Any JSON-serializable value. |
| `defaultCollapsedDepth` | `number` | no | Depth at/below which containers start collapsed. `0` collapses the root; default `Infinity` (all expanded). |
| `className` | `string` | no | Forwarded to the root. |

## Styling hooks
```
[data-pyric-ui="json-view"]              /* root */
[data-pyric-json-node]                   /* every node, + data-pyric-json-type */
[data-pyric-json-toggle]                 /* expand/collapse button (containers) */
[data-pyric-json-node][data-pyric-collapsed]
[data-pyric-json-key]                    /* key / index label */
[data-pyric-json-value]                  /* a primitive value */
[data-pyric-json-summary]                /* the {…} / […] placeholder when collapsed */
[data-pyric-json-children]               /* the expanded children wrapper */
```
## Notes

- `data-pyric-json-type` is one of `object` / `array` / `string` / `number` /
  `boolean` / `null` — style value colors per type.
- Strings render `JSON.stringify`'d (quoted); `null` and `undefined` both
  render as `null`.
- Not a JSON editor — read-only by design.
