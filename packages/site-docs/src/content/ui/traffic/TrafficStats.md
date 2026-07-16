# `<TrafficStats>`

The aggregation panel — totals, deny rate, and count breakdowns by method /
origin / path. Pairs with `useTrafficStats`.

```ts
import { TrafficStats, useTrafficStats } from '@pyric/ui/traffic';
```

## Example

```tsx
const stats = useTrafficStats({ events: filtered, topPaths: 10 });

<TrafficStats stats={stats} />
```

Feed it the filtered or full event list depending on what the panel should
reflect — it's pure derivation either way.

## Props

| Prop | Type | Required | Description |
|---|---|---|---|
| `stats` | `TrafficStatsSummary` | yes | From `useTrafficStats`. |
| `className` | `string` | no | Forwarded to the root. |

## Styling hooks

```
[data-pyric-ui="traffic-stats"]          /* root; carries --pyric-deny-rate */
[data-pyric-stat-totals]
[data-pyric-stat]                        /* + data-pyric-stat-key="total|allows|denies|deny-rate" */
[data-pyric-stat-label] / [data-pyric-stat-value]
[data-pyric-stat-group]                  /* + data-pyric-stat-group-label="method|origin|path" */
[data-pyric-stat-group-heading]
[data-pyric-stat-bucket]                 /* + data-pyric-stat-key */
[data-pyric-stat-bucket-label] / [data-pyric-stat-bucket-count]
```

## Notes

- The deny rate is exposed twice — as a `%` text value and as the
  `--pyric-deny-rate` custom property on the root, for a proportional meter.
- `byPath` is capped at `topPaths` (default 10); `byMethod` and `byOrigin` are
  uncapped (bounded domains).
