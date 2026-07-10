---
title: "<RuleHeatmap>"
group: "@pyric/ui"
section: "Traffic"
order: 179
---
# `<RuleHeatmap>`

Per-rule fire / deny rollup — one row per rule, busiest first. Pairs with
`useRuleHeatmap`, which does the aggregation.
```ts
import { RuleHeatmap, useRuleHeatmap } from '@pyric/ui/traffic';
```
## Example
```tsx
const { entries } = useRuleHeatmap({ events: monitor.events });

<RuleHeatmap
  entries={entries}
  selectedRuleIndex={selectedRule ?? undefined}
  onSelectRule={(i) => setSelectedRule((cur) => (cur === i ? null : i))}
/>
```
Wire `onSelectRule` to your log filter for the cross-view "click a rule, see
its traffic" interaction — the showcase narrows the event list to
`matchedRule.ruleIndex === selectedRule` before the origin/result filter runs.

## Props

| Prop | Type | Required | Description |
|---|---|---|---|
| `entries` | `RuleHeatmapEntry[]` | yes | From `useRuleHeatmap`. |
| `selectedRuleIndex` | `number` | no | Marks one row with `data-pyric-selected`. |
| `onSelectRule` | `(ruleIndex) => void` | no | Fired on row click. |
| `emptyState` | `ReactNode` | no | Rendered when there are no entries. |
| `className` | `string` | no | Forwarded to the root. |

## Two styling channels for "heat"

Each row exposes the deny intensity two ways — use whichever fits:

- **`data-pyric-rule-heat`** — a discrete bucket (`none` / `low` / `medium` /
  `high`) for threshold-based coloring.
- **`--pyric-deny-ratio`** — the raw 0–1 ratio as a CSS custom property, for a
  proportional bar or gradient (`[data-pyric-rule-bar]` is provided as the
  target element).

## Styling hooks
```
[data-pyric-ui="rule-heatmap"]
[data-pyric-rule-row]                  /* + data-pyric-rule-index / -heat, data-pyric-selected */
[data-pyric-rule-label]                /* "#N" */
[data-pyric-rule-operations]
[data-pyric-rule-total] / -allows / -denies
[data-pyric-rule-bar]                  /* read --pyric-deny-ratio off the row */
```
## Notes

- Events with no `matchedRule` aren't attributed to any row — `useRuleHeatmap`
  reports them as `unmatchedCount`.
