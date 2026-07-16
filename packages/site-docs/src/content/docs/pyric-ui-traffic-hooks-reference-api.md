---
title: "API reference: @pyric/ui/traffic/hooks"
navLabel: "@pyric/ui/traffic/hooks"
group: "API reference"
section: "@pyric/ui"
order: 24048
description: "Published declarations for @pyric/ui/traffic/hooks."
kind: "api"
apiPackage: "@pyric/ui"
apiImportPath: "@pyric/ui/traffic/hooks"
apiSubpath: "traffic/hooks"
apiSymbolCount: 46
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Interfaces

<a id="metricpoint"></a>

### MetricPoint

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="end"></a> `end` | `number` | - |
| <a id="index"></a> `index` | `number` | 0-based bucket index, left (oldest) to right (newest). |
| <a id="start"></a> `start` | `number` | Half-open bounds of this bucket `[start, end)` in epoch-ms. |

***

<a id="metricseries"></a>

### MetricSeries

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="key"></a> `key` | `string` | - |
| <a id="label"></a> `label` | `string` | - |
| <a id="total"></a> `total` | `number` | Sum of `values` — the period total (the legend/card number). |
| <a id="values"></a> `values` | `number`[] | One count per bucket, aligned with `points`. |

***

<a id="ruleheatmapentry"></a>

### RuleHeatmapEntry

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="allows"></a> `allows` | `number` | - |
| <a id="denies"></a> `denies` | `number` | - |
| <a id="denyratio"></a> `denyRatio` | `number` | `denies / total` — 0 when the rule never denied. |
| <a id="operations"></a> `operations` | `string`[] | Union of all operations seen matching this rule. |
| <a id="ruleindex"></a> `ruleIndex` | `number` | The rule's index in the rules file. |
| <a id="total-1"></a> `total` | `number` | Total events that matched this rule. |
| <a id="unsupported"></a> `unsupported` | `number` | - |

***

<a id="timewindow"></a>

### TimeWindow

A half-open time window `[start, end)` in epoch-ms. The timeline
buckets events whose `at` falls inside it; events outside are
dropped from the histogram (but still counted in `outOfWindow`).

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="end-1"></a> `end` | `number` |
| <a id="start-1"></a> `start` | `number` |

***

<a id="trafficbucket"></a>

### TrafficBucket

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="allows-1"></a> `allows` | `number` | `count - denies` — allowed + unsupported. The "non-deny" stack. |
| <a id="count"></a> `count` | `number` | Total events that fell in this bucket. |
| <a id="denies-1"></a> `denies` | `number` | How many of `count` were denied. |
| <a id="denyheightratio"></a> `denyHeightRatio` | `number` | `denies / maxCount` — 0..1. The deny sub-stack height as a fraction of the tallest bucket, so the deny segment is drawn to the same scale as the full bar. Drives `--pyric-bucket-deny-h`. |
| <a id="end-2"></a> `end` | `number` | - |
| <a id="heightratio"></a> `heightRatio` | `number` | `count / maxCount` across all buckets — 0..1. The full bar height as a fraction of the tallest bucket. Drives `--pyric-bucket-h`. |
| <a id="index-1"></a> `index` | `number` | 0-based bucket index, left (oldest) to right (newest). |
| <a id="start-2"></a> `start` | `number` | Half-open bounds of this bucket `[start, end)` in epoch-ms. |

***

<a id="trafficcounts"></a>

### TrafficCounts

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="denied"></a> `denied` | `number` | Of those, how many were denied. |
| <a id="listener"></a> `listener` | `number` | Of those, how many are listener re-evals. |
| <a id="total-2"></a> `total` | `number` | Events currently in the buffer. |

***

<a id="trafficfilterstate"></a>

