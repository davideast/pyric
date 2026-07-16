---
title: "API reference: @pyric/ui/traffic"
navLabel: "@pyric/ui/traffic"
outcome: "Published declarations for @pyric/ui/traffic."
slug: "pyric-ui-traffic-reference-api"
kind: "api"
apiPackage: "@pyric/ui"
apiImportPath: "@pyric/ui/traffic"
apiSubpath: "traffic"
apiSymbolCount: 74
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

<a id="ruleheatmapprops"></a>

### RuleHeatmapProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="classname"></a> `className?` | `string` | - |
| <a id="emptystate"></a> `emptyState?` | `ReactNode` | - |
| <a id="entries"></a> `entries` | [`RuleHeatmapEntry`](#ruleheatmapentry)[] | Per-rule rollup from `useRuleHeatmap`. |
| <a id="onselectrule"></a> `onSelectRule?` | (`ruleIndex`: `number`) => `void` | Fired when a rule row is clicked — wire this to the log filter for the cross-view "click a rule, see its traffic" interaction. |
| <a id="selectedruleindex"></a> `selectedRuleIndex?` | `number` | Marks one rule row as the active selection. |

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

<a id="trafficauthstate"></a>

### TrafficAuthState

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="token"></a> `token?` | `Record`\<`string`, `unknown`\> |
| <a id="uid"></a> `uid` | `string` |

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

<a id="trafficdetailprops"></a>

### TrafficDetailProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="classname-1"></a> `className?` | `string` | - |
| <a id="event"></a> `event` | [`TrafficEvent`](#trafficevent) | - |
| <a id="formattime"></a> `formatTime?` | (`at`: `number`) => `string` | Override the timestamp rendering. Default is `HH:MM:SS`. |
| <a id="onback"></a> `onBack?` | () => `void` | Fired by the back affordance. When absent, no back button. |
| <a id="renderclassification"></a> `renderClassification?` | (`event`: [`TrafficEvent`](#trafficevent)) => `ReactNode` | Render-prop slot below the header — the playground drops its denial overlay (classification + LLM analysis) here. The library doesn't own that analysis. |

***

<a id="trafficevent"></a>

### TrafficEvent

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="at"></a> `at` | `number` | `Date.now()` at op start. |
| <a id="auth"></a> `auth` | [`TrafficAuthState`](#trafficauthstate) | - |
| <a id="durationms"></a> `durationMs?` | `number` | Canonical service-operation duration. |
| <a id="evalms"></a> `evalMs?` | `number` | Simulator eval duration in ms. De-featured in the UI (local simulator) — present for the detail panel only. |
| <a id="groupid"></a> `groupId?` | `string` | Shared across ops in one batch or transaction. |
| <a id="groupkind"></a> `groupKind?` | \| `string` & \{ \} \| `"transaction"` \| `"batch"` | - |
| <a id="id"></a> `id` | `string` | Unique per emission. |
| <a id="kind"></a> `kind?` | `"request"` \| `"operation"` | Source event kind. Firestore request events omit this in older adapters. |
| <a id="matchedrule"></a> `matchedRule?` | [`TrafficMatchedRule`](#trafficmatchedrule) | Parsed from the matched `Rule #N` debug line — absent if none. |
| <a id="method"></a> `method` | [`TrafficMethod`](#trafficmethod) | - |
| <a id="origin"></a> `origin` | [`TrafficOrigin`](#trafficorigin) | - |
| <a id="path"></a> `path` | `string` | - |
| <a id="reasons"></a> `reasons` | `string`[] | Simulator debug messages — `Rule #N (op) → ALLOW` format. |
| <a id="request"></a> `request?` | \{ `data?`: `unknown`; `query?`: `unknown`; `resourceData?`: `unknown`; \} | Proposed write payload — absent on reads + delete. |
| `request.data?` | `unknown` | - |
| `request.query?` | `unknown` | - |
| `request.resourceData?` | `unknown` | - |
| <a id="resourceafter"></a> `resourceAfter?` | [`TrafficResourceState`](#trafficresourcestate) | Projected doc state after the write — absent on reads. |
| <a id="resourcebefore"></a> `resourceBefore?` | [`TrafficResourceState`](#trafficresourcestate) | Existing doc state before the write (or the read target). |
| <a id="result"></a> `result` | [`TrafficResult`](#trafficresult) | - |
| <a id="service"></a> `service?` | \| `"firestore"` \| `"auth"` \| `"storage"` \| `"rtdb"` \| `string` & \{ \} | Service that emitted the event. Omitted means Firestore. |
| <a id="triggeredby"></a> `triggeredBy?` | \{ `method`: `string`; `path?`: `string`; \} | For listener re-evals — the originating user op. |
| `triggeredBy.method` | `string` | - |
| `triggeredBy.path?` | `string` | - |

***

<a id="trafficfilterstate"></a>

### TrafficFilterState

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="origin-1"></a> `origin` | [`TrafficOriginFilter`](#trafficoriginfilter) |
| <a id="pathquery"></a> `pathQuery` | `string` |
| <a id="result-1"></a> `result` | [`TrafficResultFilter`](#trafficresultfilter) |

***

<a id="trafficgroup"></a>

### TrafficGroup

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="count-1"></a> `count` | `number` | - |
| <a id="denies-2"></a> `denies` | `number` | - |
| <a id="events"></a> `events` | [`TrafficEvent`](#trafficevent)[] | - |
| <a id="key-1"></a> `key` | `string` | `groupId` for batch/transaction; a synthetic key for listener runs. Stable enough for a React key. |
| <a id="kind-1"></a> `kind` | [`TrafficGroupKind`](#trafficgroupkind-1) | - |
| <a id="type"></a> `type` | `"group"` | - |

***

<a id="trafficgrouprowprops"></a>

### TrafficGroupRowProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="classname-2"></a> `className?` | `string` | - |
| <a id="defaultexpanded"></a> `defaultExpanded?` | `boolean` | Whether the group starts expanded. Default false — grouping exists to collapse volume, so collapsed is the useful default. |
| <a id="formattime-1"></a> `formatTime?` | (`at`: `number`) => `string` | Passed through to each member `<TrafficRow>`. |
| <a id="group"></a> `group` | [`TrafficGroup`](#trafficgroup) | - |
| <a id="onselect"></a> `onSelect?` | (`event`: [`TrafficEvent`](#trafficevent)) => `void` | - |
| <a id="renderclassification-1"></a> `renderClassification?` | (`event`: [`TrafficEvent`](#trafficevent)) => `ReactNode` | Passed through to each member `<TrafficRow>`. |
| <a id="selectedid"></a> `selectedId?` | `string` | - |

***

<a id="trafficlinechartprops"></a>

### TrafficLineChartProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="classname-3"></a> `className?` | `string` | - |
| <a id="emptystate-1"></a> `emptyState?` | `ReactNode` | - |
| <a id="formattime-2"></a> `formatTime?` | (`t`: `number`) => `string` | - |
| <a id="formatvalue"></a> `formatValue?` | (`n`: `number`) => `string` | - |
| <a id="omitzeroseries"></a> `omitZeroSeries?` | `boolean` | Omit all-zero series from the plot and tooltip while retaining their explicit total in the accompanying metric strip. |
| <a id="points"></a> `points` | readonly [`MetricPoint`](#metricpoint)[] | - |
| <a id="series"></a> `series` | readonly [`MetricSeries`](#metricseries)[] | - |
| <a id="visible"></a> `visible?` | `ReadonlySet`\<`string`\> | Series keys currently drawn. Omit to draw every series. Pair with [TrafficMetricCards](#trafficmetriccards)' `visible`/`onToggle` so the legend cards and the chart's lines toggle in lockstep. |

***

<a id="trafficlogprops"></a>

### TrafficLogProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="classname-4"></a> `className?` | `string` | - |
| <a id="emptystate-2"></a> `emptyState?` | `ReactNode` | - |
| <a id="events-1"></a> `events` | [`TrafficEvent`](#trafficevent)[] | Events to render, in display order. The hook layer decides the order — `<TrafficLog>` renders the array as given. |
| <a id="formattime-3"></a> `formatTime?` | (`at`: `number`) => `string` | Passed through to each `<TrafficRow>`. |
| <a id="items"></a> `items?` | [`TrafficLogItem`](#trafficlogitem)[] | Grouped items from `useTrafficGroups`. When provided, the log renders singles + collapsible group rows and does NOT virtualize — grouping is itself the volume reducer (a 250-event listener storm becomes one group row). `events` is ignored. |
| <a id="onselect-1"></a> `onSelect?` | (`event`: [`TrafficEvent`](#trafficevent)) => `void` | - |
| <a id="renderclassification-2"></a> `renderClassification?` | (`event`: [`TrafficEvent`](#trafficevent)) => `ReactNode` | Passed through to each `<TrafficRow>`. |
| <a id="renderrow"></a> `renderRow?` | (`event`: [`TrafficEvent`](#trafficevent), `selected`: `boolean`) => `ReactNode` | Full escape hatch — render a row yourself instead of the default `<TrafficRow>`. Receives the event and its selected state. Applies to the flat (`events`) path only. |
| <a id="rowheight"></a> `rowHeight?` | `number` \| (`index`: `number`) => `number` | Estimated row height when virtualizing. Default 28. |
| <a id="selectedid-1"></a> `selectedId?` | `string` | The selected event's id, marked with `data-pyric-selected`. |
| <a id="virtualizedheight"></a> `virtualizedHeight?` | `string` \| `number` | Pixel height the virtualized scroll container fills. Default `'60vh'`. |
| <a id="virtualizethreshold"></a> `virtualizeThreshold?` | `number` | Above this row count, the list virtualizes via `<VirtualList>`. Default 100 — a `load-test`-shaped session can emit 100k+ events, so virtualization is load-bearing, not polish. |

***

<a id="trafficmatchedrule"></a>

### TrafficMatchedRule

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="operations-1"></a> `operations` | `string`[] |
| <a id="ruleindex-1"></a> `ruleIndex` | `number` |

***

<a id="trafficmetriccardsprops"></a>

### TrafficMetricCardsProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="classname-5"></a> `className?` | `string` | - |
| <a id="formatvalue-1"></a> `formatValue?` | (`n`: `number`) => `string` | - |
| <a id="ontoggle"></a> `onToggle?` | (`key`: `string`) => `void` | - |
| <a id="series-1"></a> `series` | readonly [`MetricSeries`](#metricseries)[] | - |
| <a id="visible-1"></a> `visible?` | `ReadonlySet`\<`string`\> | When supplied (with `onToggle`), each card gets a checkbox and doubles as the chart's legend — Console reference semantics ("toggle series visibility"). Omit for a read-only totals strip. |

***

<a id="trafficmetricsresult"></a>

### TrafficMetricsResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="maxvalue"></a> `maxValue` | `number` | The largest single-bucket value across every series — the shared y-scale divisor a chart would use by default. |
| <a id="points-1"></a> `points` | [`MetricPoint`](#metricpoint)[] | - |
| <a id="series-2"></a> `series` | [`MetricSeries`](#metricseries)[] | - |

***

<a id="trafficresourcestate"></a>

### TrafficResourceState

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="data"></a> `data` | `unknown` |
| <a id="exists"></a> `exists` | `boolean` |

***

<a id="trafficrowprops"></a>

### TrafficRowProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="classname-6"></a> `className?` | `string` | - |
| <a id="event-1"></a> `event` | [`TrafficEvent`](#trafficevent) | - |
| <a id="formattime-4"></a> `formatTime?` | (`at`: `number`) => `string` | Override the timestamp rendering. Default is `HH:MM:SS`. |
| <a id="onselect-2"></a> `onSelect?` | (`event`: [`TrafficEvent`](#trafficevent)) => `void` | - |
| <a id="renderclassification-3"></a> `renderClassification?` | (`event`: [`TrafficEvent`](#trafficevent)) => `ReactNode` | Render-prop slot for a consumer-specific classification badge — e.g. the playground's `expected`/`ambiguous`/`unexpected` verdict, which is app-source analysis the library doesn't own. Returns `null` to render nothing. |
| <a id="selected"></a> `selected?` | `boolean` | Marks the row as the active selection (`data-pyric-selected`). |

***

<a id="trafficsingle"></a>

### TrafficSingle

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="event-2"></a> `event` | [`TrafficEvent`](#trafficevent) |
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

<a id="trafficstatsprops"></a>

### TrafficStatsProps

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="classname-7"></a> `className?` | `string` |
| <a id="stats"></a> `stats` | [`TrafficStatsSummary`](#trafficstatssummary) |

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

<a id="traffictimelineprops"></a>

### TrafficTimelineProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="axis"></a> `axis?` | `ReactNode` \| (`window`: [`TimeWindow`](#timewindow)) => `ReactNode` | Axis slot — tick labels below the bars inside `[data-pyric-timeline-axis]`. The mock puts "14m ago · 7m · now" here. Receives the resolved window so labels can be derived. |
| <a id="brush"></a> `brush?` | [`TimeWindow`](#timewindow) | A brushed sub-range (`[start, end)`) drawn as an overlay over the bars. Position is derived from where it falls inside `window`, so a partly-out-of-window brush clamps to the chart edges. |
| <a id="bucketcount"></a> `bucketCount?` | `number` | Number of bars. Default 30. Only used on the `events` path. |
| <a id="buckets"></a> `buckets?` | [`UseTrafficBucketsResult`](#usetrafficbucketsresult) | Pre-bucketed counts — the escape hatch when the caller already ran [useTrafficBuckets](#usetrafficbuckets) (or `bucketTraffic`) upstream, e.g. to share one bucketing pass across the timeline + a stats header. Takes precedence over `events`. |
| <a id="classname-8"></a> `className?` | `string` | - |
| <a id="emptystate-3"></a> `emptyState?` | `ReactNode` | - |
| <a id="events-2"></a> `events?` | [`TrafficEvent`](#trafficevent)[] | Raw traffic events to bucket. Ignored when `buckets` is supplied (the consumer pre-bucketed). Exactly one of `events` / `buckets` should drive the histogram. |
| <a id="header"></a> `header?` | `ReactNode` | Header slot — title, deny summary, live label. Rendered above the bars inside `[data-pyric-timeline-header]`. The mock puts "142 requests · 16 denied · live" here. |
| <a id="liveat"></a> `liveAt?` | `number` | Where the live edge marker sits, in epoch-ms. Defaults to `window.end` (the right edge = "now"). Omit / pass `null` to hide the marker entirely (e.g. a frozen, non-live window). |
| <a id="onbrush"></a> `onBrush?` | (`window`: [`TimeWindow`](#timewindow)) => `void` | Fired when a bar inside the brush region is clicked-through — the component itself is presentation-agnostic about drag, so the primary brush gesture is owned by the consumer. As a built-in affordance, clicking a bucket calls this with a one-bucket-wide window so a bare consumer still gets a working selection. |
| <a id="renderbucketsummary"></a> `renderBucketSummary?` | (`bucket`: [`TrafficBucket`](#trafficbucket)) => `ReactNode` | Direct annotation shown while a bucket is hovered or keyboard-focused. The timeline owns preview state and positioning; the consumer owns the words and number formatting. |
| <a id="window"></a> `window` | [`TimeWindow`](#timewindow) | The time range the histogram spans. |

***

<a id="useruleheatmapoptions"></a>

### UseRuleHeatmapOptions

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="events-3"></a> `events` | [`TrafficEvent`](#trafficevent)[] |

***

<a id="useruleheatmapresult"></a>

### UseRuleHeatmapResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="entries-1"></a> `entries` | [`RuleHeatmapEntry`](#ruleheatmapentry)[] | Per-rule rollup, sorted by `total` descending (busiest first), ties broken by `ruleIndex` ascending. |
| <a id="unmatchedcount"></a> `unmatchedCount` | `number` | Events that matched no rule — counted here, not attributed to any entry. |

***

<a id="usetrafficbucketsoptions"></a>

### UseTrafficBucketsOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="bucketcount-1"></a> `bucketCount?` | `number` | Number of buckets to divide the window into. Default 30. |
| <a id="events-4"></a> `events` | [`TrafficEvent`](#trafficevent)[] | - |
| <a id="window-1"></a> `window` | [`TimeWindow`](#timewindow) | The time range to bucket over. |

***

<a id="usetrafficbucketsresult"></a>

### UseTrafficBucketsResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="buckets-1"></a> `buckets` | [`TrafficBucket`](#trafficbucket)[] | - |
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
| <a id="events-5"></a> `events` | [`TrafficEvent`](#trafficevent)[] | - |
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
| <a id="filtered"></a> `filtered` | [`TrafficEvent`](#trafficevent)[] | Events passing all three filters, in the input order. |
| <a id="setorigin"></a> `setOrigin` | (`origin`: [`TrafficOriginFilter`](#trafficoriginfilter)) => `void` | - |
| <a id="setpathquery"></a> `setPathQuery` | (`pathQuery`: `string`) => `void` | - |
| <a id="setresult"></a> `setResult` | (`result`: [`TrafficResultFilter`](#trafficresultfilter)) => `void` | - |

***

<a id="usetrafficgroupsoptions"></a>

### UseTrafficGroupsOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="events-6"></a> `events` | [`TrafficEvent`](#trafficevent)[] | - |
| <a id="groupbatches"></a> `groupBatches?` | `boolean` | Collapse consecutive ops sharing a `groupId`. Default true. |
| <a id="grouplistenerruns"></a> `groupListenerRuns?` | `boolean` | Collapse a consecutive run of listener re-evals from the same originating op into one group — the probe found a single write can trigger 250+ re-evals. Default true. |

***

<a id="usetrafficgroupsresult"></a>

### UseTrafficGroupsResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="items-1"></a> `items` | [`TrafficLogItem`](#trafficlogitem)[] | Events folded into a flat list of singles and groups, in the input order. |

***

<a id="usetrafficmetricsoptions"></a>

### UseTrafficMetricsOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="bucketcount-2"></a> `bucketCount?` | `number` | Number of buckets to divide the window into. The window itself should already be sized to the session (sandbox sessions run minutes, not days) — bucket count doesn't need to change, only the window a caller passes in. Default 24. |
| <a id="events-7"></a> `events` | [`TrafficEvent`](#trafficevent)[] | - |
| <a id="isadmin"></a> `isAdmin?` | (`event`: `Pick`\<[`TrafficEvent`](#trafficevent), `"origin"`\>) => `boolean` | Override admin classification (e.g. a Studio caller with `authLens` provenance available — see the module doc). Defaults to `origin === 'admin'`. |
| <a id="window-2"></a> `window` | [`TimeWindow`](#timewindow) | - |

***

<a id="usetrafficmonitoroptions"></a>

### UseTrafficMonitorOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="buffersize"></a> `bufferSize?` | `number` | Ring-buffer cap. Once exceeded, the oldest events are dropped. Default 5000 (~3 MB worst case — see the traffic-monitor probe findings). |
| <a id="paused"></a> `paused?` | `boolean` | Whether the buffer starts paused. Default false. |
| <a id="source"></a> `source` | [`TrafficSource`](#trafficsource) | The subscription function — `sandbox.onRequest` satisfies this directly. Pass a stable reference; the hook re-subscribes on identity change. |
| <a id="transform"></a> `transform?` | (`event`: [`TrafficEvent`](#trafficevent)) => [`TrafficEvent`](#trafficevent) | Runs per event before buffering — return a (possibly trimmed) event. Lets the consumer shrink oversized payloads without the library knowing payload semantics. Identity is read fresh on each event, so it need not be memoized. |

***

<a id="usetrafficmonitorresult"></a>

### UseTrafficMonitorResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="clear"></a> `clear` | () => `void` | Empty the buffer. |
| <a id="counts"></a> `counts` | [`TrafficCounts`](#trafficcounts) | - |
| <a id="events-8"></a> `events` | [`TrafficEvent`](#trafficevent)[] | The buffered events, oldest first. |
| <a id="ispaused"></a> `isPaused` | `boolean` | - |
| <a id="pause"></a> `pause` | () => `void` | Stop appending — incoming events are dropped while paused. |
| <a id="resume"></a> `resume` | () => `void` | Resume appending. |

***

<a id="usetrafficstatsoptions"></a>

### UseTrafficStatsOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="events-9"></a> `events` | [`TrafficEvent`](#trafficevent)[] | - |
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

<a id="trafficmethod"></a>

### TrafficMethod

```ts
type TrafficMethod =
  | "get"
  | "list"
  | "create"
  | "update"
  | "set"
  | "delete"
  | "remove"
  | "push"
  | "listen"
  | "transaction"
  | string & {
};
```

The traffic domain types. `TrafficEvent` is structurally identical
to `pyric/sandbox`'s `RequestEvent` (locked in
the design rationale) — but the library defines its
own copy so it never imports `pyric/sandbox`. `sandbox.onRequest`
is assignable as a `TrafficSource` with zero adapter code; a prod
log feed can satisfy the same shape.

***

<a id="trafficorigin"></a>

### TrafficOrigin

```ts
type TrafficOrigin = "user" | "listener" | "transaction" | "batch" | "admin" | "system";
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

<a id="trafficresult"></a>

### TrafficResult

```ts
type TrafficResult = "allow" | "deny" | "unsupported" | "error" | "not-applicable";
```

***

<a id="trafficresultfilter"></a>

### TrafficResultFilter

```ts
type TrafficResultFilter = "all" | "allow" | "deny";
```

***

<a id="trafficsource"></a>

### TrafficSource()

```ts
type TrafficSource = (cb: (event: TrafficEvent) => void) => () => void;
```

A subscription function: register a callback, get back an
unsubscribe. `pyric/sandbox`'s `Sandbox.onRequest` matches this
signature exactly.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `cb` | (`event`: [`TrafficEvent`](#trafficevent)) => `void` |

#### Returns

```ts
(): void;
```

##### Returns

`void`

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
| `events` | readonly [`TrafficEvent`](#trafficevent)[] |
| `window` | [`TimeWindow`](#timewindow) |
| `bucketCount?` | `number` |
| `isAdmin?` | (`event`: `Pick`\<[`TrafficEvent`](#trafficevent), `"origin"`\>) => `boolean` |

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
| `events` | readonly [`TrafficEvent`](#trafficevent)[] |
| `window` | [`TimeWindow`](#timewindow) |
| `bucketCount?` | `number` |
| `isAdmin?` | (`event`: `Pick`\<[`TrafficEvent`](#trafficevent), `"origin"`\>) => `boolean` |

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
| `events` | [`TrafficEvent`](#trafficevent)[] |
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
| `event` | `Pick`\<[`TrafficEvent`](#trafficevent), `"method"` \| `"result"` \| `"origin"`\> |
| `isAdmin?` | (`event`: `Pick`\<[`TrafficEvent`](#trafficevent), `"origin"`\>) => `boolean` |

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
| `event` | `Pick`\<[`TrafficEvent`](#trafficevent), `"result"` \| `"origin"`\> |
| `isAdmin?` | (`event`: `Pick`\<[`TrafficEvent`](#trafficevent), `"origin"`\>) => `boolean` |

#### Returns

[`RulesSeriesKey`](#rulesserieskey)

***

<a id="defaultformattime"></a>

### defaultFormatTime()

```ts
function defaultFormatTime(at: number): string;
```

Default `HH:MM:SS` timestamp formatter. Components accept a
`formatTime` prop to override — this is just the fallback so the
library has no hard locale dependency.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `at` | `number` |

#### Returns

`string`

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
| `event` | `Pick`\<[`TrafficEvent`](#trafficevent), `"origin"`\> |

#### Returns

`boolean`

***

<a id="reasonverdict"></a>

### reasonVerdict()

```ts
function reasonVerdict(reason: string): "allow" | "deny" | "neutral";
```

Classifies a simulator debug line as a deny / allow / neutral
verdict so consumers can tint reason rows via
`[data-pyric-reason-verdict="…"]`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `reason` | `string` |

#### Returns

`"allow"` \| `"deny"` \| `"neutral"`

***

<a id="ruleheatmap"></a>

### RuleHeatmap()

```ts
function RuleHeatmap(__namedParameters: RuleHeatmapProps): Element;
```

Headless rule heatmap — one row per rule, busiest first. Each row
exposes two styling channels:

- `data-pyric-rule-heat` — a discrete bucket (`none`/`low`/
  `medium`/`high`) by deny ratio, for threshold-based coloring.
- `--pyric-deny-ratio` — the raw 0–1 ratio as a CSS custom
  property, for a proportional bar / gradient.

Counts render as separate elements (`data-pyric-rule-total`,
`-allows`, `-denies`) so the consumer can show numbers, bars, or
both.

Styling hooks: `[data-pyric-ui="rule-heatmap"]`,
`[data-pyric-rule-row]` (with `data-pyric-rule-index`,
`data-pyric-rule-heat`, `data-pyric-selected`).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`RuleHeatmapProps`](#ruleheatmapprops) |

#### Returns

`Element`

***

<a id="trafficdetail"></a>

### TrafficDetail()

```ts
function TrafficDetail(__namedParameters: TrafficDetailProps): Element;
```

Headless drill-in panel for a single traffic event. Renders the
header (result + origin + timestamp + method/path + matched rule),
a consumer classification slot, then JSON sections for auth,
request payload, and resource before/after via `<JsonView>`, plus
the reasons list, `triggeredBy`, and `groupId`.

`evalMs` appears here as a minor header field only — it is not a
log column (local simulator; latency is de-featured per
the design rationale).

Styling hooks: `[data-pyric-ui="traffic-detail"]`,
`[data-pyric-traffic-section]` (with `data-pyric-section-label`),
`[data-pyric-traffic-reason]` (with `data-pyric-reason-verdict`).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`TrafficDetailProps`](#trafficdetailprops) |

#### Returns

`Element`

***

<a id="trafficgrouprow"></a>

### TrafficGroupRow()

```ts
function TrafficGroupRow(__namedParameters: TrafficGroupRowProps): Element;
```

A collapsible group row — one header summarizing a batch,
transaction, or listener-run, expanding to the member rows. The
header carries `data-pyric-group-kind` and a `data-pyric-group-*`
count/deny rollup; expansion state is `data-pyric-expanded`.

Styling hooks: `[data-pyric-traffic-group]`,
`[data-pyric-traffic-group-header]` (with `data-pyric-group-kind`),
`[data-pyric-traffic-group-members]`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`TrafficGroupRowProps`](#trafficgrouprowprops) |

#### Returns

`Element`

***

<a id="trafficlinechart"></a>

### TrafficLineChart()

```ts
function TrafficLineChart(__namedParameters: TrafficLineChartProps): Element;
```

Hand-rolled SVG line chart, no charting dependency — plain lines over
 a 0..100 viewBox so CSS drives the actual size (intrinsic layout, no
 fixed pixel chart). Each series draws only when `visible` includes
 its key (or `visible` is omitted). The y-scale is the max value
 across the currently VISIBLE series only, so toggling a tall series
 off rescales the rest up — matching the Console reference.

Interaction: hovering (or focusing, via the invisible per-bucket hit
targets) shows a tooltip with the bucket's time range and each visible
series' value at that bucket — `[data-pyric-chart-tooltip]`, positioned
via `--pyric-hover-x`.

Styling hooks: `[data-pyric-ui="traffic-line-chart"]`,
`[data-pyric-chart-svg]`, `[data-pyric-chart-line]` (with
`data-pyric-series-key`, `data-pyric-series-index` — the same index a
`TrafficMetricCards` card carries, so line + card colors line up),
`[data-pyric-chart-hit]` (with `data-pyric-point-index`),
`[data-pyric-chart-tooltip]`, `[data-pyric-tooltip-row]`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`TrafficLineChartProps`](#trafficlinechartprops) |

#### Returns

`Element`

***

<a id="trafficlog"></a>

### TrafficLog()

```ts
function TrafficLog(__namedParameters: TrafficLogProps): Element;
```

Headless traffic log — a Chrome DevTools Network-panel-style event
stream. Below `virtualizeThreshold` it renders a plain `<ul>`;
above it, TanStack-Virtual via `<VirtualList>`.

Styling hooks: `[data-pyric-ui="traffic-log"]`,
`[data-pyric-traffic-entry]` (the list item wrapper), plus the
`<TrafficRow>` hooks.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`TrafficLogProps`](#trafficlogprops) |

#### Returns

`Element`

***

<a id="trafficmetriccards"></a>

### TrafficMetricCards()

```ts
function TrafficMetricCards(__namedParameters: TrafficMetricCardsProps): Element;
```

The period-total strip: one card per series, each showing the series'
total for the current window. Doubles as BOTH the chart's legend row
(pass `visible` + `onToggle` to get the checkbox-toggle semantics) AND
the standalone fallback presentation when a chart isn't warranted —
this component never depends on [TrafficLineChart](#trafficlinechart).

Styling hooks: `[data-pyric-ui="traffic-metric-cards"]`,
`[data-pyric-metric-card]` (with `data-pyric-metric-key`,
`data-pyric-series-index` — the color channel a chart's lines also
key off of, so a card and its line always match), `[data-pyric-metric-hidden]`
when toggled off.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`TrafficMetricCardsProps`](#trafficmetriccardsprops) |

#### Returns

`Element`

***

<a id="trafficrow"></a>

### TrafficRow()

```ts
function TrafficRow(__namedParameters: TrafficRowProps): Element;
```

One headless traffic row — timestamp, method badge, path, and an
optional consumer classification slot. The raw result is exposed as
`data-pyric-result` on the row (for tinting/filtering); rendering a
verdict/outcome label is the consumer's job via
`renderClassification` — the row itself draws no result chip, so a
consumer verdict never collides with a built-in one. Latency is
intentionally absent: this is a local simulator, so `evalMs` lives
in `<TrafficDetail>` only.

Styling hooks:
- `[data-pyric-traffic-row]` — the row button, with
  `data-pyric-result`, `data-pyric-origin`, `data-pyric-method`
- `[data-pyric-traffic-row][data-pyric-selected]` — active row
- `[data-pyric-traffic-time]` / `[data-pyric-traffic-path]`
- `[data-pyric-traffic-service]` — the service label (firestore / rtdb /
  storage / auth), rendered even when unknown (empty) so fixed-width
  styling keeps the columns aligned
- method renders as `<Badge>` (`data-pyric-badge-kind`)

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`TrafficRowProps`](#trafficrowprops) |

#### Returns

`Element`

***

<a id="trafficstats"></a>

### TrafficStats()

```ts
function TrafficStats(__namedParameters: TrafficStatsProps): Element;
```

Headless aggregation panel. Renders the totals, the deny rate, and
count breakdowns by method / origin / path. The deny rate is
exposed both as text and as a `--pyric-deny-rate` CSS custom
property on the root for a proportional meter.

Styling hooks: `[data-pyric-ui="traffic-stats"]`,
`[data-pyric-stat]` (with `data-pyric-stat-key`),
`[data-pyric-stat-group]` (with `data-pyric-stat-group-label`),
`[data-pyric-stat-bucket]`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`TrafficStatsProps`](#trafficstatsprops) |

#### Returns

`Element`

***

<a id="traffictimeline"></a>

### TrafficTimeline()

```ts
function TrafficTimeline(__namedParameters: TrafficTimelineProps): Element;
```

Headless volume-over-time histogram — the time axis for the traffic
lens. Buckets events into N bars; each bar stacks denies (dark, at
the base) under the allow remainder, matching the Studio mock.

Per-bucket styling channels (on `[data-pyric-bucket]`):
- `data-pyric-bucket-count` / `-denies` — raw integers.
- `--pyric-bucket-h` — full bar height, 0..1 of the tallest bucket.
- `--pyric-bucket-deny-h` — deny sub-stack height, same scale.
The deny segment (`[data-pyric-bucket-deny]`) and allow segment
(`[data-pyric-bucket-allow]`) are separate children so the consumer
colors them independently.

A `[data-pyric-brush]` overlay marks a sub-range via
`--pyric-brush-left` / `--pyric-brush-right` (0..1 fractions). The
`[data-pyric-live]` edge marker sits at `--pyric-live-x`.

Styling hooks: `[data-pyric-ui="traffic-timeline"]`,
`[data-pyric-timeline-header]`, `[data-pyric-timeline-bars]`,
`[data-pyric-bucket]` (with `data-pyric-bucket-index`,
`data-pyric-has-denies`, `data-pyric-bucket-selected`),
`[data-pyric-bucket-summary]`, `[data-pyric-brush]`, `[data-pyric-live]`,
`[data-pyric-timeline-axis]`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`TrafficTimelineProps`](#traffictimelineprops) |

#### Returns

`Element`

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
