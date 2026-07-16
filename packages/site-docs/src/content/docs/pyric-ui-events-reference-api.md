---
title: "API reference: @pyric/ui/events"
navLabel: "@pyric/ui/events"
group: "API reference"
section: "@pyric/ui"
order: 9039
description: "Published declarations for @pyric/ui/events."
kind: "api"
apiPackage: "@pyric/ui"
apiImportPath: "@pyric/ui/events"
apiSubpath: "events"
apiSymbolCount: 38
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Interfaces

<a id="activityactionitem"></a>

### ActivityActionItem

A single action item — a mechanical fact that invites a decision.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="key"></a> `key` | `string` | Stable key. |
| <a id="meta"></a> `meta?` | `string` | Sub-line — attribution / cause. |
| <a id="rows"></a> `rows` | [`ActivityRow`](#activityrow)[] | The rows this item summarizes — for drill-in / linking into the matching Activity band (items LINK to bands, they don't duplicate). |
| <a id="title"></a> `title` | `string` | The headline (mechanical: "4 writes to /notes were denied"). |
| <a id="type"></a> `type` | `"denied"` | What it is — drives `data-pyric-action-type`. Today: `denied`. |

***

<a id="activityactionitemsprops"></a>

### ActivityActionItemsProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="classname"></a> `className?` | `string` | - |
| <a id="digest"></a> `digest` | [`ActivityDigest`](#activitydigest) | - |
| <a id="emptystate"></a> `emptyState?` | `ReactNode` | Rendered when there are no action items — default renders nothing (calm by default; the region collapses). |
| <a id="renderaction"></a> `renderAction?` | (`item`: [`ActivityActionItem`](#activityactionitem)) => `ReactNode` | Render the action button/affordance for an item (e.g. a "Debug" link). Returns `null` to render no action. |
| <a id="rendertitle"></a> `renderTitle?` | (`item`: [`ActivityActionItem`](#activityactionitem)) => `ReactNode` | Override item-title composition (host owns app-semantic copy). |

***

<a id="activityauthstate"></a>

### ActivityAuthState

Identity in effect for an op. `null` is anonymous / signed out.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="token"></a> `token?` | `Record`\<`string`, `unknown`\> |
| <a id="uid"></a> `uid` | `string` |

***

<a id="activityband"></a>

### ActivityBand

One category band: a header (`label · count · attribution`) plus its
rows. Mirrors the mock's `.band` + `.r.data` structure.

#### Extended by

- [`ActivityBandWithGroups`](#activitybandwithgroups)

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="attribution"></a> `attribution?` | `string` | A short attribution phrase when the band has a dominant actor / subject (`all by alice`, `by the app`, `by agent atlas`). Absent when attribution is mixed — the header then shows just the count. |
| <a id="count"></a> `count` | `number` | Total rows in the band (== `rows.length`; explicit for the header). |
| <a id="key-1"></a> `key` | [`ActivityBandKey`](#activitybandkey-1) | - |
| <a id="label"></a> `label` | `string` | Display label — `Denied`, `Added`, `Updated`, … |
| <a id="rows-1"></a> `rows` | [`ActivityRow`](#activityrow)[] | - |

***

<a id="activitybandwithgroups"></a>

### ActivityBandWithGroups

A band that may carry pivot sub-groups. `subgroups` is populated only
when the digest was computed with `groupBy !== 'none'`; otherwise the
band is flat (`rows` only). `computeActivityDigest` always returns
bands of this shape so consumers can branch on `subgroups` presence.

#### Extends

- [`ActivityBand`](#activityband)

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="attribution-1"></a> `attribution?` | `string` | A short attribution phrase when the band has a dominant actor / subject (`all by alice`, `by the app`, `by agent atlas`). Absent when attribution is mixed — the header then shows just the count. |
| <a id="count-1"></a> `count` | `number` | Total rows in the band (== `rows.length`; explicit for the header). |
| <a id="key-2"></a> `key` | [`ActivityBandKey`](#activitybandkey-1) | - |
| <a id="label-1"></a> `label` | `string` | Display label — `Denied`, `Added`, `Updated`, … |
| <a id="rows-2"></a> `rows` | [`ActivityRow`](#activityrow)[] | - |
| <a id="subgroups"></a> `subgroups?` | [`ActivitySubgroup`](#activitysubgroup)[] | Present only when `groupBy !== 'none'`. |

***

<a id="activitydigest"></a>

### ActivityDigest

The banded digest — the activity grid's entire model. Bands are
pre-sorted lead-with-consequence; `denials` is a flat projection of
the consequential rows for the action-items tier.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="bands"></a> `bands` | [`ActivityBandWithGroups`](#activitybandwithgroups)[] | Bands in render order — highest-consequence first. Empty bands omitted. Each band may carry `subgroups` when `groupBy !== 'none'`. |
| <a id="denials"></a> `denials` | [`ActivityRow`](#activityrow)[] | The denial rows, flat + recency-sorted — the source for the action-items tier ("4 writes to /notes were denied"). A projection, not a separate aggregation: these rows also live in the `denied` band. |
| <a id="deniedcount"></a> `deniedCount` | `number` | Of those, how many were denials. |
| <a id="total"></a> `total` | `number` | Total rows across all bands (events the digest categorized). |

***

<a id="activitydigestoptions"></a>

### ActivityDigestOptions

#### Extended by

- [`UseActivityDigestOptions`](#useactivitydigestoptions)

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="groupby"></a> `groupBy?` | [`ActivityGroupBy`](#activitygroupby) | Pivot rows within each band by an attribution axis. `'none'` (default) leaves the band flat. Any other value splits each band's rows into sub-groups keyed by that axis — surfaced on the row via `groupKey` and exposed as `band.subgroups`. The flat `rows` are always present regardless. |
| <a id="order"></a> `order?` | `"recency"` \| `"chronological"` | Row order within a band. `recency` (default) is newest-first to match the mock's `when` column. `chronological` is oldest-first. |
| <a id="rowsperband"></a> `rowsPerBand?` | `number` | Cap rows kept per band (the mock shows ~3–4 then "N more"). The digest keeps ALL rows but records the overflow via `band.count` vs `rows.length`. Set to a number to actually trim `rows`; the header `count` still reflects the true total. Default: keep all. |

***

<a id="activitygridprops"></a>

### ActivityGridProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="classname-1"></a> `className?` | `string` | - |
| <a id="digest-1"></a> `digest?` | [`ActivityDigest`](#activitydigest) | A precomputed digest from `useActivityDigest` / `computeActivity Digest`. Pass this when the host already memoizes the fold (so the grid doesn't recompute). Mutually exclusive with `events`. |
| <a id="emptystate-1"></a> `emptyState?` | `ReactNode` | Shown when the digest has no rows. |
| <a id="events"></a> `events?` | readonly [`AnyActivityEvent`](#anyactivityevent)[] | The unified event stream — `sandbox.history()` and/or a live buffer (see `useActivityStream`). The grid folds it into the banded digest internally. Mutually exclusive with `digest`. |
| <a id="formatwhen"></a> `formatWhen?` | (`at`: `number`, `now`: `number`) => `string` | Override the `when` column rendering. |
| <a id="maxrowsperband"></a> `maxRowsPerBand?` | `number` | Clamp rows shown per band; the rest collapse into a "N more" stub. Independent of the reducer's `rowsPerBand` (which trims the data) — this is a pure display clamp that keeps the true count visible. Default: show all rows. |
| <a id="now"></a> `now?` | `number` | "Now" anchor for `formatWhen`. |
| <a id="onselect"></a> `onSelect?` | (`row`: [`ActivityRow`](#activityrow)) => `void` | - |
| <a id="options"></a> `options?` | [`ActivityDigestOptions`](#activitydigestoptions) & \{ `now?`: `number`; \} | Grouping / ordering options, forwarded to the reducer when the grid folds `events` itself. Ignored when `digest` is supplied. |
| <a id="renderbandmore"></a> `renderBandMore?` | (`band`: [`ActivityBandWithGroups`](#activitybandwithgroups), `hidden`: `number`) => `ReactNode` | Render the per-band overflow stub. Default renders a `[data-pyric-band-more]` element reading "N more {label}". |
| <a id="selectedid"></a> `selectedId?` | `string` | The selected row id (`data-pyric-selected`). |
| <a id="showcolumnheader"></a> `showColumnHeader?` | `boolean` | Render a leading column-header row (`target change for lens when`). Default true — matches the mock's `.colhead`. |

***

<a id="activitygridrowprops"></a>

### ActivityGridRowProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="classname-2"></a> `className?` | `string` | - |
| <a id="formatwhen-1"></a> `formatWhen?` | (`at`: `number`, `now`: `number`) => `string` | Override the `when` rendering. Receives `(at, now)`; default is the session-relative duration. |
| <a id="now-1"></a> `now?` | `number` | The "now" anchor passed to `formatWhen` (and `row.when` is used as a fallback when omitted). |
| <a id="onselect-1"></a> `onSelect?` | (`row`: [`ActivityRow`](#activityrow)) => `void` | - |
| <a id="row"></a> `row` | [`ActivityRow`](#activityrow) | - |
| <a id="selected"></a> `selected?` | `boolean` | Marks the row as the active selection (`data-pyric-selected`). |

***

<a id="activityprovenance"></a>

### ActivityProvenance

Provenance carried by every event. All optional + additive — pre-
provenance emitters omit them (read as firestore / app / app-session).

#### Extended by

- [`ActivityRequestEvent`](#activityrequestevent)
- [`ActivityWriteEvent`](#activitywriteevent)
- [`ActivityServiceMutationEvent`](#activityservicemutationevent)

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="actor"></a> `actor?` | [`ActivityActor`](#activityactor) | - |
| <a id="authlens"></a> `authLens?` | [`ActivityLens`](#activitylens) | - |
| <a id="planid"></a> `planId?` | `string` | Set when the op is part of an agent plan (dry-run / accept). |
| <a id="service"></a> `service?` | [`ActivityService`](#activityservice) | - |

***

<a id="activityrequestevent"></a>

### ActivityRequestEvent

A Firestore `request` event — one per evaluated op. The digest reads
these for denials (`result === 'deny'`) and, when no `write` event is
present, for the allow trail. Structurally a subset of `RequestEvent`.

#### Extends

- [`ActivityProvenance`](#activityprovenance)

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="actor-1"></a> `actor?` | [`ActivityActor`](#activityactor) | - |
| <a id="at"></a> `at` | `number` | - |
| <a id="auth"></a> `auth` | [`ActivityAuthState`](#activityauthstate) | - |
| <a id="authlens-1"></a> `authLens?` | [`ActivityLens`](#activitylens) | - |
| <a id="groupid"></a> `groupId?` | `string` | - |
| <a id="id"></a> `id` | `string` | - |
| <a id="kind"></a> `kind` | `"request"` | - |
| <a id="matchedrule"></a> `matchedRule?` | \{ `operations`: `string`[]; `ruleIndex`: `number`; \} | - |
| `matchedRule.operations` | `string`[] | - |
| `matchedRule.ruleIndex` | `number` | - |
| <a id="method"></a> `method` | `"get"` \| `"list"` \| `"create"` \| `"update"` \| `"set"` \| `"delete"` | - |
| <a id="origin"></a> `origin` | `"user"` \| `"listener"` \| `"transaction"` \| `"batch"` | - |
| <a id="path"></a> `path` | `string` | - |
| <a id="planid-1"></a> `planId?` | `string` | Set when the op is part of an agent plan (dry-run / accept). |
| <a id="reasons"></a> `reasons` | `string`[] | Simulator debug trail. Used to surface the deciding rule on denials. |
| <a id="request"></a> `request?` | \{ `resourceData?`: `Record`\<`string`, `unknown`\>; \} | - |
| `request.resourceData?` | `Record`\<`string`, `unknown`\> | - |
| <a id="resourceafter"></a> `resourceAfter?` | \{ `data`: `Record`\<`string`, `unknown`\>; `exists`: `boolean`; \} | - |
| `resourceAfter.data` | `Record`\<`string`, `unknown`\> | - |
| `resourceAfter.exists` | `boolean` | - |
| <a id="resourcebefore"></a> `resourceBefore?` | \{ `data`: `Record`\<`string`, `unknown`\>; `exists`: `boolean`; \} | - |
| `resourceBefore.data` | `Record`\<`string`, `unknown`\> | - |
| `resourceBefore.exists` | `boolean` | - |
| <a id="result"></a> `result` | [`ActivityResult`](#activityresult) | - |
| <a id="service-1"></a> `service?` | [`ActivityService`](#activityservice) | - |
| <a id="triggeredby"></a> `triggeredBy?` | \{ `method`: `string`; `path`: `string`; \} | - |
| `triggeredBy.method` | `string` | - |
| `triggeredBy.path` | `string` | - |

***

<a id="activityrow"></a>

### ActivityRow

A single grid row — the projection of one event onto the
`target · change · for · lens · when` column contract from
`c-result.html`. All display-ready strings plus the structured
provenance the host may style on.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="actor-2"></a> `actor` | [`ActivityActor`](#activityactor) | - |
| <a id="at-1"></a> `at` | `number` | `Date.now()` at the op. Drives the `when` column + recency sort. |
| <a id="authlens-2"></a> `authLens` | [`ActivityLens`](#activitylens) | - |
| <a id="band"></a> `band` | [`ActivityBandKey`](#activitybandkey-1) | Which band this row was sorted into. |
| <a id="change"></a> `change` | `string` | `change` — a short human description of the mutation (`update, owner rule`, `done → true`, `created`, `signed in`). |
| <a id="denied"></a> `denied` | `boolean` | True for denials — first-class so hosts flag the row distinctly. |
| <a id="event"></a> `event` | [`ActivityEvent`](#activityevent) | The original event, for drill-in. |
| <a id="for"></a> `for` | `string` | `for` — the subject the op acted on behalf of: `request.auth.uid` for firestore, the affected `uid` for auth, else the acting identity. Empty when anonymous / not applicable. |
| <a id="groupkey"></a> `groupKey?` | `string` | The pivot key this row fell under — set only when the digest was computed with `groupBy !== 'none'`. Mirrors the row's `subgroup`. |
| <a id="id-1"></a> `id` | `string` | The originating event's id — stable React key. |
| <a id="lens"></a> `lens` | `string` | `lens` — the privilege the op ran under, display-ready (`app`, `as alice`, `admin`). |
| <a id="planid-2"></a> `planId?` | `string` | Agent plan id, when the op was part of a plan. |
| <a id="service-2"></a> `service` | [`ActivityService`](#activityservice) | Originating service. |
| <a id="subjectuid"></a> `subjectUid` | `string` | The on-behalf-of subject uid, structured (mirrors `for`). |
| <a id="target"></a> `target` | `string` | `target` — what was mutated, in the service's addressing scheme (a doc path `notes/3agHoZHZ`, a `uid`, a storage `fullPath`, an rtdb path). Empty string when the event has no addressable target. |
| <a id="when"></a> `when` | `string` | `when` — left undterived here; the grid formats `at` itself, but a pre-rendered relative string is offered for headless consumers. |

***

<a id="activityservicemutationevent"></a>

### ActivityServiceMutationEvent

Cross-service mutation — the unified envelope auth / storage / rtdb
emit. The digest maps `service` + `op` to a band (signed-in, added,
updated, removed, …). Subset of `ServiceMutationEvent`.

#### Extends

- [`ActivityProvenance`](#activityprovenance)

#### Properties

| Property | Type | Description | Overrides |
| :------ | :------ | :------ | :------ |
| <a id="actor-3"></a> `actor?` | [`ActivityActor`](#activityactor) | - | - |
| <a id="after"></a> `after?` | `unknown` | - | - |
| <a id="at-2"></a> `at` | `number` | - | - |
| <a id="auth-1"></a> `auth` | [`ActivityAuthState`](#activityauthstate) | - | - |
| <a id="authlens-3"></a> `authLens?` | [`ActivityLens`](#activitylens) | - | - |
| <a id="before"></a> `before?` | `unknown` | - | - |
| <a id="detail"></a> `detail?` | `Record`\<`string`, `unknown`\> | - | - |
| <a id="id-2"></a> `id` | `string` | - | - |
| <a id="kind-1"></a> `kind` | `"service_mutation"` | - | - |
| <a id="op"></a> `op` | `string` | - | - |
| <a id="path-1"></a> `path?` | `string` | - | - |
| <a id="planid-3"></a> `planId?` | `string` | Set when the op is part of an agent plan (dry-run / accept). | - |
| <a id="service-3"></a> `service` | `"auth"` \| `"storage"` \| `"rtdb"` | - | [`ActivityProvenance`](#activityprovenance).[`service`](#service) |

***

<a id="activitysubgroup"></a>

### ActivitySubgroup

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="count-2"></a> `count` | `number` |
| <a id="key-3"></a> `key` | `string` |
| <a id="rows-3"></a> `rows` | [`ActivityRow`](#activityrow)[] |

***

<a id="activitywriteevent"></a>

### ActivityWriteEvent

A committed Firestore write — `create`/`update`/`set`/`delete` that
the rule engine allowed and the keyspace applied. The digest leads
with these for the added/updated/removed bands (richer than `request`:
carries prior/next state for the change summary). Subset of
`WriteSandboxEvent`.

#### Extends

- [`ActivityProvenance`](#activityprovenance)

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="actor-4"></a> `actor?` | [`ActivityActor`](#activityactor) | - |
| <a id="at-3"></a> `at` | `number` | - |
| <a id="auth-2"></a> `auth` | [`ActivityAuthState`](#activityauthstate) | - |
| <a id="authlens-4"></a> `authLens?` | [`ActivityLens`](#activitylens) | - |
| <a id="data"></a> `data?` | `Record`\<`string`, `unknown`\> | - |
| <a id="groupid-1"></a> `groupId?` | `string` | - |
| <a id="id-3"></a> `id` | `string` | - |
| <a id="kind-2"></a> `kind` | `"write"` | - |
| <a id="method-1"></a> `method` | `"create"` \| `"update"` \| `"set"` \| `"delete"` | - |
| <a id="nextstate"></a> `nextState` | `Record`\<`string`, `unknown`\> | - |
| <a id="path-2"></a> `path` | `string` | - |
| <a id="planid-4"></a> `planId?` | `string` | Set when the op is part of an agent plan (dry-run / accept). |
| <a id="priorstate"></a> `priorState` | `Record`\<`string`, `unknown`\> | - |
| <a id="service-4"></a> `service?` | [`ActivityService`](#activityservice) | - |

***

<a id="createdauthuser"></a>

### CreatedAuthUser

An auth user a staged proposal creates (a sign-in account, distinct from
Firestore documents). The host adapts its backend request (e.g. a
`CreateUserRequest`) into this UI-level shape.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="displayname"></a> `displayName?` | `string` |
| <a id="email"></a> `email?` | `string` |
| <a id="emailverified"></a> `emailVerified?` | `boolean` |
| <a id="provider"></a> `provider?` | `string` |
| <a id="uid-1"></a> `uid` | `string` |

***

<a id="fieldchange"></a>

### FieldChange

One field-level change in a staged proposal. A UI-level diff row: the host
adapts its backend diff (e.g. the sandbox's `Divergence[]`) into these so the
component stays decoupled from any backend type.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="after-1"></a> `after` | `unknown` | - |
| <a id="before-1"></a> `before` | `unknown` | - |
| <a id="docpath"></a> `docPath` | `string` | Full document path, e.g. `notes/abc123`. |
| <a id="field"></a> `field` | `string` | The field that changed. |
| <a id="kind-3"></a> `kind` | `"added"` \| `"removed"` \| `"changed"` | `added` = new field, `removed` = cleared, `changed` = value differs. |

***

<a id="proposedchangediffprops"></a>

### ProposedChangeDiffProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="authusers"></a> `authUsers?` | readonly [`CreatedAuthUser`](#createdauthuser)[] | Auth users the proposal creates, shown as a leading "auth users" group. |
| <a id="changes"></a> `changes` | [`FieldChange`](#fieldchange)[] | - |
| <a id="classname-3"></a> `className?` | `string` | - |
| <a id="emptystate-2"></a> `emptyState?` | `ReactNode` | Rendered when there are no changes. Defaults to nothing. |
| <a id="formatvalue"></a> `formatValue?` | (`value`: `unknown`) => `ReactNode` | Format a value for display. Default: JSON-ish, empty for `undefined`. |

***

<a id="useactivitydigestoptions"></a>

### UseActivityDigestOptions

#### Extends

- [`ActivityDigestOptions`](#activitydigestoptions)

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="groupby-1"></a> `groupBy?` | [`ActivityGroupBy`](#activitygroupby) | Pivot rows within each band by an attribution axis. `'none'` (default) leaves the band flat. Any other value splits each band's rows into sub-groups keyed by that axis — surfaced on the row via `groupKey` and exposed as `band.subgroups`. The flat `rows` are always present regardless. |
| <a id="now-2"></a> `now?` | `number` | Clock injection for the relative `when` column. Defaults to `Date.now()` read once per recompute. Pass a fixed value (or a frozen "session now") for deterministic rendering / tests. NOTE: changing `now` between renders re-folds the digest, so don't pass a fresh `Date.now()` inline unless you want a recompute every render — pin it (e.g. a ticking value updated on an interval). |
| <a id="order-1"></a> `order?` | `"recency"` \| `"chronological"` | Row order within a band. `recency` (default) is newest-first to match the mock's `when` column. `chronological` is oldest-first. |
| <a id="rowsperband-1"></a> `rowsPerBand?` | `number` | Cap rows kept per band (the mock shows ~3–4 then "N more"). The digest keeps ALL rows but records the overflow via `band.count` vs `rows.length`. Set to a number to actually trim `rows`; the header `count` still reflects the true total. Default: keep all. |

***

<a id="useactivitystreamoptions"></a>

### UseActivityStreamOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="buffersize"></a> `bufferSize?` | `number` | Ring-buffer cap. Once exceeded, the oldest events drop. Default 5000 (mirrors the traffic monitor's cap — a load-test session can emit 100k+ events). |
| <a id="initial"></a> `initial?` | readonly [`AnyActivityEvent`](#anyactivityevent)[] | Seed the buffer with a snapshot before the live subscription attaches — typically `sandbox.history()`, so a late-attaching consumer sees the whole session, not just events from `subscribe` onward. Read once on mount. |
| <a id="paused"></a> `paused?` | `boolean` | Start paused — incoming events drop (not queued) while paused. |
| <a id="source"></a> `source` | [`ActivitySource`](#activitysource) | The subscription — `sandbox.onEvent` satisfies this directly. Pass a stable reference; the hook re-subscribes on identity change. |

***

<a id="useactivitystreamresult"></a>

### UseActivityStreamResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="clear"></a> `clear` | () => `void` | Empty the buffer (does NOT re-seed from `initial`). |
| <a id="events-1"></a> `events` | [`AnyActivityEvent`](#anyactivityevent)[] | The buffered events, oldest-first. Stable per emission — safe to hand straight to [useActivityDigest](#useactivitydigest). |
| <a id="ispaused"></a> `isPaused` | `boolean` | - |
| <a id="pause"></a> `pause` | () => `void` | - |
| <a id="resume"></a> `resume` | () => `void` | - |

## Type Aliases

<a id="activityactor"></a>

### ActivityActor

```ts
type ActivityActor =
  | {
  kind: "app";
}
  | {
  kind: "studio";
}
  | {
  kind: "agent";
  name: string;
}
  | {
  kind: "app-builder";
};
```

Who initiated the op behind an event. Absent ⇒ the served app.

***

<a id="activitybandkey-1"></a>

### ActivityBandKey

```ts
type ActivityBandKey =
  | "denied"
  | "errored"
  | "added"
  | "updated"
  | "removed"
  | "signed-in"
  | "signed-out"
  | "read"
  | "other";
```

The band a row falls into. `denied` leads; the write bands
(added/updated/removed) and the auth bands (signed-in/signed-out)
follow; `read`, `errored`, and `other` are the long-tail catch-alls.

- `denied`     — a rules denial (firestore `request` with `result: 'deny'`).
- `errored`    — an operational failure (`request` with `result: 'unsupported'`).
- `added`      — a doc/object created, or a user created.
- `updated`    — a doc/object/user/rtdb path mutated in place.
- `removed`    — a doc/object/user deleted.
- `signed-in`  — an auth sign-in.
- `signed-out` — an auth sign-out.
- `read`       — an allowed firestore read (`get`/`list`).
- `other`      — anything modelled but uncategorized (e.g. an unknown service op).

***

<a id="activityevent"></a>

### ActivityEvent

```ts
type ActivityEvent =
  | ActivityRequestEvent
  | ActivityWriteEvent
  | ActivityServiceMutationEvent;
```

The union members the activity digest aggregates. This is a SUBSET of
`pyric`'s `SandboxEvent` — the listener-lifecycle / snapshot-delivery /
session-boundary kinds carry no user-visible mutation, so the digest
ignores them. The reducer accepts any object with a `kind` and skips
the kinds it doesn't model, so a full `SandboxEvent[]` passes through
cleanly (the extra kinds fall into the "unknown ⇒ skipped" branch).

***

<a id="activitygroupby"></a>

### ActivityGroupBy

```ts
type ActivityGroupBy = "none" | "actor" | "lens" | "subject" | "service";
```

How rows within each band are pivoted/grouped.

***

<a id="activitylens"></a>

### ActivityLens

```ts
type ActivityLens =
  | {
  mode: "admin";
}
  | {
  mode: "as";
  uid: string;
}
  | {
  mode: "app-session";
};
```

The auth lens an op ran under. `admin` bypasses rules, `as` evaluates
rules as a specific uid (impersonation), `app-session` is the app's
own signed-in user. Absent ⇒ `app-session`.

***

<a id="activityresult"></a>

### ActivityResult

```ts
type ActivityResult = "allow" | "deny" | "unsupported";
```

Firestore op outcome — present on `request` events only.

***

<a id="activityservice"></a>

### ActivityService

```ts
type ActivityService = "firestore" | "auth" | "storage" | "rtdb";
```

Which sandbox service emitted an event. Absent ⇒ `'firestore'`.

***

<a id="activitysource"></a>

### ActivitySource()

```ts
type ActivitySource = (cb: (event: AnyActivityEvent) => void) => () => void;
```

A subscription: register a callback, get an unsubscribe.
`sandbox.onEvent` matches this signature.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `cb` | (`event`: [`AnyActivityEvent`](#anyactivityevent)) => `void` |

#### Returns

```ts
(): void;
```

##### Returns

`void`

***

<a id="anyactivityevent"></a>

### AnyActivityEvent

```ts
type AnyActivityEvent =
  | ActivityEvent
  | {
[k: string]: unknown;
  kind: string;
};
```

The widened input the reducer accepts: any `ActivityEvent`, plus a
permissive escape for unmodelled `SandboxEvent` kinds carrying a
string `kind` (skipped). Lets `sandbox.history()` flow in unfiltered.

## Functions

<a id="activityactionitems"></a>

### ActivityActionItems()

```ts
function ActivityActionItems(__namedParameters: ActivityActionItemsProps): ReactNode;
```

The action-items tier — the few things wanting a decision, surfaced
ABOVE the activity grid (design-ideation Tier 2 / "Needs you").
Denials lead and are first-class. Mechanical copy by default; the host
supplies the action affordance (e.g. a "Debug" link into the rules
debugger) via `renderAction`.

Data contract:
- `[data-pyric-ui="activity-action-items"]` — the root (absent when
  empty and no `emptyState`).
- `[data-pyric-action-item]` (+ `data-pyric-action-type`,
  `data-pyric-action-count`) — one item.
- `[data-pyric-action-title]` / `[data-pyric-action-meta]` — the copy.
- `[data-pyric-action-affordance]` — wraps the host's action node.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`ActivityActionItemsProps`](#activityactionitemsprops) |

#### Returns

`ReactNode`

***

<a id="activitygrid"></a>

### ActivityGrid()

```ts
function ActivityGrid(__namedParameters: ActivityGridProps): ReactNode;
```

Headless activity grid over the unified `SandboxEvent` stream. Folds
events into category bands (Denied / Added / Updated / Removed /
Signed in / …), each band a `target · change · for · lens · when`
column grid grouped under a `label · count · attribution` header.
Denials lead (lead-with-consequence) and are flagged first-class.

Ships ZERO styling — the host (Pyric Studio) applies the rigid column
grid + band typography via the `data-pyric-*` contract:
- `[data-pyric-ui="activity-grid"]` — the root.
- `[data-pyric-band]` — a band header, with `data-pyric-band-key`,
  `data-pyric-band-count`, `data-pyric-band-denied` (on the denied
  band). Children: `[data-pyric-band-label]`, `[data-pyric-band-n]`,
  `[data-pyric-band-attr]` (omitted when attribution is mixed).
- `[data-pyric-band-rows]` — the row container; with grouping,
  `[data-pyric-band-subgroup]` (+ `data-pyric-subgroup-key`) wraps
  each pivot bucket.
- `[data-pyric-band-more]` — the "N more" overflow stub.
- the `<ActivityGridRow>` contract for each row.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`ActivityGridProps`](#activitygridprops) |

#### Returns

`ReactNode`

***

<a id="activitygridrow"></a>

### ActivityGridRow()

```ts
function ActivityGridRow(__namedParameters: ActivityGridRowProps): ReactNode;
```

One activity grid row — the `target · change · for · lens · when`
column contract from `c-result.html`, plus a trailing drill affordance
column. Headless: every cell is a `data-pyric-event-*` span the host
styles into the rigid column grid.

Styling / data contract:
- `[data-pyric-event-row]` — the row, with `data-pyric-event-band`,
  `data-pyric-event-service`, `data-pyric-event-lens`,
  `data-pyric-event-denied` (present only on denials), and
  `data-pyric-selected` when active.
- `[data-pyric-event-target]` / `-change` / `-for` / `-lens` / `-when`
  — the five columns, in order.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`ActivityGridRowProps`](#activitygridrowprops) |

#### Returns

`ReactNode`

***

<a id="computeactivitydigest"></a>

### computeActivityDigest()

```ts
function computeActivityDigest(events: readonly AnyActivityEvent[], opts?: ActivityDigestOptions & {
  now?: number;
}): ActivityDigest;
```

Fold a unified event stream into the banded activity digest. PURE —
no React, no clock reads except the injected `now` (defaults to
`Date.now()`, but pass a fixed value in tests for determinism).

Events the digest doesn't model (listener lifecycle, snapshot
delivery, session boundaries, unknown kinds) are skipped — a full
`SandboxEvent[]` from `sandbox.history()` flows in unfiltered.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `events` | readonly [`AnyActivityEvent`](#anyactivityevent)[] |
| `opts?` | [`ActivityDigestOptions`](#activitydigestoptions) & \{ `now?`: `number`; \} |

#### Returns

[`ActivityDigest`](#activitydigest)

***

<a id="defaultformatwhen"></a>

### defaultFormatWhen()

```ts
function defaultFormatWhen(at: number, now?: number): string;
```

Default `when`-column formatter: a session-relative duration
(`now` / `12s` / `3m` / `1h`), matching the mock's `c-when` strings.
The grid is session-scoped (see design-ideation "FRAME CORRECTION")
so anchors are relative, never absolute calendar dates.

Override via `<ActivityGrid formatWhen={...} />` when the host has a
better clock anchor (e.g. a ticking "session now").

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `at` | `number` |
| `now?` | `number` |

#### Returns

`string`

***

<a id="proposedchangediff"></a>

### ProposedChangeDiff()

```ts
function ProposedChangeDiff(__namedParameters: ProposedChangeDiffProps): Element;
```

Headless renderer for a staged change: the documents a proposal touches, with
per-field before/after. Grouped by collection. Ships zero styling; the host
styles the `data-pyric-*` contract (`proposed-change-diff` /
`data-pyric-change-*`). The c-review diff grid is this, styled.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`ProposedChangeDiffProps`](#proposedchangediffprops) |

#### Returns

`Element`

***

<a id="useactivitydigest"></a>

### useActivityDigest()

```ts
function useActivityDigest(events: readonly AnyActivityEvent[], options?: UseActivityDigestOptions): ActivityDigest;
```

React wrapper over [computeActivityDigest](#computeactivitydigest) — memoizes the pure
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
| `events` | readonly [`AnyActivityEvent`](#anyactivityevent)[] |
| `options?` | [`UseActivityDigestOptions`](#useactivitydigestoptions) |

#### Returns

[`ActivityDigest`](#activitydigest)

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
