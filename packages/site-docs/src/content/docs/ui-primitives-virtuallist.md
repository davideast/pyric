---
title: "<VirtualList>"
group: "@pyric/ui"
section: "Primitives"
order: 23008
---
# `<VirtualList>`

Thin wrapper around [`@tanstack/react-virtual`](https://tanstack.com/virtual). Renders a scrollable container with absolutely-positioned rows; only the rows in view (plus `overscan` neighbors) mount to the DOM.
```ts
import { VirtualList } from '@pyric/ui/primitives';
```
## Example
```tsx
<VirtualList<Row>
  items={rows}
  estimateSize={36}
  height={480}
  getItemKey={(row) => row.id}
  renderItem={(row, i) => (
    <div className={i % 2 ? 'bg-gray-50' : ''}>
      {row.name}
    </div>
  )}
/>
```
## Props

| Prop | Type | Required | Description |
|---|---|---|---|
| `items` | `ReadonlyArray<T>` | yes | Row data. Generic over `T`. |
| `estimateSize` | `number \| (i: number) => number` | yes | Estimated row height in px. The virtualizer measures actual heights after first paint via ResizeObserver — this is the pre-measurement guess. |
| `renderItem` | `(item: T, i: number) => ReactNode` | yes | Renders one row. Positioning is handled by the wrapper. |
| `overscan` | `number` | no | Off-screen rows rendered on each side. Default `5`. |
| `height` | `number \| string` | no | Scroll-container height. Default `"100%"`. |
| `getItemKey` | `(item: T, i: number) => string \| number` | no | Stable key. Defaults to the virtualizer's index-based key. Use when rows reorder. |
| `className` | `string` | no | Forwarded to the scroll container. |

## Styling hooks
```
[data-pyric-ui="virtual-list"]      /* scroll container */
[data-pyric-virtual-inner]          /* total-height spacer */
[data-pyric-virtual-row]            /* each rendered row */
[data-pyric-virtual-row][data-index="42"]  /* specific row */
```
## Notes

- **Height must be constrained.** The scroll container fills its parent via `height` (default `100%`). If the parent's height is unbounded, nothing scrolls and the virtualizer renders everything — defeating the point. Either set `height` explicitly or constrain via CSS.
- **`contain: strict`** is applied to the scroll element so the browser can skip paint cost for off-screen rows even before virtualizer culling.
- **`<DocumentList>` uses this internally** above `virtualizeThreshold` (default 100 docs). Most consumers don't need to instantiate `<VirtualList>` directly — only when wrapping a non-Firestore list.

## See also

- [`<DocumentList>`](../ui-firestore-documentlist/) — virtualizes above a threshold using this primitive.
