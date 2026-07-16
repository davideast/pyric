---
title: "API reference: @pyric/ui/events/hooks"
navLabel: "@pyric/ui/events/hooks"
outcome: "Published declarations for @pyric/ui/events/hooks."
slug: "pyric-ui-events-hooks-reference-api"
kind: "api"
apiPackage: "@pyric/ui"
apiImportPath: "@pyric/ui/events/hooks"
apiSubpath: "events/hooks"
apiSymbolCount: 5
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Interfaces

<a id="useactivitydigestoptions"></a>

### UseActivityDigestOptions

#### Extends

- `ActivityDigestOptions`

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="groupby"></a> `groupBy?` | `ActivityGroupBy` | Pivot rows within each band by an attribution axis. `'none'` (default) leaves the band flat. Any other value splits each band's rows into sub-groups keyed by that axis — surfaced on the row via `groupKey` and exposed as `band.subgroups`. The flat `rows` are always present regardless. |
| <a id="now"></a> `now?` | `number` | Clock injection for the relative `when` column. Defaults to `Date.now()` read once per recompute. Pass a fixed value (or a frozen "session now") for deterministic rendering / tests. NOTE: changing `now` between renders re-folds the digest, so don't pass a fresh `Date.now()` inline unless you want a recompute every render — pin it (e.g. a ticking value updated on an interval). |
| <a id="order"></a> `order?` | `"recency"` \| `"chronological"` | Row order within a band. `recency` (default) is newest-first to match the mock's `when` column. `chronological` is oldest-first. |
| <a id="rowsperband"></a> `rowsPerBand?` | `number` | Cap rows kept per band (the mock shows ~3–4 then "N more"). The digest keeps ALL rows but records the overflow via `band.count` vs `rows.length`. Set to a number to actually trim `rows`; the header `count` still reflects the true total. Default: keep all. |

***

<a id="useactivitystreamoptions"></a>

### UseActivityStreamOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="buffersize"></a> `bufferSize?` | `number` | Ring-buffer cap. Once exceeded, the oldest events drop. Default 5000 (mirrors the traffic monitor's cap — a load-test session can emit 100k+ events). |
| <a id="initial"></a> `initial?` | readonly `AnyActivityEvent`[] | Seed the buffer with a snapshot before the live subscription attaches — typically `sandbox.history()`, so a late-attaching consumer sees the whole session, not just events from `subscribe` onward. Read once on mount. |
| <a id="paused"></a> `paused?` | `boolean` | Start paused — incoming events drop (not queued) while paused. |
| <a id="source"></a> `source` | `ActivitySource` | The subscription — `sandbox.onEvent` satisfies this directly. Pass a stable reference; the hook re-subscribes on identity change. |

***

<a id="useactivitystreamresult"></a>

### UseActivityStreamResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="clear"></a> `clear` | () => `void` | Empty the buffer (does NOT re-seed from `initial`). |
| <a id="events"></a> `events` | `AnyActivityEvent`[] | The buffered events, oldest-first. Stable per emission — safe to hand straight to [useActivityDigest](#useactivitydigest). |
| <a id="ispaused"></a> `isPaused` | `boolean` | - |
| <a id="pause"></a> `pause` | () => `void` | - |
| <a id="resume"></a> `resume` | () => `void` | - |

## Functions

<a id="useactivitydigest"></a>

### useActivityDigest()

```ts
function useActivityDigest(events: readonly AnyActivityEvent[], options?: UseActivityDigestOptions): ActivityDigest;
```

React wrapper over computeActivityDigest — memoizes the pure
fold over the unified `SandboxEvent` stream into the banded activity
digest. Feed it `sandbox.history()` (a snapshot) or the live buffer
from [useActivityStream](#useactivitystream); the reducer is identical either way.

The fold re-runs when `events` identity, any grouping option, or
`now` changes. Keep `events` referentially stable across renders that
shouldn't recompute (the stream hook already returns a stable array
per emission).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `events` | readonly `AnyActivityEvent`[] |
| `options?` | [`UseActivityDigestOptions`](#useactivitydigestoptions) |

#### Returns

`ActivityDigest`

***

<a id="useactivitystream"></a>

### useActivityStream()

```ts
function useActivityStream(__namedParameters: UseActivityStreamOptions): UseActivityStreamResult;
```

Buffers the unified sandbox event stream into a capped ring buffer
with optional history seeding + pause/resume/clear. Decoupled from
`pyric` — `source` is just a `(cb) => unsubscribe`.

Sibling to the traffic monitor's `useTrafficMonitor`; the difference
is the wider event type (`AnyActivityEvent`, the full union) and the
`initial` seed so `history()` + live compose into one buffer.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`UseActivityStreamOptions`](#useactivitystreamoptions) |

#### Returns

[`UseActivityStreamResult`](#useactivitystreamresult)
