---
title: "<SegmentedControl>"
group: "@pyric/ui"
section: "Primitives"
order: 24006
---
# `<SegmentedControl>`

Headless single-select chip group — reads as one widget, wired as an ARIA
radiogroup.

```ts
import { SegmentedControl } from '@pyric/ui/primitives';
```

## Example

```tsx
<SegmentedControl
  ariaLabel="Result filter"
  options={[
    { value: 'all', label: 'all' },
    { value: 'deny', label: 'denied', tone: 'error' },
    { value: 'allow', label: 'allowed', tone: 'ok' },
  ]}
  value={result}
  onChange={setResult}
/>
```

## Props

| Prop | Type | Required | Description |
|---|---|---|---|
| `options` | `SegmentedOption<T>[]` | yes | `{ value, label, tone? }` — rendered left-to-right. |
| `value` | `T` | yes | The selected value. |
| `onChange` | `(value: T) => void` | yes | Fired with the clicked value. |
| `ariaLabel` | `string` | no | Label for the radiogroup. |
| `className` | `string` | no | Forwarded to the container. |

`tone` is a freeform string surfaced as `data-pyric-segment-tone` — e.g. `ok`
/ `error` to tint the active label. The library doesn't enumerate tones.

## Styling hooks

```
[data-pyric-ui="segmented-control"]              /* container */
[data-pyric-segment]                             /* each option button */
[data-pyric-segment][data-pyric-active]          /* the selected one */
[data-pyric-segment-tone="error"]                /* tone-tinted options */
```

## Notes

- Type-parameterized — `SegmentedControl<MyUnion>` keeps `value` / `onChange`
  narrowed to your union.
