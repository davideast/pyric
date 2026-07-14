<!-- Generated from the package export declaration via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

# @pyric/cli/discover

## Classes

### LocalEnvironmentCrawlerAdapter

Wrap a LocalEnvironment as a Firestore root that satisfies
the discover/crawler + find-collection-group contracts.

#### Implements

- [`CrawlerFirestore`](#crawlerfirestore)
- [`CollectionGroupCapableFirestore`](#collectiongroupcapablefirestore)

#### Constructors

##### Constructor

> **new LocalEnvironmentCrawlerAdapter**(`env`): [`LocalEnvironmentCrawlerAdapter`](#localenvironmentcrawleradapter)

###### Parameters

###### env

`LocalEnvironment`

###### Returns

[`LocalEnvironmentCrawlerAdapter`](#localenvironmentcrawleradapter)

#### Methods

##### collection()

> **collection**(`path`): [`CrawlerCollectionRef`](#crawlercollectionref)

###### Parameters

###### path

`string`

###### Returns

[`CrawlerCollectionRef`](#crawlercollectionref)

###### Implementation of

[`CrawlerFirestore`](#crawlerfirestore).[`collection`](#collection-2)

##### collectionGroup()

> **collectionGroup**(`collectionId`): [`CollectionGroupQuery`](#collectiongroupquery)

###### Parameters

###### collectionId

`string`

###### Returns

[`CollectionGroupQuery`](#collectiongroupquery)

###### Implementation of

[`CollectionGroupCapableFirestore`](#collectiongroupcapablefirestore).[`collectionGroup`](#collectiongroup-2)

##### doc()

> **doc**(`path`): [`CrawlerDocumentRef`](#crawlerdocumentref)

###### Parameters

###### path

`string`

###### Returns

[`CrawlerDocumentRef`](#crawlerdocumentref)

###### Implementation of

[`CrawlerFirestore`](#crawlerfirestore).[`doc`](#doc-2)

##### listCollections()

> **listCollections**(): `Promise`\<[`CrawlerCollectionRef`](#crawlercollectionref)[]\>

###### Returns

`Promise`\<[`CrawlerCollectionRef`](#crawlercollectionref)[]\>

###### Implementation of

[`CrawlerFirestore`](#crawlerfirestore).[`listCollections`](#listcollections-4)

***

### Semaphore

FIFO counting semaphore. `acquire()` resolves immediately while
fewer than `max` permits are checked out, otherwise it queues until
a `release()` frees a slot. Waiters are served in arrival order.

`release()` without a prior `acquire()` is a no-op (does not go
negative). This is intentional — it lets defensive `try/finally`
release in error paths without bookkeeping.

#### Constructors

##### Constructor

> **new Semaphore**(`max`): [`Semaphore`](#semaphore)

###### Parameters

###### max

`number`

###### Returns

[`Semaphore`](#semaphore)

#### Accessors

##### inFlight

###### Get Signature

> **get** **inFlight**(): `number`

Number of permits currently checked out. For tests and instrumentation
only; do not branch on this in production logic.

###### Returns

`number`

##### pending

###### Get Signature

> **get** **pending**(): `number`

Number of waiters queued. For tests and instrumentation only.

###### Returns

`number`

#### Methods

##### acquire()

> **acquire**(): `Promise`\<`void`\>

###### Returns

`Promise`\<`void`\>

##### release()

> **release**(): `void`

###### Returns

`void`

***

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

##### TState

`TState`

#### Constructors

##### Constructor

> **new SessionStore**\<`TState`\>(`opts?`): [`SessionStore`](#sessionstore)\<`TState`\>

###### Parameters

###### opts?

[`SessionStoreOptions`](#sessionstoreoptions)

###### Returns

[`SessionStore`](#sessionstore)\<`TState`\>

#### Accessors

##### size

###### Get Signature

> **get** **size**(): `number`

Live session count.

###### Returns

`number`

#### Methods

##### create()

> **create**(`state`, `bytes`): [`SessionResult`](#sessionresult)\<[`SessionRecord`](#sessionrecord)\<`TState`\>\>

Create a new session. Always succeeds unless `bytes` exceeds the
per-session byte cap. On cap-hit, evicts the LRU session — the
displaced token will report `SESSION_EVICTED` on its next access.

###### Parameters

###### state

`TState`

###### bytes

`number`

###### Returns

[`SessionResult`](#sessionresult)\<[`SessionRecord`](#sessionrecord)\<`TState`\>\>

##### delete()

> **delete**(`token`): `boolean`

Best-effort delete; returns true if a session was removed.

###### Parameters

###### token

`string`

###### Returns

`boolean`

##### get()

> **get**(`token`): [`SessionResult`](#sessionresult)\<[`SessionRecord`](#sessionrecord)\<`TState`\>\>

Look up a session by token. Touches `lastAccessedAt` on success so
subsequent reads keep the session warm. On expired/malformed/evicted
tokens returns the appropriate structured error.

###### Parameters

###### token

`string`

###### Returns

[`SessionResult`](#sessionresult)\<[`SessionRecord`](#sessionrecord)\<`TState`\>\>

##### sweepExpired()

> **sweepExpired**(`now?`): `number`

Drop sessions whose `lastAccessedAt + ttlMs` is in the past.
Returns the number of sessions evicted. Public for tests +
future scheduled-sweep usage; `create`/`get`/`update` all call it
lazily so callers don't normally need to.

###### Parameters

###### now?

`number`

###### Returns

`number`

##### update()

> **update**(`token`, `state`, `bytes`): [`SessionResult`](#sessionresult)\<[`SessionRecord`](#sessionrecord)\<`TState`\>\>

Replace the state of an existing session. Same lookup/error model
as `get`, plus per-session-bytes enforcement on the new payload.

###### Parameters

###### token

`string`

###### state

`TState`

###### bytes

`number`

###### Returns

[`SessionResult`](#sessionresult)\<[`SessionRecord`](#sessionrecord)\<`TState`\>\>

***

### WireProtoUnavailableError

Thrown when `DocumentSnapshot._fieldsProto` is unavailable or malformed.
Per prerequisite 0.A, the wire reader does NOT silently fall back to
`data()` — that would collapse integer/double at the value boundary
and corrupt every downstream codegen consumer.

#### Extends

- `Error`

#### Constructors

##### Constructor

> **new WireProtoUnavailableError**(`opts`): [`WireProtoUnavailableError`](#wireprotounavailableerror)

###### Parameters

###### opts

###### docPath

`string`

###### reason

`string`

###### Returns

[`WireProtoUnavailableError`](#wireprotounavailableerror)

###### Overrides

`Error.constructor`

#### Properties

##### cause?

> `optional` **cause**: `unknown`

The cause of the error.

###### Inherited from

`Error.cause`

##### message

> **message**: `string`

###### Inherited from

`Error.message`

##### name

> `readonly` **name**: `"WireProtoUnavailableError"` = `"WireProtoUnavailableError"`

###### Overrides

`Error.name`

##### stack?

> `optional` **stack**: `string`

###### Inherited from

`Error.stack`

##### stackTraceLimit

> `static` **stackTraceLimit**: `number`

The `Error.stackTraceLimit` property specifies the number of stack frames
collected by a stack trace (whether generated by `new Error().stack` or
`Error.captureStackTrace(obj)`).

The default value is `10` but may be set to any valid JavaScript number. Changes
will affect any stack trace captured _after_ the value has been changed.

If set to a non-number value, or set to a negative number, stack traces will
not capture any frames.

###### Inherited from

`Error.stackTraceLimit`

#### Methods

##### captureStackTrace()

###### Call Signature

> `static` **captureStackTrace**(`targetObject`, `constructorOpt?`): `void`

Creates a `.stack` property on `targetObject`, which when accessed returns
a string representing the location in the code at which
`Error.captureStackTrace()` was called.

```js
const myObject = {};
Error.captureStackTrace(myObject);
myObject.stack;  // Similar to `new Error().stack`
```

The first line of the trace will be prefixed with
`${myObject.name}: ${myObject.message}`.

The optional `constructorOpt` argument accepts a function. If given, all frames
above `constructorOpt`, including `constructorOpt`, will be omitted from the
generated stack trace.

The `constructorOpt` argument is useful for hiding implementation
details of error generation from the user. For instance:

```js
function a() {
  b();
}

function b() {
  c();
}

function c() {
  // Create an error without stack trace to avoid calculating the stack trace twice.
  const { stackTraceLimit } = Error;
  Error.stackTraceLimit = 0;
  const error = new Error();
  Error.stackTraceLimit = stackTraceLimit;

  // Capture the stack trace above function b
  Error.captureStackTrace(error, b); // Neither function c, nor b is included in the stack trace
  throw error;
}

a();
```

###### Parameters

###### targetObject

`object`

###### constructorOpt?

`Function`

###### Returns

`void`

###### Inherited from

`Error.captureStackTrace`

###### Call Signature

> `static` **captureStackTrace**(`targetObject`, `constructorOpt?`): `void`

Create .stack property on a target object

###### Parameters

###### targetObject

`object`

###### constructorOpt?

`Function`

###### Returns

`void`

###### Inherited from

`Error.captureStackTrace`

##### isError()

> `static` **isError**(`value`): `value is Error`

Check if a value is an instance of Error

###### Parameters

###### value

`unknown`

The value to check

###### Returns

`value is Error`

True if the value is an instance of Error, false otherwise

###### Inherited from

`Error.isError`

##### prepareStackTrace()

> `static` **prepareStackTrace**(`err`, `stackTraces`): `any`

###### Parameters

###### err

`Error`

###### stackTraces

`CallSite`[]

###### Returns

`any`

###### See

https://v8.dev/docs/stack-trace-api#customizing-stack-traces

###### Inherited from

`Error.prepareStackTrace`

## Interfaces

### CollectionGroupCapableFirestore

Optional source capability used by `findCollectionGroup`.

#### Methods

##### collectionGroup()

> **collectionGroup**(`collectionId`): [`CollectionGroupQuery`](#collectiongroupquery)

###### Parameters

###### collectionId

`string`

###### Returns

[`CollectionGroupQuery`](#collectiongroupquery)

***

### CollectionGroupQuery

Minimal collection-group query shape used by host discovery.

#### Methods

##### get()

> **get**(): `Promise`\<\{ `docs`: [`CollectionGroupSnapshot`](#collectiongroupsnapshot)[]; \}\>

###### Returns

`Promise`\<\{ `docs`: [`CollectionGroupSnapshot`](#collectiongroupsnapshot)[]; \}\>

##### limit()

> **limit**(`n`): [`CollectionGroupQuery`](#collectiongroupquery)

###### Parameters

###### n

`number`

###### Returns

[`CollectionGroupQuery`](#collectiongroupquery)

##### select()

> **select**(...`fields`): [`CollectionGroupQuery`](#collectiongroupquery)

###### Parameters

###### fields

...`string`[]

###### Returns

[`CollectionGroupQuery`](#collectiongroupquery)

***

### CollectionGroupSnapshot

Parent-path projection used by collection-group discovery.

#### Properties

##### ref

> **ref**: `object`

###### parent

> **parent**: `object`

###### parent.path

> **path**: `string`

***

### CollectionSchema

Schema for a single collection as surfaced in the tool output's
`finalizedSchemas`.

#### Properties

##### declaredAt

> **declaredAt**: `number`

##### examplePath?

> `optional` **examplePath**: `string`

##### samplingComplete

> **samplingComplete**: [`SamplingComplete`](#samplingcomplete-1)

##### schema

> **schema**: [`FieldSchema`](#fieldschema)

##### subcollectionTemplatePaths

> **subcollectionTemplatePaths**: `string`[]

##### templatePath

> **templatePath**: `string`

***

### ConvergenceResult

#### Properties

##### declaredAt

> **declaredAt**: `number`

Doc index where `stopOnStable` fired (0-based), or null if never.

##### finalSchema

> **finalSchema**: [`FieldSchema`](#fieldschema)

Final accumulated schema.

##### missedChangesAfterDeclared

> **missedChangesAfterDeclared**: [`SchemaChange`](#schemachange)[]

Changes emitted *after* convergence was declared — caller-visible
 for test-time assertion that `stopOnStable` would not have lost data.

##### totalChanges

> **totalChanges**: `number`

Total change count across the stream.

##### totalDocs

> **totalDocs**: `number`

Total docs consumed (≤ stream length).

***

### CrawlerCollectionRef

Minimal collection-reference shape needed for traversal.

#### Properties

##### id

> `readonly` **id**: `string`

##### path

> `readonly` **path**: `string`

#### Methods

##### listDocuments()

> **listDocuments**(): `Promise`\<[`CrawlerDocumentRef`](#crawlerdocumentref)[]\>

###### Returns

`Promise`\<[`CrawlerDocumentRef`](#crawlerdocumentref)[]\>

***

### CrawlerDocumentRef

Minimal document-reference shape needed for traversal and sampling.

#### Properties

##### id

> `readonly` **id**: `string`

##### path

> `readonly` **path**: `string`

#### Methods

##### get()

> **get**(): `Promise`\<[`WireDocumentSnapshot`](#wiredocumentsnapshot)\>

###### Returns

`Promise`\<[`WireDocumentSnapshot`](#wiredocumentsnapshot)\>

##### listCollections()

> **listCollections**(): `Promise`\<[`CrawlerCollectionRef`](#crawlercollectionref)[]\>

###### Returns

`Promise`\<[`CrawlerCollectionRef`](#crawlercollectionref)[]\>

***

### CrawlerFirestore

Firestore-shaped source consumed by the crawler.

`collection` and `doc` are needed only when resuming a continuation.

#### Methods

##### collection()?

> `optional` **collection**(`path`): [`CrawlerCollectionRef`](#crawlercollectionref)

###### Parameters

###### path

`string`

###### Returns

[`CrawlerCollectionRef`](#crawlercollectionref)

##### doc()?

> `optional` **doc**(`path`): [`CrawlerDocumentRef`](#crawlerdocumentref)

###### Parameters

###### path

`string`

###### Returns

[`CrawlerDocumentRef`](#crawlerdocumentref)

##### listCollections()

> **listCollections**(): `Promise`\<[`CrawlerCollectionRef`](#crawlercollectionref)[]\>

###### Returns

`Promise`\<[`CrawlerCollectionRef`](#crawlercollectionref)[]\>

***

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

##### continuation?

> `optional` **continuation**: `string`

Resume a previously paused crawl. Only valid when a `SessionStore` is
passed to `crawl()`. The token is the `continuation` value from a
prior paused result. Malformed/expired tokens surface as a
`SESSION_EXPIRED`/`SESSION_EVICTED`/`SESSION_MALFORMED_TOKEN`
error event with no other side effects (per 0.C).

##### dryRun?

> `optional` **dryRun**: `boolean`

Informational-only cost preview. When `true`, the crawler issues
exactly **one** RPC — `db.listCollections()` at the root — and
returns a heuristic projection of what a real crawl would cost.

No documents are read, no per-doc `listCollections` calls are
made, no sampling occurs. The result has empty `discovered` and
`finalizedSchemas`, `complete: true`, and `continuation: undefined`.
It is **not** a partial crawl that can be resumed — to "commit",
call `crawl()` again with `dryRun: false` (a fresh full crawl).

Rationale: an agent reading `dryRun: true` reasonably expects no
real crawl happened. Doing a structure walk under that flag would
let the agent make decisions on data it didn't realize it paid
for. See Item 5 revision in the implementation plan.

Default `false`.

##### dryRunSubtreeMultiplier?

> `optional` **dryRunSubtreeMultiplier**: `number`

Heuristic multiplier used in the dryRun cost projection: assumes
each root collection has roughly this many subtree-collections
(root + descendants) on average. Default 3 — conservative for
typical app schemas. Surfaced as an option so agents tuning for
known shapes can revise.

Only consulted when `dryRun: true`.

##### maxBatchBytes?

> `optional` **maxBatchBytes**: `number`

Pause threshold for batch payload size. After each layer (structure
phase) and each templatePath (sampling phase) the crawler measures
the JSON-serialized state size; if it exceeds this many bytes, the
crawl pauses and returns a continuation token. Default 1 MB per
Phase 0.4 sizing — well below `maxSessionBytes=32MB` so the agent
has headroom for response framing.

Only effective when a `SessionStore` is provided to `crawl()`. With
no store, single-call mode runs to completion regardless of size.

##### maxConcurrency?

> `optional` **maxConcurrency**: `number`

##### maxDepth?

> `optional` **maxDepth**: `number`

##### maxErrorsPerCollection?

> `optional` **maxErrorsPerCollection**: `number`

Per-templatePath cap on tolerated PERMISSION_DENIED / transient errors
during sampling. Default 3 per prerequisite 0.E. Past this threshold,
sampling for the templatePath stops and `samplingComplete` is set to
`sampling_open` so the agent can see the collection wasn't fully
sampled. Errors during structure discovery are emitted but do not
count toward this cap.

##### maxSamples?

> `optional` **maxSamples**: `number`

Hard cap on docs sampled per templatePath. Default 50 per Phase 2.1
lock. Item 3 will add adaptive `stopOnStable` early-exit on top of
this cap; for now sampling reads exactly `min(maxSamples, available)`
docs per templatePath.

##### rootFilter()?

> `optional` **rootFilter**: (`collectionId`) => `boolean`

###### Parameters

###### collectionId

`string`

###### Returns

`boolean`

##### stopOnStable?

> `optional` **stopOnStable**: `number`

Adaptive early-exit threshold. After this many consecutive
no-change merges in a templatePath's sampling stream, sampling stops
and `samplingComplete` is set to `converged_via_stable`. Default 8 per
Phase 2.1 lock. Set to a value > maxSamples to disable early-exit
(the hard cap then governs).

Reads are issued in chunks of `stopOnStable` so an early-exit avoids
fetching the remainder of `sampleRefs`. Worst-case wasted-read
count per templatePath is `stopOnStable - 1`.

***

### CrawlResult

#### Extended by

- [`FullCrawlResult`](#fullcrawlresult)

#### Properties

##### discovered

> **discovered**: `Map`\<`string`, [`DiscoveredCollection`](#discoveredcollection)\>

##### events

> **events**: [`DiscoverEvent`](#discoverevent)[]

##### listOps

> **listOps**: `number`

Total `listCollections` + `listDocuments` calls — feeds cost reporting.

***

### DiscoveredCollection

Per-template-path bookkeeping built up during a crawl. Collection refs
are kept here for Item 2.3 to drive document sampling.

Multiple concrete collection paths may collapse to the same template
path (e.g. `users/uid_1/posts` and `users/uid_2/posts` both map to
`users/{userId}/posts`); their refs are accumulated under one entry.

#### Properties

##### depth

> **depth**: `number`

##### docRefs

> **docRefs**: [`CrawlerDocumentRef`](#crawlerdocumentref)[]

Doc refs accumulated across `refs` during BFS expansion. Sampling
draws from this pool — re-listing would double the listDocuments
cost we already paid during structure discovery.

##### examplePath

> **examplePath**: `string`

First concrete collection path encountered for this template.

##### refs

> **refs**: [`CrawlerCollectionRef`](#crawlercollectionref)[]

All concrete collection refs that share this template path.

##### templatePath

> **templatePath**: `string`

***

### DiscoverPathsToolResult

JSON-serializable shape returned by `firestore_discover_paths`.

#### Properties

##### complete

> **complete**: `boolean`

True iff the crawl finished. Equivalent to `continuation === undefined`.

##### continuation?

> `optional` **continuation**: `string`

Opaque resume handle iff the crawl paused at a payload boundary.

##### dryRunCostEstimate?

> `optional` **dryRunCostEstimate**: [`DryRunCostEstimate`](#dryruncostestimate-1)

Present iff this was a `dryRun: true` preview.

##### events

> **events**: [`DiscoverEvent`](#discoverevent)[]

##### listOps

> **listOps**: `number`

`listCollections` + `listDocuments` calls — cumulative across batches.

##### readOps

> **readOps**: `number`

`.get()` calls during sampling — cumulative across batches.

##### schemas

> **schemas**: `Record`\<`string`, [`CollectionSchema`](#collectionschema)\>

Per-templatePath finalized schemas, keyed by templatePath.

***

### DryRunCostEstimate

Heuristic cost projection returned by `dryRun: true`. The numbers are
upper-bound estimates — agents should treat them as "no more than"
figures, not exact predictions. Formulas are documented in-line so
consumers can sanity-check.

#### Properties

##### estimatedListOps

> **estimatedListOps**: `number`

Projected total `listCollections` + `listDocuments` cost of a real
crawl: `1 + rootCount × subtreeMultiplier`. The `1` is the root
`listCollections`; each subtree contributes one `listDocuments`
call to enumerate docs. Per-doc `listCollections` cost is folded
into the multiplier (a subtree of 3 implies ~2 layers of doc
listings).

##### estimatedReadOps

> **estimatedReadOps**: `number`

Projected total `.get()` cost of sampling: `rootCount ×
subtreeMultiplier × maxSamples`. Upper bound — `stopOnStable`
early-exit and `cappedByMax` can reduce the actual draw.

##### maxSamples

> **maxSamples**: `number`

The `maxSamples` value the projection used.

##### rootCollectionCount

> **rootCollectionCount**: `number`

Number of root collections discovered by the single root listCollections call.

##### rootCollectionIds

> **rootCollectionIds**: `string`[]

The root collection IDs (after `rootFilter` is applied, if any).

##### subtreeMultiplier

> **subtreeMultiplier**: `number`

The `dryRunSubtreeMultiplier` value the projection used.

***

### EnumCandidate

Captured low-cardinality value set for enum-candidate fields.

#### Properties

##### qualifies

> **qualifies**: `boolean`

Whether the field still passes the threshold; flips to false if widened past it.

##### threshold

> **threshold**: `number`

Distinct count after which the candidate is dropped (default 10).

##### values

> **values**: (`string` \| `number`)[]

Distinct values observed so far (string/number); ordered by first-seen.

***

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

##### enumCandidate?

> `optional` **enumCandidate**: [`EnumCandidate`](#enumcandidate)

##### example?

> `optional` **example**: [`ExampleValue`](#examplevalue)

##### nullable

> **nullable**: `boolean`

##### presenceSeen

> **presenceSeen**: `number`

##### presenceTotal

> **presenceTotal**: `number`

##### reservedReason?

> `optional` **reservedReason**: [`ReservedFieldReason`](#reservedfieldreason)

##### types

> **types**: [`FieldType`](#fieldtype)[]

***

### FieldObservation

A single field observation passed into `mergeDoc`. The wire layer
(`wire.ts`) is responsible for producing this shape.

#### Properties

##### enumSample?

> `optional` **enumSample**: `EnumSample`

For enum-eligible scalars (string/int/double), the raw value. Used
 to update enumCandidate.

##### example?

> `optional` **example**: `ExampleValue`

A JSON-safe sample of the wire value. Used to populate `example` on
 the descriptor when no example exists yet. Optional — wire layer omits
 for kinds with no codegen-friendly representation.

##### isNull

> **isNull**: `boolean`

True iff the wire value was a null literal.

##### type

> **type**: [`FieldType`](#fieldtype)

The inferred FieldType for this observation. `null` is allowed and is
 surfaced via `isNull`; the `type` itself is `{kind:'scalar', type:'null'}`
 by convention but is NOT added to the descriptor's types[] union.

***

### FieldSchema

Per-collection accumulated schema. `samplesSeen` is the doc count fed
through `mergeDoc`, used as the presence denominator.

#### Properties

##### fields

> **fields**: `Record`\<`string`, [`FieldDescriptor`](#fielddescriptor)\>

##### samplesSeen

> **samplesSeen**: `number`

***

### FindCollectionGroupHost

#### Properties

##### sampleDocCount

> **sampleDocCount**: `number`

Number of docs in the N-doc draw that shared this parent path.
NOT the host's total doc count — that's a separate query.

##### templatePath

> **templatePath**: `string`

Template-form parent collection path, e.g. `users/{userId}/posts`.

***

### FindCollectionGroupOptions

#### Properties

##### limit?

> `optional` **limit**: `number`

Max docs to fetch from the collection group. Default 100 — covers
~22 distinct hosts with high confidence per the coupon-collector
heuristic. Raise this if the result reports `limitWasReached: true`
and you suspect more hosts exist.

***

### FindCollectionGroupResult

#### Properties

##### hosts

> **hosts**: [`FindCollectionGroupHost`](#findcollectiongrouphost)[]

Discovered hosts, deduped by templatePath. Order is insertion order
 (i.e. the order in which the first matching doc surfaced).

##### limitWasReached

> **limitWasReached**: `boolean`

True iff `reads === limit`, signaling the agent should consider
raising `limit` if they need exhaustive host coverage.

##### reads

> **reads**: `number`

Total docs read — the cost line item. Always `min(limit, totalDocsInGroup)`.

***

### FirestoreDiscoverToolDeps

#### Methods

##### resolveDb()

> **resolveDb**(): [`CrawlerFirestore`](#crawlerfirestore) & [`CollectionGroupCapableFirestore`](#collectiongroupcapablefirestore)

Resolver returning the CrawlerFirestore to scan. Called per
dispatch (F4). For `firestore_find_collection_group` the returned
Firestore must also satisfy [CollectionGroupCapableFirestore](#collectiongroupcapablefirestore).

###### Returns

[`CrawlerFirestore`](#crawlerfirestore) & [`CollectionGroupCapableFirestore`](#collectiongroupcapablefirestore)

***

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

##### complete

> **complete**: `boolean`

True iff the crawl completed (no continuation pending).

##### continuation?

> `optional` **continuation**: `string`

Opaque resume handle (only present when paused).

##### discovered

> **discovered**: `Map`\<`string`, [`DiscoveredCollection`](#discoveredcollection)\>

###### Inherited from

[`CrawlResult`](#crawlresult).[`discovered`](#discovered)

##### dryRunCostEstimate?

> `optional` **dryRunCostEstimate**: [`DryRunCostEstimate`](#dryruncostestimate-1)

Present iff the crawl was a `dryRun: true` preview. Heuristic
projection of what a full crawl would cost; see [CrawlOptions.dryRun](#dryrun).

##### events

> **events**: [`DiscoverEvent`](#discoverevent)[]

###### Inherited from

[`CrawlResult`](#crawlresult).[`events`](#events)

##### finalizedSchemas

> **finalizedSchemas**: `Map`\<`string`, [`CollectionSchema`](#collectionschema)\>

##### listOps

> **listOps**: `number`

Total `listCollections` + `listDocuments` calls — feeds cost reporting.

###### Inherited from

[`CrawlResult`](#crawlresult).[`listOps`](#listops)

##### readOps

> **readOps**: `number`

`.get()` calls issued during sampling — feeds cost reporting.

***

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

##### currentDepth

> **currentDepth**: `number`

Layer index after the last completed structure pass.

##### discovered

> **discovered**: `Record`\<`string`, [`PersistedDiscoveredCollection`](#persisteddiscoveredcollection)\>

Discovered map serialized — all paths only, refs reconstructed on resume.

##### finalizedSchemas

> **finalizedSchemas**: `Record`\<`string`, [`CollectionSchema`](#collectionschema)\>

Per-templatePath finalized schemas — immutable once set.

##### frontierPaths

> **frontierPaths**: `string`[]

Concrete collection paths to expand in the next structure layer.

##### listOps

> **listOps**: `number`

Cumulative cost counters across batches.

##### maxDepth

> **maxDepth**: `number`

Crawl options carried so resume preserves caps the agent set.

##### phase

> **phase**: `"structure"` \| `"sampling"`

##### readOps

> **readOps**: `number`

##### samplingQueue

> **samplingQueue**: `string`[]

TemplatePaths still to sample. Drained left-to-right.

***

### PersistedDiscoveredCollection

Persisted shape of a `DiscoveredCollection` (refs → paths).

#### Properties

##### depth

> **depth**: `number`

##### docRefPaths

> **docRefPaths**: `string`[]

##### examplePath

> **examplePath**: `string`

##### refPaths

> **refPaths**: `string`[]

##### templatePath

> **templatePath**: `string`

***

### SessionError

#### Properties

##### code

> **code**: [`SessionErrorCode`](#sessionerrorcode-1)

##### message

> **message**: `string`

##### recoveryHint

> **recoveryHint**: `string`

***

### SessionRecord

A live session record. `state` is opaque to the store — Item 4.2 will
instantiate `SessionStore` with the concrete crawler-state type.

#### Type Parameters

##### TState

`TState`

#### Properties

##### bytes

> **bytes**: `number`

Caller-reported payload size for byte-cap enforcement.

##### createdAt

> `readonly` **createdAt**: `number`

##### id

> `readonly` **id**: `string`

Raw ULID — internal id; not the token surfaced to agents.

##### lastAccessedAt

> **lastAccessedAt**: `number`

Last get/update; drives both LRU eviction and TTL.

##### state

> **state**: `TState`

##### token

> `readonly` **token**: `string`

Opaque continuation handle: `disc_<base64url-ulid>`.

***

### SessionStoreOptions

#### Properties

##### evictionLogSize?

> `optional` **evictionLogSize**: `number`

##### maxSessionBytes?

> `optional` **maxSessionBytes**: `number`

##### maxSessions?

> `optional` **maxSessions**: `number`

##### now()?

> `optional` **now**: () => `number`

Test seam — defaults to `Date.now`.

###### Returns

`number`

##### randomBytes()?

> `optional` **randomBytes**: (`n`) => `Uint8Array`

Test seam — defaults to `crypto.randomBytes`.

###### Parameters

###### n

`number`

###### Returns

`Uint8Array`

##### ttlMs?

> `optional` **ttlMs**: `number`

***

### WireDocumentSnapshot

Minimal document snapshot shape needed for wire-type inference.

#### Properties

##### \_fieldsProto?

> `optional` **\_fieldsProto**: `Record`\<`string`, `any`\>

##### ref?

> `optional` **ref**: `object`

###### path?

> `optional` **path**: `string`

## Type Aliases

### DiscoverEvent

> **DiscoverEvent** = \{ `depth`: `number`; `kind`: `"collection_discovered"`; `parentPath?`: `string`; `templatePath`: `string`; \} \| \{ `changes`: [`SchemaChange`](#schemachange)[]; `kind`: `"schema_updated"`; `templatePath`: `string`; \} \| \{ `declaredAt`: `number` \| `null`; `kind`: `"sampling_complete"`; `samplesSeen`: `number`; `samplingComplete`: [`SamplingComplete`](#samplingcomplete-1); `templatePath`: `string`; \} \| \{ `code`: `string`; `kind`: `"error"`; `message`: `string`; `templatePath`: `string`; \}

Event stream emitted by `firestore_discover_paths`. Frozen enum per
Phase 3.3 lock. Order within a batch is meaningful — agents may rely on
`collection_discovered` arriving before `schema_updated` for the same path.

***

### ExampleValue

> **ExampleValue** = `string` \| `number` \| `boolean` \| `null` \| [`ExampleValue`](#examplevalue)[] \| \{\[`k`: `string`\]: [`ExampleValue`](#examplevalue); \}

A representative observed value, JSON-safe.

***

### FieldPath

> **FieldPath** = `ReadonlyArray`\<`string` \| `"[]"`\>

Path within a doc to a field. `'[]'` segment denotes array element scope,
used for nested-array/map descriptors.

***

### FieldType

> **FieldType** = \{ `kind`: `"scalar"`; `type`: [`FirestoreScalarType`](#firestorescalartype); \} \| \{ `kind`: `"reference"`; `targetCollection`: `string`; \} \| \{ `elementTypes`: [`FieldType`](#fieldtype)[]; `kind`: `"array"`; \} \| \{ `fields`: `Record`\<`string`, [`FieldDescriptor`](#fielddescriptor)\>; `kind`: `"map"`; \} \| \{ `dimension`: `number` \| `"mixed"`; `kind`: `"vector"`; \}

One observed type for a field. Vector kept distinct from map per Phase 1.2
vector-sentinel lock; reference target is the **template-form full path**
per Phase 3.1 lock (`users/{userId}/posts`, not `posts`).

***

### FirestoreScalarType

> **FirestoreScalarType** = `"null"` \| `"boolean"` \| `"integer"` \| `"double"` \| `"timestamp"` \| `"string"` \| `"bytes"` \| `"geopoint"`

Firestore scalar wire types. Matches the discriminator emitted by
`_fieldsProto.<field>.valueType` (Phase 0.1 lock).

`null` is represented as a scalar so descriptors can carry a single union
shape; the merge layer separately tracks `nullable` per descriptor.

***

### ReservedFieldReason

> **ReservedFieldReason** = `"firestore_reserved_name"` \| `"dotted_field_name"` \| `"numeric_field_name"` \| `"double_underscore_wrap"`

Why a field name is flagged reserved per 0.B.

***

### SamplingComplete

> **SamplingComplete** = `"converged_via_stable"` \| `"converged_via_exhausted"` \| `"converged_via_max"` \| `"sampling_open"`

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

### SchemaChange

> **SchemaChange** = \{ `kind`: `"field_added"`; `path`: [`FieldPath`](#fieldpath); `type`: [`FieldType`](#fieldtype); \} \| \{ `addedType`: [`FieldType`](#fieldtype); `kind`: `"type_expanded"`; `path`: [`FieldPath`](#fieldpath); \} \| \{ `kind`: `"presence_changed"`; `path`: [`FieldPath`](#fieldpath); `presenceSeen`: `number`; `presenceTotal`: `number`; \} \| \{ `kind`: `"enum_added"`; `path`: [`FieldPath`](#fieldpath); `values`: (`string` \| `number`)[]; \} \| \{ `addedValue`: `string` \| `number`; `kind`: `"enum_widened"`; `path`: [`FieldPath`](#fieldpath); \} \| \{ `kind`: `"enum_dropped"`; `path`: [`FieldPath`](#fieldpath); `reason`: `"over_threshold"` \| `"type_widened"`; \} \| \{ `addedDimension`: `number`; `kind`: `"vector_dim_drift"`; `path`: [`FieldPath`](#fieldpath); \} \| \{ `kind`: `"became_nullable"`; `path`: [`FieldPath`](#fieldpath); \}

Frozen `SchemaChange` enum per Phase 5 implementation plan lock. Emitted
by the merge layer; carried in `schema_updated` events.

Renamed from v1 scope's `ChangeReason` to match the agent-facing terminology
in the validation plan's event-model lock.

***

### SessionErrorCode

> **SessionErrorCode** = `"SESSION_EXPIRED"` \| `"SESSION_EVICTED"` \| `"SESSION_PAYLOAD_TOO_LARGE"` \| `"SESSION_MALFORMED_TOKEN"`

***

### SessionResult

> **SessionResult**\<`T`\> = \{ `ok`: `true`; `value`: `T`; \} \| \{ `error`: [`SessionError`](#sessionerror); `ok`: `false`; \}

Discriminated-union result so callers don't have to try/catch.

#### Type Parameters

##### T

`T`

***

### WireValue

> **WireValue** = `any`

## Variables

### DEFAULT\_ENUM\_THRESHOLD

> `const` **DEFAULT\_ENUM\_THRESHOLD**: `10` = `10`

Default enum-candidate distinct-value cap (Phase 3.2 lock).

***

### DEFAULT\_MAX\_SESSION\_BYTES

> `const` **DEFAULT\_MAX\_SESSION\_BYTES**: `number`

***

### DEFAULT\_MAX\_SESSIONS

> `const` **DEFAULT\_MAX\_SESSIONS**: `8` = `8`

***

### DEFAULT\_TTL\_MS

> `const` **DEFAULT\_TTL\_MS**: `number`

## Functions

### classifyFieldName()

> **classifyFieldName**(`name`): [`ReservedFieldReason`](#reservedfieldreason)

Classify a field name. Returns undefined for normal names, or a
specific ReservedFieldReason for names that codegen must skip/sanitize.

Rules ordered by specificity (most specific first):
  - exact `__name__` etc. → firestore_reserved_name
  - contains '.'          → dotted_field_name (breaks dot-path access)
  - pure-numeric          → numeric_field_name (looks like array index)
  - __foo__               → double_underscore_wrap (sentinel collision)

#### Parameters

##### name

`string`

#### Returns

[`ReservedFieldReason`](#reservedfieldreason)

***

### crawl()

> **crawl**(`db`, `options?`, `sessions?`): `Promise`\<[`FullCrawlResult`](#fullcrawlresult)\>

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

##### db

[`CrawlerFirestore`](#crawlerfirestore)

##### options?

[`CrawlOptions`](#crawloptions)

##### sessions?

[`SessionStore`](#sessionstore)\<[`PersistedCrawlState`](#persistedcrawlstate)\>

#### Returns

`Promise`\<[`FullCrawlResult`](#fullcrawlresult)\>

***

### crawlStructure()

> **crawlStructure**(`db`, `options?`): `Promise`\<[`CrawlResult`](#crawlresult)\>

Walk the Firestore tree breadth-first. Each layer issues its
`listDocuments` + per-doc `listCollections` calls in parallel under a
shared concurrency cap.

Returns once every reachable collection (within `maxDepth`) is recorded.
The returned `discovered` map is keyed by templatePath; `events` is the
ordered event log emitted during the walk (currently only
`collection_discovered`).

#### Parameters

##### db

[`CrawlerFirestore`](#crawlerfirestore)

##### options?

[`CrawlOptions`](#crawloptions)

#### Returns

`Promise`\<[`CrawlResult`](#crawlresult)\>

***

### createFirestoreDiscoverTools()

> **createFirestoreDiscoverTools**(`deps`): `ToolHandler`\<`unknown`, `unknown`\>[]

#### Parameters

##### deps

[`FirestoreDiscoverToolDeps`](#firestorediscovertooldeps)

#### Returns

`ToolHandler`\<`unknown`, `unknown`\>[]

***

### decodeToken()

> **decodeToken**(`token`): `object`

Decode a `disc_<base64url>` token. Returns `null` on any malformation
— caller maps null to `SESSION_MALFORMED_TOKEN`.

#### Parameters

##### token

`string`

#### Returns

`object`

##### id

> **id**: `string`

***

### emptySchema()

> **emptySchema**(): [`FieldSchema`](#fieldschema)

#### Returns

[`FieldSchema`](#fieldschema)

***

### encodeToken()

> **encodeToken**(`ulidBytes`): `string`

Encode a 16-byte ULID into a `disc_<base64url>` token. Internal — used
by `SessionStore.create`.

#### Parameters

##### ulidBytes

`Uint8Array`

#### Returns

`string`

***

### fieldTypeKey()

> **fieldTypeKey**(`t`): `string`

Stable key for FieldType used in dedup. NaN/±Infinity all collapse to
`s:double` so no special handling needed (Phase 1.2 lock).

#### Parameters

##### t

[`FieldType`](#fieldtype)

#### Returns

`string`

***

### findCollectionGroup()

> **findCollectionGroup**(`db`, `collectionId`, `options?`): `Promise`\<[`FindCollectionGroupResult`](#findcollectiongroupresult)\>

Find every collection-group host of a given collection ID.

One read per returned doc — cost is bounded by `limit` (default 100).
Returns the hosts in template-path form (e.g. `users/{userId}/posts`)
with the per-host sample doc count.

Throws on Admin SDK errors (network / permission). The tool is
standalone — no session, no continuation, no events — so error
propagation is straightforward.

#### Parameters

##### db

[`CollectionGroupCapableFirestore`](#collectiongroupcapablefirestore)

##### collectionId

`string`

##### options?

[`FindCollectionGroupOptions`](#findcollectiongroupoptions)

#### Returns

`Promise`\<[`FindCollectionGroupResult`](#findcollectiongroupresult)\>

***

### inferTemplateVariable()

> **inferTemplateVariable**(`collectionId`): `string`

Convert a collection ID to the conventional template-variable name a
Firestore rules author would write for its docs. Strips a trailing
snake/dot-cased prefix word so `ttt_lobbies` → `lobbyId` (not
`ttt_lobbieId`).

#### Parameters

##### collectionId

`string`

#### Returns

`string`

***

### mergeDescriptorWithObservation()

> **mergeDescriptorWithObservation**(`prev`, `observation`, `newTotal`, `path`): `MergeFieldResult`

Merge a single field observation into an existing descriptor.
`observation === 'absent'` means the field was missing from the doc.
`newTotal` is the doc count after this observation.

#### Parameters

##### prev

[`FieldDescriptor`](#fielddescriptor)

##### observation

[`FieldObservation`](#fieldobservation) | `"absent"`

##### newTotal

`number`

##### path

[`FieldPath`](#fieldpath)

#### Returns

`MergeFieldResult`

***

### mergeDoc()

> **mergeDoc**(`prev`, `doc`): `object`

Merge a single document's typed field observations into a collection-level
schema. Returns the next schema and the changes emitted.

The wire layer (`wire.ts`) is responsible for converting Firestore wire
values into the `Record<string, FieldObservation>` shape expected here.

#### Parameters

##### prev

[`FieldSchema`](#fieldschema)

##### doc

`Record`\<`string`, [`FieldObservation`](#fieldobservation)\>

#### Returns

`object`

##### changes

> **changes**: [`SchemaChange`](#schemachange)[]

##### next

> **next**: [`FieldSchema`](#fieldschema)

***

### runConvergence()

> **runConvergence**(`docs`, `stopOnStable`): [`ConvergenceResult`](#convergenceresult)

Stream-driven convergence runner. Used by the production crawler's
sampling loop and by Phase 2.x tests that replay corpus snapshots.

`stopOnStable` is the optimistic early-exit signal (Phase 2.1 lock — must
be paired with a `maxSamples` hard cap in the crawler, not here).

#### Parameters

##### docs

`Iterable`\<`Record`\<`string`, [`FieldObservation`](#fieldobservation)\>\>

##### stopOnStable

`number`

#### Returns

[`ConvergenceResult`](#convergenceresult)

***

### runWithLimit()

> **runWithLimit**\<`T`, `R`\>(`items`, `limit`, `producer`): `Promise`\<`R`[]\>

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

##### T

`T`

##### R

`R`

#### Parameters

##### items

readonly `T`[]

##### limit

`number`

##### producer

(`item`, `index`) => `Promise`\<`R`\>

#### Returns

`Promise`\<`R`[]\>

***

### snapshotToObservations()

> **snapshotToObservations**(`snap`): `object`

Convert a Firestore document snapshot into a FieldObservation map.
Detects reserved field names per 0.B — they appear in the output but
the descriptor returned by the merge layer carries `reservedReason`
so codegen can skip them.

Throws `WireProtoUnavailableError` if `_fieldsProto` is absent (0.A
fail-loud contract). Empty docs (proto present but zero keys) return
an empty record without throwing.

#### Parameters

##### snap

[`WireDocumentSnapshot`](#wiredocumentsnapshot)

#### Returns

`object`

##### observations

> **observations**: `Record`\<`string`, [`FieldObservation`](#fieldobservation)\>

##### reservedNames

> **reservedNames**: `Record`\<`string`, [`ReservedFieldReason`](#reservedfieldreason)\>

***

### toTemplatePath()

> **toTemplatePath**(`concretePath`): `string`

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

##### concretePath

`string`

#### Returns

`string`

***

### wireValueToFieldType()

> **wireValueToFieldType**(`v`): [`FieldType`](#fieldtype)

Pure type extraction. Does not extract examples or enum samples — use
`wireValueToObservation` for the full observation.

#### Parameters

##### v

`any`

#### Returns

[`FieldType`](#fieldtype)

***

### wireValueToObservation()

> **wireValueToObservation**(`v`): [`FieldObservation`](#fieldobservation)

Full observation including JSON-safe example projection and enum sample
extraction. The merge layer consumes this shape.

#### Parameters

##### v

`any`

#### Returns

[`FieldObservation`](#fieldobservation)
