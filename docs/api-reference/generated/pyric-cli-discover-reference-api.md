---
title: "API reference: @pyric/cli/discover"
navLabel: "@pyric/cli/discover"
outcome: "Published declarations for @pyric/cli/discover."
slug: "pyric-cli-discover-reference-api"
kind: "api"
apiPackage: "@pyric/cli"
apiImportPath: "@pyric/cli/discover"
apiSubpath: "discover"
apiSymbolCount: 65
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Classes

<a id="localenvironmentcrawleradapter"></a>

### LocalEnvironmentCrawlerAdapter

Wrap a LocalEnvironment as a Firestore root that satisfies
the discover/crawler + find-collection-group contracts.

#### Implements

- [`CrawlerFirestore`](#crawlerfirestore)
- [`CollectionGroupCapableFirestore`](#collectiongroupcapablefirestore)

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new LocalEnvironmentCrawlerAdapter(env: LocalEnvironment): LocalEnvironmentCrawlerAdapter;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `env` | `LocalEnvironment` |

###### Returns

[`LocalEnvironmentCrawlerAdapter`](#localenvironmentcrawleradapter)

#### Methods

<a id="collection"></a>

##### collection()

```ts
collection(path: string): CrawlerCollectionRef;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

###### Returns

[`CrawlerCollectionRef`](#crawlercollectionref)

###### Implementation of

[`CrawlerFirestore`](#crawlerfirestore).[`collection`](#collection-2)

<a id="collectiongroup"></a>

##### collectionGroup()

```ts
collectionGroup(collectionId: string): CollectionGroupQuery;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `collectionId` | `string` |

###### Returns

[`CollectionGroupQuery`](#collectiongroupquery)

###### Implementation of

[`CollectionGroupCapableFirestore`](#collectiongroupcapablefirestore).[`collectionGroup`](#collectiongroup-2)

<a id="doc"></a>

##### doc()

```ts
doc(path: string): CrawlerDocumentRef;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

###### Returns

[`CrawlerDocumentRef`](#crawlerdocumentref)

###### Implementation of

[`CrawlerFirestore`](#crawlerfirestore).[`doc`](#doc-2)

<a id="listcollections"></a>

##### listCollections()

```ts
listCollections(): Promise<CrawlerCollectionRef[]>;
```

###### Returns

`Promise`\<[`CrawlerCollectionRef`](#crawlercollectionref)[]\>

###### Implementation of

[`CrawlerFirestore`](#crawlerfirestore).[`listCollections`](#listcollections-4)

***

<a id="semaphore"></a>

### Semaphore

FIFO counting semaphore. `acquire()` resolves immediately while
fewer than `max` permits are checked out, otherwise it queues until
a `release()` frees a slot. Waiters are served in arrival order.

`release()` without a prior `acquire()` is a no-op (does not go
negative). This is intentional — it lets defensive `try/finally`
release in error paths without bookkeeping.

#### Constructors

<a id="constructor-1"></a>

##### Constructor

```ts
new Semaphore(max: number): Semaphore;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `max` | `number` |

###### Returns

[`Semaphore`](#semaphore)

#### Accessors

<a id="inflight"></a>

##### inFlight

###### Get Signature

```ts
get inFlight(): number;
```

Number of permits currently checked out. For tests and instrumentation
only; do not branch on this in production logic.

###### Returns

`number`

<a id="pending"></a>

##### pending

###### Get Signature

```ts
get pending(): number;
```

Number of waiters queued. For tests and instrumentation only.

###### Returns

`number`

#### Methods

<a id="acquire"></a>

##### acquire()

```ts
acquire(): Promise<void>;
```

###### Returns

`Promise`\<`void`\>

<a id="release"></a>

##### release()

```ts
release(): void;
```

###### Returns

`void`

***

<a id="sessionstore"></a>

### SessionStore

In-process LRU session store with TTL sweep and per-session byte cap.

Eviction policy:
  1. On every `create`/`get`/`update`, sweep TTL-expired sessions first.
     Their tokens land in the eviction log as `SESSION_EXPIRED`.
  2. If `create` would exceed `maxSessions`, evict the LRU
     (oldest-by-`lastAccessedAt`). Its token lands in the eviction log
     as `SESSION_EVICTED` so the displaced agent gets a meaningful
     error on its next call.
  3. `update` rejects with `SESSION_PAYLOAD_TOO_LARGE` if the new
     `bytes` exceeds `maxSessionBytes` (per-session cap, not aggregate).

The eviction log is a bounded ring buffer; once it overflows, evicted
tokens degrade silently to `SESSION_EXPIRED` (still actionable — the
recoveryHint is the same: re-issue without continuation).

#### Type Parameters

| Type Parameter |
| :------ |
| `TState` |

#### Constructors

<a id="constructor-2"></a>

##### Constructor

```ts
new SessionStore<TState>(opts?: SessionStoreOptions): SessionStore<TState>;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `opts?` | [`SessionStoreOptions`](#sessionstoreoptions) |

###### Returns

[`SessionStore`](#sessionstore)\<`TState`\>

#### Accessors

<a id="size"></a>

##### size

###### Get Signature

```ts
get size(): number;
```

Live session count.

###### Returns

`number`

#### Methods

<a id="create"></a>

##### create()

```ts
create(state: TState, bytes: number): SessionResult<SessionRecord<TState>>;
```

Create a new session. Always succeeds unless `bytes` exceeds the
per-session byte cap. On cap-hit, evicts the LRU session — the
displaced token will report `SESSION_EVICTED` on its next access.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `state` | `TState` |
| `bytes` | `number` |

###### Returns

[`SessionResult`](#sessionresult)\<[`SessionRecord`](#sessionrecord)\<`TState`\>\>

<a id="delete"></a>

##### delete()

```ts
delete(token: string): boolean;
```

Best-effort delete; returns true if a session was removed.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `token` | `string` |

###### Returns

`boolean`

<a id="get"></a>

##### get()

```ts
get(token: string): SessionResult<SessionRecord<TState>>;
```

Look up a session by token. Touches `lastAccessedAt` on success so
subsequent reads keep the session warm. On expired/malformed/evicted
tokens returns the appropriate structured error.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `token` | `string` |

###### Returns

[`SessionResult`](#sessionresult)\<[`SessionRecord`](#sessionrecord)\<`TState`\>\>

<a id="sweepexpired"></a>

##### sweepExpired()

```ts
sweepExpired(now?: number): number;
```

Drop sessions whose `lastAccessedAt + ttlMs` is in the past.
Returns the number of sessions evicted. Public for tests +
future scheduled-sweep usage; `create`/`get`/`update` all call it
lazily so callers don't normally need to.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `now?` | `number` |

###### Returns

`number`

<a id="update"></a>

##### update()

```ts
update(
   token: string,
   state: TState,
bytes: number): SessionResult<SessionRecord<TState>>;
```

Replace the state of an existing session. Same lookup/error model
as `get`, plus per-session-bytes enforcement on the new payload.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `token` | `string` |
| `state` | `TState` |
| `bytes` | `number` |

###### Returns

[`SessionResult`](#sessionresult)\<[`SessionRecord`](#sessionrecord)\<`TState`\>\>

***

<a id="wireprotounavailableerror"></a>

### WireProtoUnavailableError

Thrown when `DocumentSnapshot._fieldsProto` is unavailable or malformed.
Per prerequisite 0.A, the wire reader does NOT silently fall back to
`data()` — that would collapse integer/double at the value boundary
and corrupt every downstream codegen consumer.

#### Extends

- `Error`

#### Constructors

<a id="constructor-3"></a>

##### Constructor

```ts
new WireProtoUnavailableError(opts: {
  docPath: string;
  reason: string;
}): WireProtoUnavailableError;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `opts` | \{ `docPath`: `string`; `reason`: `string`; \} |
| `opts.docPath` | `string` |
| `opts.reason` | `string` |

###### Returns

[`WireProtoUnavailableError`](#wireprotounavailableerror)

###### Overrides

```ts
Error.constructor
```

#### Properties

| Property | Modifier | Type | Default value | Overrides |
| :------ | :------ | :------ | :------ | :------ |
| <a id="name"></a> `name` | `readonly` | `"WireProtoUnavailableError"` | `"WireProtoUnavailableError"` | `Error.name` |

## Interfaces

<a id="collectiongroupcapablefirestore"></a>

### CollectionGroupCapableFirestore

Optional source capability used by `findCollectionGroup`.

#### Methods

<a id="collectiongroup-2"></a>

##### collectionGroup()

```ts
collectionGroup(collectionId: string): CollectionGroupQuery;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `collectionId` | `string` |

###### Returns

[`CollectionGroupQuery`](#collectiongroupquery)

***

<a id="collectiongroupquery"></a>

### CollectionGroupQuery

Minimal collection-group query shape used by host discovery.

#### Methods

<a id="get-2"></a>

##### get()

```ts
get(): Promise<{
  docs: CollectionGroupSnapshot[];
}>;
```

###### Returns

`Promise`\<\{
  `docs`: [`CollectionGroupSnapshot`](#collectiongroupsnapshot)[];
\}\>

<a id="limit"></a>

##### limit()

```ts
limit(n: number): CollectionGroupQuery;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `n` | `number` |

###### Returns

[`CollectionGroupQuery`](#collectiongroupquery)

<a id="select"></a>

##### select()

```ts
select(...fields: string[]): CollectionGroupQuery;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| ...`fields` | `string`[] |

###### Returns

[`CollectionGroupQuery`](#collectiongroupquery)

***

<a id="collectiongroupsnapshot"></a>

### CollectionGroupSnapshot

Parent-path projection used by collection-group discovery.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="ref"></a> `ref` | \{ `parent`: \{ `path`: `string`; \}; \} |
| `ref.parent` | \{ `path`: `string`; \} |
| `ref.parent.path` | `string` |

***

<a id="collectionschema"></a>

### CollectionSchema

Schema for a single collection as surfaced in the tool output's
`finalizedSchemas`.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="declaredat"></a> `declaredAt` | `number` |
| <a id="examplepath"></a> `examplePath?` | `string` |
| <a id="samplingcomplete"></a> `samplingComplete` | [`SamplingComplete`](#samplingcomplete-1) |
| <a id="schema"></a> `schema` | [`FieldSchema`](#fieldschema) |
| <a id="subcollectiontemplatepaths"></a> `subcollectionTemplatePaths` | `string`[] |
| <a id="templatepath"></a> `templatePath` | `string` |

***

<a id="convergenceresult"></a>

### ConvergenceResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="declaredat-1"></a> `declaredAt` | `number` | Doc index where `stopOnStable` fired (0-based), or null if never. |
| <a id="finalschema"></a> `finalSchema` | [`FieldSchema`](#fieldschema) | Final accumulated schema. |
| <a id="missedchangesafterdeclared"></a> `missedChangesAfterDeclared` | [`SchemaChange`](#schemachange)[] | Changes emitted *after* convergence was declared — caller-visible for test-time assertion that `stopOnStable` would not have lost data. |
| <a id="totalchanges"></a> `totalChanges` | `number` | Total change count across the stream. |
| <a id="totaldocs"></a> `totalDocs` | `number` | Total docs consumed (≤ stream length). |

***

<a id="crawlercollectionref"></a>

### CrawlerCollectionRef

Minimal collection-reference shape needed for traversal.

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="id"></a> `id` | `readonly` | `string` |
| <a id="path"></a> `path` | `readonly` | `string` |

#### Methods

<a id="listdocuments"></a>

##### listDocuments()

```ts
listDocuments(): Promise<CrawlerDocumentRef[]>;
```

###### Returns

`Promise`\<[`CrawlerDocumentRef`](#crawlerdocumentref)[]\>

***

<a id="crawlerdocumentref"></a>

### CrawlerDocumentRef

Minimal document-reference shape needed for traversal and sampling.

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="id-1"></a> `id` | `readonly` | `string` |
| <a id="path-1"></a> `path` | `readonly` | `string` |

#### Methods

<a id="get-4"></a>

##### get()

```ts
get(): Promise<WireDocumentSnapshot>;
```

###### Returns

`Promise`\<[`WireDocumentSnapshot`](#wiredocumentsnapshot)\>

<a id="listcollections-2"></a>

##### listCollections()

```ts
listCollections(): Promise<CrawlerCollectionRef[]>;
```

###### Returns

`Promise`\<[`CrawlerCollectionRef`](#crawlercollectionref)[]\>

***

<a id="crawlerfirestore"></a>

### CrawlerFirestore

Firestore-shaped source consumed by the crawler.

`collection` and `doc` are needed only when resuming a continuation.

#### Methods

<a id="collection-2"></a>

##### collection()?

```ts
optional collection(path: string): CrawlerCollectionRef;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

###### Returns

[`CrawlerCollectionRef`](#crawlercollectionref)

<a id="doc-2"></a>

##### doc()?

```ts
optional doc(path: string): CrawlerDocumentRef;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

###### Returns

[`CrawlerDocumentRef`](#crawlerdocumentref)

<a id="listcollections-4"></a>

##### listCollections()

```ts
listCollections(): Promise<CrawlerCollectionRef[]>;
```

###### Returns

`Promise`\<[`CrawlerCollectionRef`](#crawlercollectionref)[]\>

***

<a id="crawloptions"></a>

### CrawlOptions

Crawl options. All fields are optional with documented defaults.

- `maxConcurrency`: in-flight RPC cap. Default 32 per the Risk #1 sweep
  on 2026-05-05. Sweep over `{4, 8, 16, 32, 64}` against the corpus
  showed `4 → 8 → 16 → 32 → 64` was a steady ~10–15% per-doubling
  descent (no plateau). 32 was picked over 64 because the curve hadn't
  flattened — 64 was the cap of the test range, not a true knee — and
  doubling in-flight RPCs again increases the chance of tripping
  per-project connection/quota limits in agent environments. Agents
  that want max speed can override.
- `maxDepth`: hard cap on BFS layers from the root. Defaults to 10
  (well above any real-world Firestore tree). Used as a runaway guard,
  not an agent-facing knob.
- `rootFilter`: optional predicate on root collection IDs. Used by tests
  and the corpus harness to scope discovery to a known prefix without
  walking the entire database.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="continuation"></a> `continuation?` | `string` | Resume a previously paused crawl. Only valid when a `SessionStore` is passed to `crawl()`. The token is the `continuation` value from a prior paused result. Malformed/expired tokens surface as a `SESSION_EXPIRED`/`SESSION_EVICTED`/`SESSION_MALFORMED_TOKEN` error event with no other side effects (per 0.C). |
| <a id="dryrun"></a> `dryRun?` | `boolean` | Informational-only cost preview. When `true`, the crawler issues exactly **one** RPC — `db.listCollections()` at the root — and returns a heuristic projection of what a real crawl would cost. No documents are read, no per-doc `listCollections` calls are made, no sampling occurs. The result has empty `discovered` and `finalizedSchemas`, `complete: true`, and `continuation: undefined`. It is **not** a partial crawl that can be resumed — to "commit", call `crawl()` again with `dryRun: false` (a fresh full crawl). Rationale: an agent reading `dryRun: true` reasonably expects no real crawl happened. Doing a structure walk under that flag would let the agent make decisions on data it didn't realize it paid for. See Item 5 revision in the implementation plan. Default `false`. |
| <a id="dryrunsubtreemultiplier"></a> `dryRunSubtreeMultiplier?` | `number` | Heuristic multiplier used in the dryRun cost projection: assumes each root collection has roughly this many subtree-collections (root + descendants) on average. Default 3 — conservative for typical app schemas. Surfaced as an option so agents tuning for known shapes can revise. Only consulted when `dryRun: true`. |
| <a id="maxbatchbytes"></a> `maxBatchBytes?` | `number` | Pause threshold for batch payload size. After each layer (structure phase) and each templatePath (sampling phase) the crawler measures the JSON-serialized state size; if it exceeds this many bytes, the crawl pauses and returns a continuation token. Default 1 MB per Phase 0.4 sizing — well below `maxSessionBytes=32MB` so the agent has headroom for response framing. Only effective when a `SessionStore` is provided to `crawl()`. With no store, single-call mode runs to completion regardless of size. |
| <a id="maxconcurrency"></a> `maxConcurrency?` | `number` | - |
| <a id="maxdepth"></a> `maxDepth?` | `number` | - |
| <a id="maxerrorspercollection"></a> `maxErrorsPerCollection?` | `number` | Per-templatePath cap on tolerated PERMISSION_DENIED / transient errors during sampling. Default 3 per prerequisite 0.E. Past this threshold, sampling for the templatePath stops and `samplingComplete` is set to `sampling_open` so the agent can see the collection wasn't fully sampled. Errors during structure discovery are emitted but do not count toward this cap. |
| <a id="maxsamples"></a> `maxSamples?` | `number` | Hard cap on docs sampled per templatePath. Default 50 per Phase 2.1 lock. Item 3 will add adaptive `stopOnStable` early-exit on top of this cap; for now sampling reads exactly `min(maxSamples, available)` docs per templatePath. |
| <a id="rootfilter"></a> `rootFilter?` | (`collectionId`: `string`) => `boolean` | - |
| <a id="stoponstable"></a> `stopOnStable?` | `number` | Adaptive early-exit threshold. After this many consecutive no-change merges in a templatePath's sampling stream, sampling stops and `samplingComplete` is set to `converged_via_stable`. Default 8 per Phase 2.1 lock. Set to a value > maxSamples to disable early-exit (the hard cap then governs). Reads are issued in chunks of `stopOnStable` so an early-exit avoids fetching the remainder of `sampleRefs`. Worst-case wasted-read count per templatePath is `stopOnStable - 1`. |

***

<a id="crawlresult"></a>

### CrawlResult

#### Extended by

- [`FullCrawlResult`](#fullcrawlresult)

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="discovered"></a> `discovered` | `Map`\<`string`, [`DiscoveredCollection`](#discoveredcollection)\> | - |
| <a id="events"></a> `events` | [`DiscoverEvent`](#discoverevent)[] | - |
| <a id="listops"></a> `listOps` | `number` | Total `listCollections` + `listDocuments` calls — feeds cost reporting. |

***

<a id="discoveredcollection"></a>

### DiscoveredCollection

Per-template-path bookkeeping built up during a crawl. Collection refs
are kept here for Item 2.3 to drive document sampling.

Multiple concrete collection paths may collapse to the same template
path (e.g. `users/uid_1/posts` and `users/uid_2/posts` both map to
`users/{userId}/posts`); their refs are accumulated under one entry.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="depth"></a> `depth` | `number` | - |
| <a id="docrefs"></a> `docRefs` | [`CrawlerDocumentRef`](#crawlerdocumentref)[] | Doc refs accumulated across `refs` during BFS expansion. Sampling draws from this pool — re-listing would double the listDocuments cost we already paid during structure discovery. |
| <a id="examplepath-1"></a> `examplePath` | `string` | First concrete collection path encountered for this template. |
| <a id="refs"></a> `refs` | [`CrawlerCollectionRef`](#crawlercollectionref)[] | All concrete collection refs that share this template path. |
| <a id="templatepath-1"></a> `templatePath` | `string` | - |

***

<a id="discoverpathstoolresult"></a>

### DiscoverPathsToolResult

JSON-serializable shape returned by `firestore_discover_paths`.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="complete"></a> `complete` | `boolean` | True iff the crawl finished. Equivalent to `continuation === undefined`. |
| <a id="continuation-1"></a> `continuation?` | `string` | Opaque resume handle iff the crawl paused at a payload boundary. |
| <a id="dryruncostestimate"></a> `dryRunCostEstimate?` | [`DryRunCostEstimate`](#dryruncostestimate-1) | Present iff this was a `dryRun: true` preview. |
| <a id="events-1"></a> `events` | [`DiscoverEvent`](#discoverevent)[] | - |
| <a id="listops-1"></a> `listOps` | `number` | `listCollections` + `listDocuments` calls — cumulative across batches. |
| <a id="readops"></a> `readOps` | `number` | `.get()` calls during sampling — cumulative across batches. |
| <a id="schemas"></a> `schemas` | `Record`\<`string`, [`CollectionSchema`](#collectionschema)\> | Per-templatePath finalized schemas, keyed by templatePath. |

***

<a id="dryruncostestimate-1"></a>

### DryRunCostEstimate

Heuristic cost projection returned by `dryRun: true`. The numbers are
upper-bound estimates — agents should treat them as "no more than"
figures, not exact predictions. Formulas are documented in-line so
consumers can sanity-check.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="estimatedlistops"></a> `estimatedListOps` | `number` | Projected total `listCollections` + `listDocuments` cost of a real crawl: `1 + rootCount × subtreeMultiplier`. The `1` is the root `listCollections`; each subtree contributes one `listDocuments` call to enumerate docs. Per-doc `listCollections` cost is folded into the multiplier (a subtree of 3 implies ~2 layers of doc listings). |
| <a id="estimatedreadops"></a> `estimatedReadOps` | `number` | Projected total `.get()` cost of sampling: `rootCount × subtreeMultiplier × maxSamples`. Upper bound — `stopOnStable` early-exit and `cappedByMax` can reduce the actual draw. |
| <a id="maxsamples-1"></a> `maxSamples` | `number` | The `maxSamples` value the projection used. |
| <a id="rootcollectioncount"></a> `rootCollectionCount` | `number` | Number of root collections discovered by the single root listCollections call. |
| <a id="rootcollectionids"></a> `rootCollectionIds` | `string`[] | The root collection IDs (after `rootFilter` is applied, if any). |
| <a id="subtreemultiplier"></a> `subtreeMultiplier` | `number` | The `dryRunSubtreeMultiplier` value the projection used. |

***

<a id="enumcandidate"></a>

### EnumCandidate

Captured low-cardinality value set for enum-candidate fields.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="qualifies"></a> `qualifies` | `boolean` | Whether the field still passes the threshold; flips to false if widened past it. |
| <a id="threshold"></a> `threshold` | `number` | Distinct count after which the candidate is dropped (default 10). |
| <a id="values"></a> `values` | (`string` \| `number`)[] | Distinct values observed so far (string/number); ordered by first-seen. |

***

<a id="fielddescriptor"></a>

### FieldDescriptor

Per-field descriptor accumulated across a sampled stream.

- `types` is a deduped union; vector-dim drift keeps each dimension as a
  distinct entry by default (Phase 1.2 lock).
- `presenceSeen / presenceTotal` ratio drives presence-based agent UX; the
  denominator includes docs where the field was absent.
- `nullable` is an annotation, not a peer type (Phase 2.1 lock — `null`
  never appears as a `FieldType` in this descriptor's types[]).
- `enumCandidate` populated when the field qualifies per Phase 3.2 lock
  (`distinct ≤ 10 AND distinct ≤ samplesSeen / 2`); otherwise `undefined`.
  Tracked only for `scalar:string` and `scalar:integer/double`; other kinds
  are not enum candidates.
- `example` is one observed non-null value per Phase 3.2 lock. Drives form
  placeholders, fixtures, README payloads. JSON-stringifiable (wire-typed
  primitives + arrays + plain-object maps).
- `reservedReason` populated by the wire layer when the field name matches
  a reserved-name pattern per 0.B; agents/codegen use it to skip or
  sanitize the field.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="enumcandidate-1"></a> `enumCandidate?` | [`EnumCandidate`](#enumcandidate) |
| <a id="example"></a> `example?` | [`ExampleValue`](#examplevalue) |
| <a id="nullable"></a> `nullable` | `boolean` |
| <a id="presenceseen"></a> `presenceSeen` | `number` |
| <a id="presencetotal"></a> `presenceTotal` | `number` |
| <a id="reservedreason"></a> `reservedReason?` | [`ReservedFieldReason`](#reservedfieldreason) |
| <a id="types"></a> `types` | [`FieldType`](#fieldtype)[] |

***

<a id="fieldobservation"></a>

### FieldObservation

A single field observation passed into `mergeDoc`. The wire layer
(`wire.ts`) is responsible for producing this shape.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="enumsample"></a> `enumSample?` | `EnumSample` | For enum-eligible scalars (string/int/double), the raw value. Used to update enumCandidate. |
| <a id="example-1"></a> `example?` | `ExampleValue` | A JSON-safe sample of the wire value. Used to populate `example` on the descriptor when no example exists yet. Optional — wire layer omits for kinds with no codegen-friendly representation. |
| <a id="isnull"></a> `isNull` | `boolean` | True iff the wire value was a null literal. |
| <a id="type"></a> `type` | [`FieldType`](#fieldtype) | The inferred FieldType for this observation. `null` is allowed and is surfaced via `isNull`; the `type` itself is `{kind:'scalar', type:'null'}` by convention but is NOT added to the descriptor's types[] union. |

***

<a id="fieldschema"></a>

### FieldSchema

Per-collection accumulated schema. `samplesSeen` is the doc count fed
through `mergeDoc`, used as the presence denominator.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="fields"></a> `fields` | `Record`\<`string`, [`FieldDescriptor`](#fielddescriptor)\> |
| <a id="samplesseen"></a> `samplesSeen` | `number` |

***

<a id="findcollectiongrouphost"></a>

### FindCollectionGroupHost

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="sampledoccount"></a> `sampleDocCount` | `number` | Number of docs in the N-doc draw that shared this parent path. NOT the host's total doc count — that's a separate query. |
| <a id="templatepath-2"></a> `templatePath` | `string` | Template-form parent collection path, e.g. `users/{userId}/posts`. |

***

<a id="findcollectiongroupoptions"></a>

### FindCollectionGroupOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="limit-2"></a> `limit?` | `number` | Max docs to fetch from the collection group. Default 100 — covers ~22 distinct hosts with high confidence per the coupon-collector heuristic. Raise this if the result reports `limitWasReached: true` and you suspect more hosts exist. |

***

<a id="findcollectiongroupresult"></a>

### FindCollectionGroupResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="hosts"></a> `hosts` | [`FindCollectionGroupHost`](#findcollectiongrouphost)[] | Discovered hosts, deduped by templatePath. Order is insertion order (i.e. the order in which the first matching doc surfaced). |
| <a id="limitwasreached"></a> `limitWasReached` | `boolean` | True iff `reads === limit`, signaling the agent should consider raising `limit` if they need exhaustive host coverage. |
| <a id="reads"></a> `reads` | `number` | Total docs read — the cost line item. Always `min(limit, totalDocsInGroup)`. |

***

<a id="firestorediscovertooldeps"></a>

### FirestoreDiscoverToolDeps

#### Methods

<a id="resolvedb"></a>

##### resolveDb()

```ts
resolveDb(): CrawlerFirestore & CollectionGroupCapableFirestore;
```

Resolver returning the CrawlerFirestore to scan. Called per
dispatch (F4). For `firestore_find_collection_group` the returned
Firestore must also satisfy [CollectionGroupCapableFirestore](#collectiongroupcapablefirestore).

###### Returns

[`CrawlerFirestore`](#crawlerfirestore) & [`CollectionGroupCapableFirestore`](#collectiongroupcapablefirestore)

***

<a id="fullcrawlresult"></a>

### FullCrawlResult

Result of a full crawl (structure + sampling). Augments `CrawlResult`
with the per-templatePath finalized schemas the agent surface consumes.

`continuation` is present iff the crawl paused at a `maxBatchBytes`
boundary; agents resume by calling `crawl(db, { continuation }, sessions)`.
`complete` is true iff the crawl finished — equivalent to
`continuation === undefined` but more readable at call sites.

Counter fields (`listOps`, `readOps`) are *cumulative* across batches:
a paused crawl returns the running total so the agent's cost-reporting
doesn't have to do the bookkeeping.

#### Extends

- [`CrawlResult`](#crawlresult)

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="complete-1"></a> `complete` | `boolean` | True iff the crawl completed (no continuation pending). |
| <a id="continuation-2"></a> `continuation?` | `string` | Opaque resume handle (only present when paused). |
| <a id="discovered-1"></a> `discovered` | `Map`\<`string`, [`DiscoveredCollection`](#discoveredcollection)\> | - |
| <a id="dryruncostestimate-2"></a> `dryRunCostEstimate?` | [`DryRunCostEstimate`](#dryruncostestimate-1) | Present iff the crawl was a `dryRun: true` preview. Heuristic projection of what a full crawl would cost; see [CrawlOptions.dryRun](#dryrun). |
| <a id="events-2"></a> `events` | [`DiscoverEvent`](#discoverevent)[] | - |
| <a id="finalizedschemas"></a> `finalizedSchemas` | `Map`\<`string`, [`CollectionSchema`](#collectionschema)\> | - |
| <a id="listops-2"></a> `listOps` | `number` | Total `listCollections` + `listDocuments` calls — feeds cost reporting. |
| <a id="readops-1"></a> `readOps` | `number` | `.get()` calls issued during sampling — feeds cost reporting. |

***

<a id="persistedcrawlstate"></a>

### PersistedCrawlState

JSON-serializable snapshot of an in-progress crawl. Stored in the
session between batches. Refs (CollectionRef/DocumentRef) carry
methods so they can't be persisted directly — we serialize their
paths and reconstruct via `db.collection(path)` / `db.doc(path)` on
resume.

Phase invariants:
  - `structure` phase: `frontierPaths` may be non-empty; `samplingQueue`
    is empty.
  - `sampling` phase: `frontierPaths` is empty; `samplingQueue` lists
    the templatePaths still pending. Existing entries in
    `finalizedSchemas` are immutable across the rest of the crawl.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="currentdepth"></a> `currentDepth` | `number` | Layer index after the last completed structure pass. |
| <a id="discovered-2"></a> `discovered` | `Record`\<`string`, [`PersistedDiscoveredCollection`](#persisteddiscoveredcollection)\> | Discovered map serialized — all paths only, refs reconstructed on resume. |
| <a id="finalizedschemas-1"></a> `finalizedSchemas` | `Record`\<`string`, [`CollectionSchema`](#collectionschema)\> | Per-templatePath finalized schemas — immutable once set. |
| <a id="frontierpaths"></a> `frontierPaths` | `string`[] | Concrete collection paths to expand in the next structure layer. |
| <a id="listops-3"></a> `listOps` | `number` | Cumulative cost counters across batches. |
| <a id="maxdepth-1"></a> `maxDepth` | `number` | Crawl options carried so resume preserves caps the agent set. |
| <a id="phase"></a> `phase` | `"structure"` \| `"sampling"` | - |
| <a id="readops-2"></a> `readOps` | `number` | - |
| <a id="samplingqueue"></a> `samplingQueue` | `string`[] | TemplatePaths still to sample. Drained left-to-right. |

***

<a id="persisteddiscoveredcollection"></a>

### PersistedDiscoveredCollection

Persisted shape of a `DiscoveredCollection` (refs → paths).

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="depth-1"></a> `depth` | `number` |
| <a id="docrefpaths"></a> `docRefPaths` | `string`[] |
| <a id="examplepath-2"></a> `examplePath` | `string` |
| <a id="refpaths"></a> `refPaths` | `string`[] |
| <a id="templatepath-3"></a> `templatePath` | `string` |

***

<a id="sessionerror"></a>

### SessionError

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="code"></a> `code` | [`SessionErrorCode`](#sessionerrorcode-1) |
| <a id="message"></a> `message` | `string` |
| <a id="recoveryhint"></a> `recoveryHint` | `string` |

***

<a id="sessionrecord"></a>

### SessionRecord

A live session record. `state` is opaque to the store — Item 4.2 will
instantiate `SessionStore` with the concrete crawler-state type.

#### Type Parameters

| Type Parameter |
| :------ |
| `TState` |

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="bytes"></a> `bytes` | `public` | `number` | Caller-reported payload size for byte-cap enforcement. |
| <a id="createdat"></a> `createdAt` | `readonly` | `number` | - |
| <a id="id-2"></a> `id` | `readonly` | `string` | Raw ULID — internal id; not the token surfaced to agents. |
| <a id="lastaccessedat"></a> `lastAccessedAt` | `public` | `number` | Last get/update; drives both LRU eviction and TTL. |
| <a id="state"></a> `state` | `public` | `TState` | - |
| <a id="token"></a> `token` | `readonly` | `string` | Opaque continuation handle: `disc_<base64url-ulid>`. |

***

<a id="sessionstoreoptions"></a>

### SessionStoreOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="evictionlogsize"></a> `evictionLogSize?` | `number` | - |
| <a id="maxsessionbytes"></a> `maxSessionBytes?` | `number` | - |
| <a id="maxsessions"></a> `maxSessions?` | `number` | - |
| <a id="now"></a> `now?` | () => `number` | Test seam — defaults to `Date.now`. |
| <a id="randombytes"></a> `randomBytes?` | (`n`: `number`) => `Uint8Array` | Test seam — defaults to `crypto.randomBytes`. |
| <a id="ttlms"></a> `ttlMs?` | `number` | - |

***

<a id="wiredocumentsnapshot"></a>

### WireDocumentSnapshot

Minimal document snapshot shape needed for wire-type inference.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="ref-1"></a> `ref?` | \{ `path?`: `string`; \} |
| `ref.path?` | `string` |

## Type Aliases

<a id="discoverevent"></a>

### DiscoverEvent

```ts
type DiscoverEvent =
  | {
  depth: number;
  kind: "collection_discovered";
  parentPath?: string;
  templatePath: string;
}
  | {
  changes: SchemaChange[];
  kind: "schema_updated";
  templatePath: string;
}
  | {
  declaredAt: number | null;
  kind: "sampling_complete";
  samplesSeen: number;
  samplingComplete: SamplingComplete;
  templatePath: string;
}
  | {
  code: string;
  kind: "error";
  message: string;
  templatePath: string;
};
```

Event stream emitted by `firestore_discover_paths`. Frozen enum per
Phase 3.3 lock. Order within a batch is meaningful — agents may rely on
`collection_discovered` arriving before `schema_updated` for the same path.

***

<a id="examplevalue"></a>

### ExampleValue

```ts
type ExampleValue =
  | string
  | number
  | boolean
  | null
  | ExampleValue[]
  | {
[k: string]: ExampleValue;
};
```

A representative observed value, JSON-safe.

***

<a id="fieldpath"></a>

### FieldPath

```ts
type FieldPath = ReadonlyArray<string | "[]">;
```

Path within a doc to a field. `'[]'` segment denotes array element scope,
used for nested-array/map descriptors.

***

<a id="fieldtype"></a>

### FieldType

```ts
type FieldType =
  | {
  kind: "scalar";
  type: FirestoreScalarType;
}
  | {
  kind: "reference";
  targetCollection: string;
}
  | {
  elementTypes: FieldType[];
  kind: "array";
}
  | {
  fields: Record<string, FieldDescriptor>;
  kind: "map";
}
  | {
  dimension: number | "mixed";
  kind: "vector";
};
```

One observed type for a field. Vector kept distinct from map per Phase 1.2
vector-sentinel lock; reference target is the **template-form full path**
per Phase 3.1 lock (`users/{userId}/posts`, not `posts`).

***

<a id="firestorescalartype"></a>

### FirestoreScalarType

```ts
type FirestoreScalarType =
  | "null"
  | "boolean"
  | "integer"
  | "double"
  | "timestamp"
  | "string"
  | "bytes"
  | "geopoint";
```

Firestore scalar wire types. Matches the discriminator emitted by
`_fieldsProto.<field>.valueType` (Phase 0.1 lock).

`null` is represented as a scalar so descriptors can carry a single union
shape; the merge layer separately tracks `nullable` per descriptor.

***

<a id="reservedfieldreason"></a>

### ReservedFieldReason

```ts
type ReservedFieldReason =
  | "firestore_reserved_name"
  | "dotted_field_name"
  | "numeric_field_name"
  | "double_underscore_wrap";
```

Why a field name is flagged reserved per 0.B.

***

<a id="samplingcomplete-1"></a>

### SamplingComplete

```ts
type SamplingComplete =
  | "converged_via_stable"
  | "converged_via_exhausted"
  | "converged_via_max"
  | "sampling_open";
```

4-state classification for sampling termination per Phase 2.2 lock.

- `converged_via_stable`: hit `stopOnStable` consecutive no-change docs.
  Schema is *probably* complete — known false-negative is mid-stream drift
  later than `stopOnStable` docs into the stable region (out of scope per
  Phase 2.1 lock; deferred to a future `firestore_re_crawl`).
- `converged_via_exhausted`: iterator returned empty before `maxSamples`.
  Schema is *provably* complete — we read every doc.
- `converged_via_max`: hit `maxSamples` cap without converging. Schema may
  be incomplete; agent should treat with caution.
- `sampling_open`: crawl interrupted (continuation boundary). Resume with
  the returned continuation handle to keep sampling.

***

<a id="schemachange"></a>

### SchemaChange

```ts
type SchemaChange =
  | {
  kind: "field_added";
  path: FieldPath;
  type: FieldType;
}
  | {
  addedType: FieldType;
  kind: "type_expanded";
  path: FieldPath;
}
  | {
  kind: "presence_changed";
  path: FieldPath;
  presenceSeen: number;
  presenceTotal: number;
}
  | {
  kind: "enum_added";
  path: FieldPath;
  values: (string | number)[];
}
  | {
  addedValue: string | number;
  kind: "enum_widened";
  path: FieldPath;
}
  | {
  kind: "enum_dropped";
  path: FieldPath;
  reason: "over_threshold" | "type_widened";
}
  | {
  addedDimension: number;
  kind: "vector_dim_drift";
  path: FieldPath;
}
  | {
  kind: "became_nullable";
  path: FieldPath;
};
```

Frozen `SchemaChange` enum per Phase 5 implementation plan lock. Emitted
by the merge layer; carried in `schema_updated` events.

Renamed from v1 scope's `ChangeReason` to match the agent-facing terminology
in the validation plan's event-model lock.

***

<a id="sessionerrorcode-1"></a>

### SessionErrorCode

```ts
type SessionErrorCode =
  | "SESSION_EXPIRED"
  | "SESSION_EVICTED"
  | "SESSION_PAYLOAD_TOO_LARGE"
  | "SESSION_MALFORMED_TOKEN";
```

***

<a id="sessionresult"></a>

### SessionResult

```ts
type SessionResult<T> =
  | {
  ok: true;
  value: T;
}
  | {
  error: SessionError;
  ok: false;
};
```

Discriminated-union result so callers don't have to try/catch.

#### Type Parameters

| Type Parameter |
| :------ |
| `T` |

***

<a id="wirevalue"></a>

### WireValue

```ts
type WireValue = any;
```

## Variables

<a id="default_enum_threshold"></a>

### DEFAULT\_ENUM\_THRESHOLD

```ts
const DEFAULT_ENUM_THRESHOLD: 10 = 10;
```

Default enum-candidate distinct-value cap (Phase 3.2 lock).

***

<a id="default_max_session_bytes"></a>

### DEFAULT\_MAX\_SESSION\_BYTES

```ts
const DEFAULT_MAX_SESSION_BYTES: number;
```

***

<a id="default_max_sessions"></a>

### DEFAULT\_MAX\_SESSIONS

```ts
const DEFAULT_MAX_SESSIONS: 8 = 8;
```

***

<a id="default_ttl_ms"></a>

### DEFAULT\_TTL\_MS

```ts
const DEFAULT_TTL_MS: number;
```

## Functions

<a id="classifyfieldname"></a>

### classifyFieldName()

```ts
function classifyFieldName(name: string): ReservedFieldReason;
```

Classify a field name. Returns undefined for normal names, or a
specific ReservedFieldReason for names that codegen must skip/sanitize.

Rules ordered by specificity (most specific first):
  - exact `__name__` etc. → firestore_reserved_name
  - contains '.'          → dotted_field_name (breaks dot-path access)
  - pure-numeric          → numeric_field_name (looks like array index)
  - __foo__               → double_underscore_wrap (sentinel collision)

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `name` | `string` |

#### Returns

[`ReservedFieldReason`](#reservedfieldreason)

***

<a id="crawl"></a>

### crawl()

```ts
function crawl(
   db: CrawlerFirestore,
   options?: CrawlOptions,
sessions?: SessionStore<PersistedCrawlState>): Promise<FullCrawlResult>;
```

Full crawl: discover structure, then sample up to `maxSamples` docs per
discovered templatePath and feed them through the merge layer. Emits
`schema_updated` events for every non-empty merge and `sampling_complete`
once per templatePath.

**Pause/resume (Item 4.2).** When a `SessionStore` is supplied, the
crawler measures the persisted-state size at two pause boundaries:

  1. End of every BFS layer in the structure phase
  2. End of every templatePath in the sampling phase

If the persisted state exceeds `maxBatchBytes` (default 1 MB), the
crawler persists state and returns a `continuation` token. The agent
resumes by passing `{ continuation }` on the next call. Counters
(`listOps`, `readOps`) are cumulative across batches; events are
per-batch only (agents accumulate them themselves).

Without a `SessionStore`, the crawler runs to completion regardless of
size — single-call mode is unchanged.

**Continuation lifecycle.** Continuation handles are minted/validated by
the supplied `SessionStore` (see `discover/session.ts`). Malformed,
expired, or evicted tokens surface as a single `error` event and an
otherwise-empty result — agents can re-issue without continuation
per the recovery hint.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`CrawlerFirestore`](#crawlerfirestore) |
| `options?` | [`CrawlOptions`](#crawloptions) |
| `sessions?` | [`SessionStore`](#sessionstore)\<[`PersistedCrawlState`](#persistedcrawlstate)\> |

#### Returns

`Promise`\<[`FullCrawlResult`](#fullcrawlresult)\>

***

<a id="crawlstructure"></a>

### crawlStructure()

```ts
function crawlStructure(db: CrawlerFirestore, options?: CrawlOptions): Promise<CrawlResult>;
```

Walk the Firestore tree breadth-first. Each layer issues its
`listDocuments` + per-doc `listCollections` calls in parallel under a
shared concurrency cap.

Returns once every reachable collection (within `maxDepth`) is recorded.
The returned `discovered` map is keyed by templatePath; `events` is the
ordered event log emitted during the walk (currently only
`collection_discovered`).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`CrawlerFirestore`](#crawlerfirestore) |
| `options?` | [`CrawlOptions`](#crawloptions) |

#### Returns

`Promise`\<[`CrawlResult`](#crawlresult)\>

***

<a id="createfirestorediscovertools"></a>

### createFirestoreDiscoverTools()

```ts
function createFirestoreDiscoverTools(deps: FirestoreDiscoverToolDeps): ToolHandler<unknown, unknown>[];
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `deps` | [`FirestoreDiscoverToolDeps`](#firestorediscovertooldeps) |

#### Returns

`ToolHandler`\<`unknown`, `unknown`\>[]

***

<a id="decodetoken"></a>

### decodeToken()

```ts
function decodeToken(token: string): {
  id: string;
};
```

Decode a `disc_<base64url>` token. Returns `null` on any malformation
— caller maps null to `SESSION_MALFORMED_TOKEN`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `token` | `string` |

#### Returns

```ts
{
  id: string;
}
```

##### id

```ts
id: string;
```

***

<a id="emptyschema"></a>

### emptySchema()

```ts
function emptySchema(): FieldSchema;
```

#### Returns

[`FieldSchema`](#fieldschema)

***

<a id="encodetoken"></a>

### encodeToken()

```ts
function encodeToken(ulidBytes: Uint8Array): string;
```

Encode a 16-byte ULID into a `disc_<base64url>` token. Internal — used
by `SessionStore.create`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `ulidBytes` | `Uint8Array` |

#### Returns

`string`

***

<a id="fieldtypekey"></a>

### fieldTypeKey()

```ts
function fieldTypeKey(t: FieldType): string;
```

Stable key for FieldType used in dedup. NaN/±Infinity all collapse to
`s:double` so no special handling needed (Phase 1.2 lock).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `t` | [`FieldType`](#fieldtype) |

#### Returns

`string`

***

<a id="findcollectiongroup"></a>

### findCollectionGroup()

```ts
function findCollectionGroup(
   db: CollectionGroupCapableFirestore,
   collectionId: string,
options?: FindCollectionGroupOptions): Promise<FindCollectionGroupResult>;
```

Find every collection-group host of a given collection ID.

One read per returned doc — cost is bounded by `limit` (default 100).
Returns the hosts in template-path form (e.g. `users/{userId}/posts`)
with the per-host sample doc count.

Throws on Admin SDK errors (network / permission). The tool is
standalone — no session, no continuation, no events — so error
propagation is straightforward.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `db` | [`CollectionGroupCapableFirestore`](#collectiongroupcapablefirestore) |
| `collectionId` | `string` |
| `options?` | [`FindCollectionGroupOptions`](#findcollectiongroupoptions) |

#### Returns

`Promise`\<[`FindCollectionGroupResult`](#findcollectiongroupresult)\>

***

<a id="infertemplatevariable"></a>

### inferTemplateVariable()

```ts
function inferTemplateVariable(collectionId: string): string;
```

Convert a collection ID to the conventional template-variable name a
Firestore rules author would write for its docs. Strips a trailing
snake/dot-cased prefix word so `ttt_lobbies` → `lobbyId` (not
`ttt_lobbieId`).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `collectionId` | `string` |

#### Returns

`string`

***

<a id="mergedescriptorwithobservation"></a>

### mergeDescriptorWithObservation()

```ts
function mergeDescriptorWithObservation(
   prev: FieldDescriptor,
   observation: FieldObservation | "absent",
   newTotal: number,
   path: FieldPath): MergeFieldResult;
```

Merge a single field observation into an existing descriptor.
`observation === 'absent'` means the field was missing from the doc.
`newTotal` is the doc count after this observation.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `prev` | [`FieldDescriptor`](#fielddescriptor) |
| `observation` | [`FieldObservation`](#fieldobservation) \| `"absent"` |
| `newTotal` | `number` |
| `path` | [`FieldPath`](#fieldpath) |

#### Returns

`MergeFieldResult`

***

<a id="mergedoc"></a>

### mergeDoc()

```ts
function mergeDoc(prev: FieldSchema, doc: Record<string, FieldObservation>): {
  changes: SchemaChange[];
  next: FieldSchema;
};
```

Merge a single document's typed field observations into a collection-level
schema. Returns the next schema and the changes emitted.

The wire layer (`wire.ts`) is responsible for converting Firestore wire
values into the `Record<string, FieldObservation>` shape expected here.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `prev` | [`FieldSchema`](#fieldschema) |
| `doc` | `Record`\<`string`, [`FieldObservation`](#fieldobservation)\> |

#### Returns

```ts
{
  changes: SchemaChange[];
  next: FieldSchema;
}
```

##### changes

```ts
changes: SchemaChange[];
```

##### next

```ts
next: FieldSchema;
```

***

<a id="runconvergence"></a>

### runConvergence()

```ts
function runConvergence(docs: Iterable<Record<string, FieldObservation>>, stopOnStable: number): ConvergenceResult;
```

Stream-driven convergence runner. Used by the production crawler's
sampling loop and by Phase 2.x tests that replay corpus snapshots.

`stopOnStable` is the optimistic early-exit signal (Phase 2.1 lock — must
be paired with a `maxSamples` hard cap in the crawler, not here).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `docs` | `Iterable`\<`Record`\<`string`, [`FieldObservation`](#fieldobservation)\>\> |
| `stopOnStable` | `number` |

#### Returns

[`ConvergenceResult`](#convergenceresult)

***

<a id="runwithlimit"></a>

### runWithLimit()

```ts
function runWithLimit<T, R>(
   items: readonly T[],
   limit: number,
producer: (item: T, index: number) => Promise<R>): Promise<R[]>;
```

Run `items` through `producer` concurrently, capping in-flight calls
at `limit`. Returns results in input order (same shape as
`Promise.all(items.map(producer))` — but bounded).

`producer` may throw; the rejection propagates after in-flight work
settles. Other items continue running so the rejection isn't masked
by a Promise.all-style fast-fail leaving zombie pending work.

Implementation detail: uses an internal `Semaphore(limit)`; callers
who need to share a permit pool across multiple `runWithLimit` calls
(e.g. crawler global RPC cap) should use the `Semaphore` class
directly via `acquire`/`release`.

#### Type Parameters

| Type Parameter |
| :------ |
| `T` |
| `R` |

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `items` | readonly `T`[] |
| `limit` | `number` |
| `producer` | (`item`: `T`, `index`: `number`) => `Promise`\<`R`\> |

#### Returns

`Promise`\<`R`[]\>

***

<a id="snapshottoobservations"></a>

### snapshotToObservations()

```ts
function snapshotToObservations(snap: WireDocumentSnapshot): {
  observations: Record<string, FieldObservation>;
  reservedNames: Record<string, ReservedFieldReason>;
};
```

Convert a Firestore document snapshot into a FieldObservation map.
Detects reserved field names per 0.B — they appear in the output but
the descriptor returned by the merge layer carries `reservedReason`
so codegen can skip them.

Throws `WireProtoUnavailableError` if `_fieldsProto` is absent (0.A
fail-loud contract). Empty docs (proto present but zero keys) return
an empty record without throwing.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `snap` | [`WireDocumentSnapshot`](#wiredocumentsnapshot) |

#### Returns

```ts
{
  observations: Record<string, FieldObservation>;
  reservedNames: Record<string, ReservedFieldReason>;
}
```

##### observations

```ts
observations: Record<string, FieldObservation>;
```

##### reservedNames

```ts
reservedNames: Record<string, ReservedFieldReason>;
```

***

<a id="totemplatepath"></a>

### toTemplatePath()

```ts
function toTemplatePath(concretePath: string): string;
```

Map a concrete collection path to its template-path form per Phase 3.1
lock. Doc-id segments become `{singular(parentColl)Id}` so the result
matches Firestore rules' `path.raw` segments under typical naming
conventions (TTT corpus verified: `ttt_lobbies` → `{lobbyId}`).

Inputs alternate `coll/doc/coll/doc/.../coll`. Length is always odd (a
collection path ends on a collection segment).

Heuristic — agents needing strict alignment with rules should normalize
both sides before joining. See Risk 6 in the implementation plan.

Examples:
  `users` → `users`
  `users/uid_1/posts` → `users/{userId}/posts`
  `ttt_lobbies/abc/games/g1/moves` → `ttt_lobbies/{lobbyId}/games/{gameId}/moves`

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `concretePath` | `string` |

#### Returns

`string`

***

<a id="wirevaluetofieldtype"></a>

### wireValueToFieldType()

```ts
function wireValueToFieldType(v: any): FieldType;
```

Pure type extraction. Does not extract examples or enum samples — use
`wireValueToObservation` for the full observation.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `v` | `any` |

#### Returns

[`FieldType`](#fieldtype)

***

<a id="wirevaluetoobservation"></a>

### wireValueToObservation()

```ts
function wireValueToObservation(v: any): FieldObservation;
```

Full observation including JSON-safe example projection and enum sample
extraction. The merge layer consumes this shape.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `v` | `any` |

#### Returns

[`FieldObservation`](#fieldobservation)
