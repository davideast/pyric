---
title: "<TrafficDetail>"
group: "@pyric/ui"
section: "Traffic"
order: 199
---
# `<TrafficDetail>`

The drill-in panel for one traffic event — header, a consumer classification
slot, then JSON sections for auth / request / resource before+after, the
reasons list, `triggeredBy`, and `groupId`.
```ts
import { TrafficDetail } from '@pyric/ui/traffic';
```
## Example
```tsx
<TrafficDetail
  event={selectedEvent}
  onBack={() => setSelectedId(null)}
  renderClassification={(e) =>
    e.result === 'deny' ? <DenialOverlay event={e} /> : null
  }
/>
```
## Props

| Prop | Type | Required | Description |
|---|---|---|---|
| `event` | `TrafficEvent` | yes | The event to render. |
| `onBack` | `() => void` | no | When set, renders a back affordance. |
| `renderClassification` | `(event) => ReactNode` | no | Slot below the header — the playground drops its denial overlay (classification + LLM analysis) here. |
| `formatTime` | `(at: number) => string` | no | Override timestamp formatting. |
| `className` | `string` | no | Forwarded to the root. |

## Sections

`AUTH` always renders. `REQUEST · resource.data`, `RESOURCE BEFORE`, and
`RESOURCE AFTER` render only when the event carries them (writes, not reads).
`REASONS`, `TRIGGERED BY`, and `GROUP` render when present. JSON renders via
[`<JsonView>`](../ui-primitives-jsonview/).

## Styling hooks
```
[data-pyric-ui="traffic-detail"]
[data-pyric-traffic-detail-header] / -meta / -title
[data-pyric-traffic-back]
[data-pyric-traffic-matched-rule]
[data-pyric-traffic-section]                     /* + data-pyric-section-label */
[data-pyric-section-heading]
[data-pyric-traffic-reason]                      /* + data-pyric-reason-verdict="deny|allow|neutral" */
[data-pyric-traffic-eval-ms]
[data-pyric-traffic-triggered-by] / [data-pyric-traffic-group]
```
## Notes

- `evalMs` appears here as a minor header field — it is not a log column
  (local simulator; latency is de-featured).
- Each reason line is classified `deny` / `allow` / `neutral` via
  `data-pyric-reason-verdict` so you can tint them without parsing the string.