### TrafficFilterState

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="origin"></a> `origin` | [`TrafficOriginFilter`](#trafficoriginfilter) |
| <a id="pathquery"></a> `pathQuery` | `string` |
| <a id="result"></a> `result` | [`TrafficResultFilter`](#trafficresultfilter) |

***

<a id="trafficgroup"></a>

### TrafficGroup

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="count-1"></a> `count` | `number` | - |
| <a id="denies-2"></a> `denies` | `number` | - |
| <a id="events"></a> `events` | `TrafficEvent`[] | - |
| <a id="key-1"></a> `key` | `string` | `groupId` for batch/transaction; a synthetic key for listener runs. Stable enough for a React key. |
| <a id="kind"></a> `kind` | [`TrafficGroupKind`](#trafficgroupkind-1) | - |
| <a id="type"></a> `type` | `"group"` | - |

***

<a id="trafficmetricsresult"></a>

### TrafficMetricsResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="maxvalue"></a> `maxValue` | `number` | The largest single-bucket value across every series — the shared y-scale divisor a chart would use by default. |
| <a id="points"></a> `points` | [`MetricPoint`](#metricpoint)[] | - |
| <a id="series"></a> `series` | [`MetricSeries`](#metricseries)[] | - |

***

<a id="trafficsingle"></a>

### TrafficSingle

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="event"></a> `event` | `TrafficEvent` |
| <a id="type-1"></a> `type` | `"single"` |

***

<a id="trafficstatbucket"></a>

### TrafficStatBucket

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="count-2"></a> `count` | `number` |
| <a id="key-2"></a> `key` | `string` |

***

<a id="trafficstatssummary"></a>

### TrafficStatsSummary

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="allows-2"></a> `allows` | `number` | - |
| <a id="bymethod"></a> `byMethod` | [`TrafficStatBucket`](#trafficstatbucket)[] | Counts by method, sorted descending. |
| <a id="byorigin"></a> `byOrigin` | [`TrafficStatBucket`](#trafficstatbucket)[] | Counts by origin, sorted descending. |
| <a id="bypath"></a> `byPath` | [`TrafficStatBucket`](#trafficstatbucket)[] | Counts by path, sorted descending, capped at `topPaths`. |
| <a id="denies-3"></a> `denies` | `number` | - |
| <a id="denyrate"></a> `denyRate` | `number` | `denies / total` — 0 for an empty buffer. |
| <a id="total-3"></a> `total` | `number` | - |
| <a id="unsupported-1"></a> `unsupported` | `number` | - |

***

<a id="useruleheatmapoptions"></a>

### UseRuleHeatmapOptions

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="events-1"></a> `events` | `TrafficEvent`[] |

***

<a id="useruleheatmapresult"></a>

### UseRuleHeatmapResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="entries"></a> `entries` | [`RuleHeatmapEntry`](#ruleheatmapentry)[] | Per-rule rollup, sorted by `total` descending (busiest first), ties broken by `ruleIndex` ascending. |
| <a id="unmatchedcount"></a> `unmatchedCount` | `number` | Events that matched no rule — counted here, not attributed to any entry. |

***

<a id="usetrafficbucketsoptions"></a>

### UseTrafficBucketsOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="bucketcount"></a> `bucketCount?` | `number` | Number of buckets to divide the window into. Default 30. |
| <a id="events-2"></a> `events` | `TrafficEvent`[] | - |
| <a id="window"></a> `window` | [`TimeWindow`](#timewindow) | The time range to bucket over. |

***

<a id="usetrafficbucketsresult"></a>

### UseTrafficBucketsResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="buckets"></a> `buckets` | [`TrafficBucket`](#trafficbucket)[] | - |
| <a id="denies-4"></a> `denies` | `number` | Sum of `denies` across buckets. |
| <a id="maxcount"></a> `maxCount` | `number` | The largest single-bucket `count` — the height-ratio divisor. |
| <a id="outofwindow"></a> `outOfWindow` | `number` | Events whose `at` fell outside `[window.start, window.end)`. |
| <a id="total-4"></a> `total` | `number` | Sum of `count` across buckets (events inside the window). |

***

<a id="usetrafficfilteroptions"></a>

### UseTrafficFilterOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="events-3"></a> `events` | `TrafficEvent`[] | - |
| <a id="initialorigin"></a> `initialOrigin?` | [`TrafficOriginFilter`](#trafficoriginfilter) | Default `user` — the probe found listener traffic is 94–99.6% of events, so it's hidden until explicitly asked for. |
| <a id="initialpathquery"></a> `initialPathQuery?` | `string` | - |
| <a id="initialresult"></a> `initialResult?` | [`TrafficResultFilter`](#trafficresultfilter) | Default `all` — the probe found ~75–80% allow in realistic sessions, so hiding either side loses diagnostic signal. |

***

<a id="usetrafficfilterresult"></a>

### UseTrafficFilterResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="filter"></a> `filter` | [`TrafficFilterState`](#trafficfilterstate) | - |
| <a id="filtered"></a> `filtered` | `TrafficEvent`[] | Events passing all three filters, in the input order. |
| <a id="setorigin"></a> `setOrigin` | (`origin`: [`TrafficOriginFilter`](#trafficoriginfilter)) => `void` | - |
| <a id="setpathquery"></a> `setPathQuery` | (`pathQuery`: `string`) => `void` | - |
| <a id="setresult"></a> `setResult` | (`result`: [`TrafficResultFilter`](#trafficresultfilter)) => `void` | - |

***

<a id="usetrafficgroupsoptions"></a>

### UseTrafficGroupsOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="events-4"></a> `events` | `TrafficEvent`[] | - |
| <a id="groupbatches"></a> `groupBatches?` | `boolean` | Collapse consecutive ops sharing a `groupId`. Default true. |
| <a id="grouplistenerruns"></a> `groupListenerRuns?` | `boolean` | Collapse a consecutive run of listener re-evals from the same originating op into one group — the probe found a single write can trigger 250+ re-evals. Default true. |

***

<a id="usetrafficgroupsresult"></a>

### UseTrafficGroupsResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="items"></a> `items` | [`TrafficLogItem`](#trafficlogitem)[] | Events folded into a flat list of singles and groups, in the input order. |

***

<a id="usetrafficmetricsoptions"></a>

### UseTrafficMetricsOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="bucketcount-1"></a> `bucketCount?` | `number` | Number of buckets to divide the window into. The window itself should already be sized to the session (sandbox sessions run minutes, not days) — bucket count doesn't need to change, only the window a caller passes in. Default 24. |
| <a id="events-5"></a> `events` | `TrafficEvent`[] | - |
| <a id="isadmin"></a> `isAdmin?` | (`event`: `Pick`\<`TrafficEvent`, `"origin"`\>) => `boolean` | Override admin classification (e.g. a Studio caller with `authLens` provenance available — see the module doc). Defaults to `origin === 'admin'`. |
| <a id="window-1"></a> `window` | [`TimeWindow`](#timewindow) | - |

***

<a id="usetrafficmonitoroptions"></a>

### UseTrafficMonitorOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="buffersize"></a> `bufferSize?` | `number` | Ring-buffer cap. Once exceeded, the oldest events are dropped. Default 5000 (~3 MB worst case — see the traffic-monitor probe findings). |
| <a id="paused"></a> `paused?` | `boolean` | Whether the buffer starts paused. Default false. |
| <a id="source"></a> `source` | `TrafficSource` | The subscription function — `sandbox.onRequest` satisfies this directly. Pass a stable reference; the hook re-subscribes on identity change. |
| <a id="transform"></a> `transform?` | (`event`: `TrafficEvent`) => `TrafficEvent` | Runs per event before buffering — return a (possibly trimmed) event. Lets the consumer shrink oversized payloads without the library knowing payload semantics. Identity is read fresh on each event, so it need not be memoized. |

***

<a id="usetrafficmonitorresult"></a>

### UseTrafficMonitorResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="clear"></a> `clear` | () => `void` | Empty the buffer. |
| <a id="counts"></a> `counts` | [`TrafficCounts`](#trafficcounts) | - |
| <a id="events-6"></a> `events` | `TrafficEvent`[] | The buffered events, oldest first. |
| <a id="ispaused"></a> `isPaused` | `boolean` | - |
| <a id="pause"></a> `pause` | () => `void` | Stop appending — incoming events are dropped while paused. |
| <a id="resume"></a> `resume` | () => `void` | Resume appending. |

***

<a id="usetrafficstatsoptions"></a>

### UseTrafficStatsOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="events-7"></a> `events` | `TrafficEvent`[] | - |
| <a id="toppaths"></a> `topPaths?` | `number` | Cap on `byPath` entries — paths are unbounded. Default 10. |

## Type Aliases

<a id="billableserieskey"></a>

### BillableSeriesKey

```ts
type BillableSeriesKey = "reads" | "writes" | "deletes";
```

***

<a id="rulesserieskey"></a>

### RulesSeriesKey

```ts
type RulesSeriesKey = "allows" | "denies" | "errors";
```

***

<a id="trafficgroupkind-1"></a>

### TrafficGroupKind

```ts
type TrafficGroupKind = "batch" | "transaction" | "listener-run";
```

***

<a id="trafficlogitem"></a>

### TrafficLogItem

```ts
type TrafficLogItem = TrafficGroup | TrafficSingle;
```

***

<a id="trafficoriginfilter"></a>

### TrafficOriginFilter

```ts
type TrafficOriginFilter = "user" | "all" | "listener";
```

`user` keeps everything that isn't a listener re-eval (user ops
plus their transaction/batch sub-ops); `listener` keeps only
listener re-evals; `all` keeps everything.

***

<a id="trafficresultfilter"></a>

### TrafficResultFilter

```ts
type TrafficResultFilter = "all" | "allow" | "deny";
```

## Variables

<a id="billable_series_defs"></a>

### BILLABLE\_SERIES\_DEFS

```ts
const BILLABLE_SERIES_DEFS: ReadonlyArray<{
  key: BillableSeriesKey;
  label: string;
}>;
```

***

<a id="rules_series_defs"></a>

### RULES\_SERIES\_DEFS

```ts
const RULES_SERIES_DEFS: ReadonlyArray<{
  key: RulesSeriesKey;
  label: string;
}>;
```

## Functions

<a id="bucketbillablemetrics"></a>

### bucketBillableMetrics()

```ts
function bucketBillableMetrics(
   events: readonly TrafficEvent[],
   window: TimeWindow,
   bucketCount?: number,
   isAdmin?: (event: Pick<TrafficEvent, "origin">) => boolean): TrafficMetricsResult;
```

Pure kernel behind [useBillableMetrics](#usebillablemetrics) — usable outside React.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `events` | readonly `TrafficEvent`[] |
| `window` | [`TimeWindow`](#timewindow) |
| `bucketCount?` | `number` |
| `isAdmin?` | (`event`: `Pick`\<`TrafficEvent`, `"origin"`\>) => `boolean` |

#### Returns

[`TrafficMetricsResult`](#trafficmetricsresult)

***

<a id="bucketrulesmetrics"></a>

### bucketRulesMetrics()

```ts
function bucketRulesMetrics(
   events: readonly TrafficEvent[],
   window: TimeWindow,
   bucketCount?: number,
   isAdmin?: (event: Pick<TrafficEvent, "origin">) => boolean): TrafficMetricsResult;
```

Pure kernel behind [useRulesMetrics](#userulesmetrics) — usable outside React.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `events` | readonly `TrafficEvent`[] |
| `window` | [`TimeWindow`](#timewindow) |
| `bucketCount?` | `number` |
| `isAdmin?` | (`event`: `Pick`\<`TrafficEvent`, `"origin"`\>) => `boolean` |

#### Returns

[`TrafficMetricsResult`](#trafficmetricsresult)

***

<a id="buckettraffic"></a>

### bucketTraffic()

```ts
function bucketTraffic(
   events: TrafficEvent[],
   window: TimeWindow,
   bucketCount?: number): UseTrafficBucketsResult;
```

The pure bucketing kernel behind [useTrafficBuckets](#usetrafficbuckets) — usable
outside React. Returns an empty result for a non-positive
`bucketCount` or a zero/negative-width window.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `events` | `TrafficEvent`[] |
| `window` | [`TimeWindow`](#timewindow) |
| `bucketCount?` | `number` |

#### Returns

[`UseTrafficBucketsResult`](#usetrafficbucketsresult)

***

<a id="classifybillable"></a>

### classifyBillable()

```ts
function classifyBillable(event: Pick<TrafficEvent, "method" | "result" | "origin">, isAdmin?: (event: Pick<TrafficEvent, "origin">) => boolean): BillableSeriesKey;
```

Classify a billable op, or `null` if it isn't one / never ran.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `event` | `Pick`\<`TrafficEvent`, `"method"` \| `"result"` \| `"origin"`\> |
| `isAdmin?` | (`event`: `Pick`\<`TrafficEvent`, `"origin"`\>) => `boolean` |

#### Returns

[`BillableSeriesKey`](#billableserieskey)

***

<a id="classifyrules"></a>

### classifyRules()

```ts
function classifyRules(event: Pick<TrafficEvent, "result" | "origin">, isAdmin?: (event: Pick<TrafficEvent, "origin">) => boolean): RulesSeriesKey;
```

Classify a rules-engine verdict, or `null` if it isn't one (bypassed,
 unsupported, or not-applicable).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `event` | `Pick`\<`TrafficEvent`, `"result"` \| `"origin"`\> |
| `isAdmin?` | (`event`: `Pick`\<`TrafficEvent`, `"origin"`\>) => `boolean` |

#### Returns

[`RulesSeriesKey`](#rulesserieskey)

***

<a id="isadminevent"></a>

### isAdminEvent()

```ts
function isAdminEvent(event: Pick<TrafficEvent, "origin">): boolean;
```

Default admin predicate: the one signal the public `TrafficEvent`
 type declares. See the module doc for the known Firestore gap.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `event` | `Pick`\<`TrafficEvent`, `"origin"`\> |

#### Returns

`boolean`

***

<a id="usebillablemetrics"></a>

### useBillableMetrics()

```ts
function useBillableMetrics(__namedParameters: UseTrafficMetricsOptions): TrafficMetricsResult;
```

Reads / writes / deletes, bucketed over `window`. See the module doc
 for the billable mapping + the "read ops, not billable reads" caveat.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`UseTrafficMetricsOptions`](#usetrafficmetricsoptions) |

#### Returns

[`TrafficMetricsResult`](#trafficmetricsresult)

***

<a id="useruleheatmap"></a>

### useRuleHeatmap()

```ts
function useRuleHeatmap(__namedParameters: UseRuleHeatmapOptions): UseRuleHeatmapResult;
```

Rolls a traffic buffer up by `matchedRule.ruleIndex`: how often
each rule fired, and how that split across allow / deny /
unsupported. Pure derivation — feed it the filtered or full
event list depending on what the heatmap should reflect.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`UseRuleHeatmapOptions`](#useruleheatmapoptions) |

#### Returns

[`UseRuleHeatmapResult`](#useruleheatmapresult)

***

<a id="userulesmetrics"></a>

### useRulesMetrics()

```ts
function useRulesMetrics(__namedParameters: UseTrafficMetricsOptions): TrafficMetricsResult;
```

Allows / denies / errors, bucketed over `window`. Excludes
 rules-bypassed (admin) ops — see the module doc.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`UseTrafficMetricsOptions`](#usetrafficmetricsoptions) |

#### Returns

[`TrafficMetricsResult`](#trafficmetricsresult)

***

<a id="usetrafficbuckets"></a>

### useTrafficBuckets()

```ts
function useTrafficBuckets(__namedParameters: UseTrafficBucketsOptions): UseTrafficBucketsResult;
```

Buckets a traffic buffer into `bucketCount` equal time slices over
`window`, counting total + denied events per slice. Pure
derivation — the histogram component renders the result, this hook
(and `bucketTraffic` under it) owns the math.

Each bucket carries a `heightRatio` and `denyHeightRatio`
(0..1, scaled to the tallest bucket) so the consumer can map them
straight onto a bar height without re-finding the max.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`UseTrafficBucketsOptions`](#usetrafficbucketsoptions) |

#### Returns

[`UseTrafficBucketsResult`](#usetrafficbucketsresult)

***

<a id="usetrafficfilter"></a>

### useTrafficFilter()

```ts
function useTrafficFilter(__namedParameters: UseTrafficFilterOptions): UseTrafficFilterResult;
```

Derives a filtered view over a traffic buffer along three
dimensions: origin, result, and a case-insensitive path substring.
Owns the filter state; pure derivation otherwise.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`UseTrafficFilterOptions`](#usetrafficfilteroptions) |

#### Returns

[`UseTrafficFilterResult`](#usetrafficfilterresult)

***

<a id="usetrafficgroups"></a>

### useTrafficGroups()

```ts
function useTrafficGroups(__namedParameters: UseTrafficGroupsOptions): UseTrafficGroupsResult;
```

Folds a traffic buffer into a list of singles and collapsible
groups. Two grouping modes, both over *consecutive* events:

- `groupId` — batch/transaction sub-ops sharing an id collapse
  into one `batch` / `transaction` group.
- listener runs — a consecutive run of listener re-evals from the
  same originating op collapses into one `listener-run` group.
  A run of length 1 stays a single (no point collapsing one row).

Pure derivation; the input order is preserved.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`UseTrafficGroupsOptions`](#usetrafficgroupsoptions) |

#### Returns

[`UseTrafficGroupsResult`](#usetrafficgroupsresult)

***

<a id="usetrafficmonitor"></a>

### useTrafficMonitor()

```ts
function useTrafficMonitor(__namedParameters: UseTrafficMonitorOptions): UseTrafficMonitorResult;
```

Buffers a traffic stream into a capped ring buffer with
pause/resume/clear. Decoupled from `pyric/sandbox` — `source` is
just a `(cb) => unsubscribe` function.

Pause is consumer-side: while paused, the subscription stays
attached but incoming events are dropped (not queued). This
matches the probe decision — a `load-test`-shaped session can emit
100k+ events, so queueing-while-paused would defeat the point.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`UseTrafficMonitorOptions`](#usetrafficmonitoroptions) |

#### Returns

[`UseTrafficMonitorResult`](#usetrafficmonitorresult)

***

<a id="usetrafficstats"></a>

### useTrafficStats()

```ts
function useTrafficStats(__namedParameters: UseTrafficStatsOptions): TrafficStatsSummary;
```

Aggregations over a traffic buffer: totals, deny rate, and counts
broken down by method, origin, and path. Pure derivation — feed it
the filtered or full event list depending on what the panel
should reflect.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`UseTrafficStatsOptions`](#usetrafficstatsoptions) |

#### Returns

[`TrafficStatsSummary`](#trafficstatssummary)
