# `<TrafficLog>` · `<TrafficRow>` · `<TrafficGroupRow>`

The event stream — a Chrome DevTools Network-panel-style list. Below 100 rows
it's a plain `<ul>`; above, it virtualizes via `<VirtualList>`. Pass `items`
(from `useTrafficGroups`) instead of `events` for collapsible group rows.

```ts
import { TrafficLog, TrafficRow, TrafficGroupRow } from '@pyric/ui/traffic';
```

## Example

```tsx
// Flat, virtualized:
<TrafficLog
  events={[...filtered].reverse()}
  selectedId={selectedId}
  onSelect={(e) => setSelectedId(e.id)}
  renderClassification={(e) =>
    e.result === 'deny' ? <Badge kind="ambiguous">ambiguous</Badge> : null
  }
/>

// Grouped — batches + listener runs collapsed:
const { items } = useTrafficGroups({ events: ordered });
<TrafficLog events={[]} items={items} onSelect={openDetail} />
```

## `<TrafficLog>` props

| Prop | Type | Required | Description |
|---|---|---|---|
| `events` | `TrafficEvent[]` | yes | Events in display order. |
| `items` | `TrafficLogItem[]` | no | Grouped items from `useTrafficGroups`. When set, renders singles + group rows and **skips virtualization** (grouping is itself the volume reducer); `events` is ignored. |
| `selectedId` | `string` | no | Marks the active row with `data-pyric-selected`. |
| `onSelect` | `(event) => void` | no | Fired on row click. |
| `renderClassification` | `(event) => ReactNode` | no | Render-prop slot for a consumer verdict badge. |
| `formatTime` | `(at: number) => string` | no | Override timestamp formatting. Default `HH:MM:SS`. |
| `renderRow` | `(event, selected) => ReactNode` | no | Full row escape hatch (flat mode only). |
| `emptyState` | `ReactNode` | no | Rendered when there are no events/items. |
| `virtualizeThreshold` | `number` | no | Default 100. |
| `rowHeight` | `number \| (i) => number` | no | Default 28. |
| `virtualizedHeight` | `number \| string` | no | Default `'60vh'`. |

`<TrafficRow>` and `<TrafficGroupRow>` are exported for consumers building
their own list — see their source JSDoc for props.

## Styling hooks

```
[data-pyric-ui="traffic-log"]                    /* root */
[data-pyric-ui="traffic-log"][data-pyric-grouped]
[data-pyric-traffic-entry]                       /* list-item wrapper */
[data-pyric-traffic-row]                         /* + data-pyric-result / -origin / -method */
[data-pyric-traffic-row][data-pyric-selected]
[data-pyric-traffic-time] / [data-pyric-traffic-path]
[data-pyric-traffic-group] / [data-pyric-traffic-group-header]   /* + data-pyric-group-kind */
[data-pyric-traffic-group][data-pyric-expanded]
[data-pyric-traffic-group-members]
```

Method + result render as [`<Badge>`](../primitives/Badge.md) — style via
`[data-pyric-badge-kind="…"]`.

## Notes

- **No latency column** — `evalMs` lives in `<TrafficDetail>` only.
- Grouped mode collapses a 250-event listener storm into one group row, which
  is why it doesn't need virtualization.
