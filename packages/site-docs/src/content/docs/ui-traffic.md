---
title: "@pyric/ui/traffic"
group: "@pyric/ui"
section: "Traffic"
order: 213
---
# `@pyric/ui/traffic`

Headless components + hooks for observing rule-eval traffic — a Chrome
DevTools Network-panel-style **log** and a per-rule **heatmap**, plus stats
and grouping. Decoupled from `pyric/sandbox`: the data hook takes a `source`
function, so the same components work against the sandbox or a production
log feed.
```ts
import {
  useTrafficMonitor,
  useTrafficFilter,
  useRuleHeatmap,
  useTrafficStats,
  useTrafficGroups,
  TrafficLog,
  TrafficRow,
  TrafficGroupRow,
  TrafficDetail,
  RuleHeatmap,
  TrafficStats,
  type TrafficEvent,
  type TrafficSource,
} from '@pyric/ui/traffic';
```
## The decoupling contract
```ts
type TrafficSource = (cb: (event: TrafficEvent) => void) => () => void;
```
`pyric/sandbox`'s `Sandbox.onRequest` matches this signature exactly —
`useTrafficMonitor({ source: sandbox.onRequest })` wires with zero adapter
code. `TrafficEvent` is structurally identical to the sandbox's `RequestEvent`
but the library owns its own copy so it never imports `pyric/sandbox`.

## Components

- [TrafficLog](../ui-traffic-trafficlog/) — the event stream; virtualized flat list,
  or singles + collapsible groups in grouped mode.
- [TrafficDetail](../ui-traffic-trafficdetail/) — drill-in panel for one event.
- [RuleHeatmap](../ui-traffic-ruleheatmap/) — per-rule fire / deny rollup.
- [TrafficStats](../ui-traffic-trafficstats/) — totals + breakdowns.

## Hooks

Hook docs live in the source JSDoc — every hook has an options interface and a
return-shape interface commented per field. Summary:

- **`useTrafficMonitor({ source, bufferSize?, paused?, transform? })`** — the
  core. A capped ring buffer (default 5000) with `pause` / `resume` / `clear`
  and derived `counts`. `transform` runs per event before buffering, for
  consumer-side payload shrinking.
- **`useTrafficFilter({ events })`** — filters along origin / result / path.
  Defaults to **user-origin, allow+deny visible, listener hidden** — the probe
  found listener traffic is 94–99.6% of events.
- **`useRuleHeatmap({ events })`** — rolls events up by
  `matchedRule.ruleIndex`: per-rule total / allow / deny counts + deny ratio.
- **`useTrafficStats({ events, topPaths? })`** — totals, deny rate, and count
  breakdowns by method / origin / path.
- **`useTrafficGroups({ events })`** — folds the buffer into singles +
  collapsible groups: `groupId` batches/transactions, and consecutive
  listener-run aggregation.

## Minimal wiring
```tsx
function TrafficPanel({ sandbox }) {
  const monitor = useTrafficMonitor({ source: sandbox.onRequest });
  const { filtered, filter, setOrigin, setResult, setPathQuery } =
    useTrafficFilter({ events: monitor.events });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = monitor.events.find((e) => e.id === selectedId);

  return selected ? (
    <TrafficDetail event={selected} onBack={() => setSelectedId(null)} />
  ) : (
    <TrafficLog
      events={[...filtered].reverse()}
      selectedId={selectedId ?? undefined}
      onSelect={(e) => setSelectedId(e.id)}
    />
  );
}
```
## Notes

- **Latency is de-featured.** `evalMs` stays on `TrafficEvent` and shows in
  `TrafficDetail`, but it is not a log column — this is a local simulator.
- **Classification is the consumer's.** `expected` / `ambiguous` /
  `unexpected` verdicts are app-source analysis, not sandbox data. Components
  expose a `renderClassification` render-prop slot for it.

## See also

- design rationale — the milestone roadmap.
- design rationale — the sandbox
  `onRequest` API and the empirical probe findings this builds on.
- Live showcase — the "Traffic
  Monitor" route.
