---
title: "API reference: @pyric/ui/firestore/hooks"
navLabel: "@pyric/ui/firestore/hooks"
group: "API reference"
section: "@pyric/ui"
order: 24040
description: "Published declarations for @pyric/ui/firestore/hooks."
kind: "api"
apiPackage: "@pyric/ui"
apiImportPath: "@pyric/ui/firestore/hooks"
apiSubpath: "firestore/hooks"
apiSymbolCount: 33
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Interfaces

<a id="querybuilderactions"></a>

### QueryBuilderActions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="addcondition"></a> `addCondition` | (`c?`: `Partial`\<`Omit`\<[`QueryCondition`](#querycondition), `"id"`\>\>) => `void` | - |
| <a id="buildquery"></a> `buildQuery` | (`base`: `any`) => `Query` | Compose the state into a Firestore `Query`. Returns the base collection when there are no conditions / orderBy / limit. Conditions with empty `field` are skipped — the builder UI lets users add a row before they've filled it in. |
| <a id="removecondition"></a> `removeCondition` | (`id`: `string`) => `void` | - |
| <a id="reset"></a> `reset` | () => `void` | - |
| <a id="setlimit"></a> `setLimit` | (`limit?`: `number`) => `void` | - |
| <a id="setorderby"></a> `setOrderBy` | (`orderBy?`: \{ `direction`: `OrderDirection`; `field`: `string`; \}) => `void` | - |
| <a id="updatecondition"></a> `updateCondition` | (`id`: `string`, `patch`: `Partial`\<`Omit`\<[`QueryCondition`](#querycondition), `"id"`\>\>) => `void` | - |

***

<a id="querybuilderstate"></a>

### QueryBuilderState

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="conditions"></a> `conditions` | [`QueryCondition`](#querycondition)[] |
| <a id="limit"></a> `limit?` | `number` |
| <a id="orderby"></a> `orderBy?` | \{ `direction`: `OrderDirection`; `field`: `string`; \} |
| `orderBy.direction` | `OrderDirection` |
| `orderBy.field` | `string` |

***

<a id="querycondition"></a>

### QueryCondition

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="field"></a> `field` | `string` |
| <a id="id"></a> `id` | `string` |
| <a id="op"></a> `op` | `WhereFilterOp` |
| <a id="value"></a> `value` | `unknown` |

***

<a id="recursivedeleteimpl"></a>

### RecursiveDeleteImpl

Implementation injected by the consumer. The library doesn't ship
one — sandbox-backed apps usually walk `pyric/sandbox`'s in-process
tree; production apps usually call a Cloud Function. Either way,
`start` returns an async iterator emitting progress.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="start"></a> `start` | (`target`: `any`) => `AsyncIterableIterator`\<[`RecursiveDeleteProgress`](#recursivedeleteprogress)\> |

***

<a id="recursivedeleteprogress"></a>

### RecursiveDeleteProgress

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="deletedcount"></a> `deletedCount` | `number` | Total nodes deleted so far. |
| <a id="done"></a> `done` | `boolean` | True for the final emission. |

***

<a id="subscriptionstate"></a>

### SubscriptionState

#### Type Parameters

| Type Parameter |
| :------ |
| `T` |

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="data"></a> `data` | `T` |
| <a id="error"></a> `error` | `Error` |
| <a id="isloading"></a> `isLoading` | `boolean` |

***

<a id="usecollectionlistoptions"></a>

### UseCollectionListOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="firestore"></a> `firestore` | `Firestore` | - |
| <a id="listcollections"></a> `listCollections` | (`firestore`: `Firestore`, `parent`: `any`) => `Promise`\<`CollectionReference`[]\> | Injected collection-listing function. The library doesn't ship a default — the modular Web SDK doesn't expose `listCollections` on the client. Sandbox-backed apps usually wire `pyric/sandbox`'s in-process listing; production apps either pass a known list (e.g. from a schema) or call a server proxy. |
| <a id="parent"></a> `parent?` | `any` | Parent document, or `null`/`undefined` for root collections. |

***

<a id="usecollectionlistresult"></a>

### UseCollectionListResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="collections"></a> `collections` | `CollectionReference`[] | - |
| <a id="createcollection"></a> `createCollection` | (`collectionId`: `string`, `firstDoc`: \{ `data`: `Record`\<`string`, `unknown`\>; `id`: `string`; \}) => `Promise`\<`DocumentReference`\> | Create a new collection by writing its first document. Firestore collections don't exist independently of their documents — `setDoc` on the first child path materializes the collection. |
| <a id="error-1"></a> `error` | `Error` | - |
| <a id="isloading-1"></a> `isLoading` | `boolean` | - |
| <a id="refresh"></a> `refresh` | () => `void` | Re-run the listing function. |

***

<a id="usedocumenteditoroptions"></a>

### UseDocumentEditorOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="initial"></a> `initial?` | `Record`\<`string`, `unknown`\> | Initial document data — the same shape a `DocumentSnapshot.data()` call returns. |

***

<a id="usedocumenteditorresult"></a>

### UseDocumentEditorResult

#### Extends

- `DocumentEditorState`

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="addarrayentry"></a> `addArrayEntry` | (`parentId`: `string`, `childType`: `FieldType`) => `void` | Append a child to an array. Nested arrays are silently rejected by the reducer (Firestore disallows them). |
| <a id="addmapentry"></a> `addMapEntry` | (`parentId`: `string`, `key`: `string`, `childType`: `FieldType`) => `void` | Append a child to a map. |
| <a id="dispatch"></a> `dispatch` | (`action`: `DocumentEditorAction`) => `void` | Raw dispatch — drops to the reducer-action surface. Prefer the named helpers below. |
| <a id="errorcount"></a> `errorCount` | `number` | Count of nodes with an active `error`. Derived after every action; the reducer keeps it in state to avoid a tree walk on every render. |
| <a id="initial-1"></a> `initial` | `EditorTree` | Frozen copy of the tree at construction. `reset` restores from here; `isDirty` is computed by comparing serializations. |
| <a id="isdirty"></a> `isDirty` | `boolean` | `true` once any modifying action has fired since the last `reset`. Cleared by `reset`. Does NOT clear when the user manually re-enters the original values — checking that would require a full serialization comparison on every dispatch. |
| <a id="isvalid"></a> `isValid` | `boolean` | Convenience: `errorCount === 0`. |
| <a id="remove"></a> `remove` | (`nodeId`: `string`) => `void` | Remove a node (and all its descendants). Removing the root is a no-op. |
| <a id="replacedata"></a> `replaceData` | (`data`: `Record`\<`string`, `unknown`\>) => `void` | Replace the editor with a newly delivered snapshot and adopt it as the clean baseline. Intended for live document viewers. |
| <a id="reset-1"></a> `reset` | () => `void` | Restore the tree to its initial state. Clears `isDirty`. |
| <a id="setkey"></a> `setKey` | (`nodeId`: `string`, `key`: `string`) => `void` | Set a map-child's key. |
| <a id="settype"></a> `setType` | (`nodeId`: `string`, `newType`: `FieldType`) => `void` | Switch a node's type. Map/array nodes drop their children. |
| <a id="setvalue"></a> `setValue` | (`nodeId`: `string`, `value`: `unknown`) => `void` | Update a leaf value. |
| <a id="todata"></a> `toData` | () => `Record`\<`string`, `unknown`\> | Serialize the tree back to a Firestore-shaped object suitable for `setDoc` / `updateDoc`. |
| <a id="touch"></a> `touch` | (`nodeId`: `string`) => `void` | Mark one node touched (dispatch on blur). Gates error display — a freshly-added row stays quiet until the user leaves it. |
| <a id="touchall"></a> `touchAll` | () => `void` | Mark every node touched (dispatch on a submit attempt) so any hidden errors surface at once. |
| <a id="tree"></a> `tree` | `EditorTree` | - |

***

<a id="usedocumentlistoptions"></a>

### UseDocumentListOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="collection"></a> `collection` | `CollectionReference` | - |
| <a id="mode"></a> `mode?` | `"paged"` \| `"live"` | `paged` preserves the historical get-based cursor behavior. `live` keeps the currently requested window under an `onSnapshot` subscription and grows that window when `loadMore` is requested. Default `paged`. |
| <a id="pagesize"></a> `pageSize?` | `number` | Page size for cursor-based pagination. Default 50. |
| <a id="query"></a> `query?` | `Query` | Optional filter / sort. If omitted, the raw collection is used. |

***

<a id="usedocumentlistresult"></a>

### UseDocumentListResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="createdocument"></a> `createDocument` | (`id`: `string`, `data`: `Record`\<`string`, `unknown`\>, `opts?`: \{ `onExisting?`: `"overwrite"` \| `"fail"`; \}) => `Promise`\<`DocumentReference`\> | Create a document. If `id` is null, Firestore generates one via `addDoc`. With `onExisting: 'fail'` (CREATE semantics, the admin `create()` analog) an id that already exists rejects with `code: 'already-exists'` instead of silently overwriting — checked against the BACKEND (a `getDoc` probe), not any loaded page, so it is honest beyond pagination. Default: 'overwrite' (plain `setDoc`, the historical behavior). |
| <a id="deletedocument"></a> `deleteDocument` | (`ref`: `DocumentReference`) => `Promise`\<`void`\> | - |
| <a id="documents"></a> `documents` | `QueryDocumentSnapshot`[] | - |
| <a id="error-2"></a> `error` | `Error` | - |
| <a id="hasmore"></a> `hasMore` | `boolean` | True if there might be another page. The hook tracks this via the last fetch's length === pageSize. |
| <a id="isloading-2"></a> `isLoading` | `boolean` | - |
| <a id="loadmore"></a> `loadMore` | () => `void` | Fetch the next page; live mode grows and re-establishes its window. |
| <a id="refresh-1"></a> `refresh` | () => `void` | Re-establish the active read/subscription. Useful after the consumer mutates data outside this hook. |
| <a id="subscriptiongeneration"></a> `subscriptionGeneration` | `number` | Identifies the active live subscription. Consumers that diff result snapshots can include this in their scope so a re-subscription (including load-more) establishes a silent baseline instead of looking like writes. |

***

<a id="usedocumentsubcollectionsoptions"></a>

### UseDocumentSubcollectionsOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="documentref"></a> `documentRef` | `any` | The document whose subcollections to list. When `null`/`undefined` the hook stays idle (empty, not loading) — used when the preview has no ref to drill from. |
| <a id="firestore-1"></a> `firestore` | `Firestore` | - |
| <a id="listsubcollections"></a> `listSubcollections` | [`ListSubcollections`](#listsubcollections-1) | - |

***

<a id="usedocumentsubcollectionsresult"></a>

### UseDocumentSubcollectionsResult

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="error-3"></a> `error` | `Error` |
| <a id="isloading-3"></a> `isLoading` | `boolean` |
| <a id="subcollections"></a> `subcollections` | `CollectionReference`[] |

***

<a id="usequerybuilderoptions"></a>

### UseQueryBuilderOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="initial-2"></a> `initial?` | `Partial`\<[`QueryBuilderState`](#querybuilderstate)\> | Pre-populate the builder. |

***

<a id="userecursivedeleteresult"></a>

### UseRecursiveDeleteResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="delete"></a> `delete` | (`target`: `any`) => `Promise`\<`void`\> | Run the delete. Resolves when the iterator signals `done`. |
| <a id="error-4"></a> `error` | `Error` | Error thrown by the iterator, if any. Cleared at the start of the next call. |
| <a id="isrunning"></a> `isRunning` | `boolean` | True while an iteration is in flight. |
| <a id="progress"></a> `progress` | `number` | Number of nodes deleted in the current/last run. |

***

<a id="usereferencepickeroptions"></a>

### UseReferencePickerOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="firestore-2"></a> `firestore` | `Firestore` | - |
| <a id="initialpath"></a> `initialPath?` | `string` | Initial value to pre-populate the text input + parse. |
| <a id="listcollections-1"></a> `listCollections` | (`firestore`: `Firestore`, `parent`: `any`) => `Promise`\<`CollectionReference`[]\> | Lister for subcollections under a parent (or root when `parent == null`). The library does not ship a default — see `useCollectionList` for the same rationale (the modular Web SDK can't enumerate collections client-side). |
| <a id="pagesize-1"></a> `pageSize?` | `number` | Default page size for the document list when browsing inside a collection. Default 20. |

***

<a id="usereferencepickerresult"></a>

### UseReferencePickerResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="browselocation"></a> `browseLocation` | [`BrowseLocation`](#browselocation-1) | Current browse position in the tree. |
| <a id="candrillback"></a> `canDrillBack` | `boolean` | Whether `drillBack` has anywhere to go. |
| <a id="clear"></a> `clear` | () => `void` | Clear the path input + reset browse to root. |
| <a id="collections-1"></a> `collections` | `CollectionReference`[] | Collections available at the current browse level. Populated when `browseLocation` is `root` or `document`. |
| <a id="documents-1"></a> `documents` | `QueryDocumentSnapshot`[] | First page of documents in the current collection — populated when `browseLocation.kind === 'collection'`. |
| <a id="drillback"></a> `drillBack` | () => `void` | Step back one level. No-op when at root. |
| <a id="drillintocollection"></a> `drillIntoCollection` | (`ref`: `CollectionReference`) => `void` | Drill into a collection — fetches its first page of documents. |
| <a id="drillintodocument"></a> `drillIntoDocument` | (`ref`: `DocumentReference`) => `void` | Drill into a document — fetches its subcollections. |
| <a id="error-5"></a> `error` | `string` | Parse error, or `null` when valid. |
| <a id="isloading-4"></a> `isLoading` | `boolean` | True while a fetch is in flight. |
| <a id="pathinput"></a> `pathInput` | `string` | Current text input value. |
| <a id="pick"></a> `pick` | (`ref`: `DocumentReference`) => `void` | Commit a chosen reference. Updates `pathInput` (and therefore the parsed `reference`). |
| <a id="reference"></a> `reference` | `any` | Validated `DocumentReference` parsed from `pathInput`, or `null` when the path is empty / invalid. |
| <a id="setpathinput"></a> `setPathInput` | (`path`: `string`) => `void` | Set the text-input value. Parses on every change. |

## Type Aliases

<a id="browselocation-1"></a>

### BrowseLocation

```ts
type BrowseLocation =
  | {
  kind: "root";
}
  | {
  kind: "document";
  ref: DocumentReference;
}
  | {
  kind: "collection";
  ref: CollectionReference;
};
```

***

<a id="listsubcollections-1"></a>

### ListSubcollections()

```ts
type ListSubcollections = (firestore: Firestore, parent: DocumentReference) => Promise<CollectionReference[]>;
```

Lister for a document's own subcollections. Same injected-lister
shape as `useCollectionList` / `ReferencePicker` use — the modular
Web SDK doesn't expose a native `listCollections` on the client, so
the caller wires it (sandbox in-process listing, a server proxy, or
a known schema list).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `firestore` | `Firestore` |
| `parent` | `DocumentReference` |

#### Returns

`Promise`\<`CollectionReference`[]\>

***

<a id="queryop"></a>

### QueryOp

```ts
type QueryOp = WhereFilterOp;
```

***

<a id="usequerybuilderresult"></a>

### UseQueryBuilderResult

```ts
type UseQueryBuilderResult = QueryBuilderState & QueryBuilderActions;
```

## Variables

<a id="multi_value_ops"></a>

### MULTI\_VALUE\_OPS

```ts
const MULTI_VALUE_OPS: ReadonlySet<QueryOp>;
```

Ops that accept an array of values. The value editor in the
 bundled <QueryBuilder> parses the input as JSON for these.

***

<a id="query_ops"></a>

### QUERY\_OPS

```ts
const QUERY_OPS: readonly QueryOp[];
```

## Functions

<a id="usecollectionlist"></a>

### useCollectionList()

```ts
function useCollectionList(__namedParameters: UseCollectionListOptions): UseCollectionListResult;
```

Operational read + create for collections under a parent (or root).
Listing is injected because the modular Web SDK doesn't expose a
native `listCollections` on the client — see options docs.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`UseCollectionListOptions`](#usecollectionlistoptions) |

#### Returns

[`UseCollectionListResult`](#usecollectionlistresult)

***

<a id="usedocumenteditor"></a>

### useDocumentEditor()

```ts
function useDocumentEditor(options?: UseDocumentEditorOptions): UseDocumentEditorResult;
```

Headless document editor. Owns the entire edit state for one
document via a pure reducer. Consumers either render the bundled
`<DocumentEditor>` compound component over this hook, or render
their own tree using the returned state.

The hook builds its tree from `initial` on first mount. Changing
`initial` later does NOT rebuild the tree; live viewers explicitly call
`replaceData()` when a newer snapshot should become the clean baseline.
This matches the firebase-tools-ui pattern of treating the editor as a
stateful workspace while still allowing snapshot-driven reconciliation.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `options?` | [`UseDocumentEditorOptions`](#usedocumenteditoroptions) |

#### Returns

[`UseDocumentEditorResult`](#usedocumenteditorresult)

***

<a id="usedocumentlist"></a>

### useDocumentList()

```ts
function useDocumentList(__namedParameters: UseDocumentListOptions): UseDocumentListResult;
```

Paginated document list with two acquisition strategies. The default
`paged` mode uses `startAfter` and accumulates one-shot reads. `live` keeps
the requested prefix under one `onSnapshot` listener; loading more grows
that prefix and establishes a new subscription baseline.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`UseDocumentListOptions`](#usedocumentlistoptions) |

#### Returns

[`UseDocumentListResult`](#usedocumentlistresult)

***

<a id="usedocumentsubcollections"></a>

### useDocumentSubcollections()

```ts
function useDocumentSubcollections(__namedParameters: UseDocumentSubcollectionsOptions): UseDocumentSubcollectionsResult;
```

Read a single document's subcollection list. A thin specialization of
the `useCollectionList` pattern, scoped to one parent document and
read-only (no create — that lives in `useCollectionList`).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`UseDocumentSubcollectionsOptions`](#usedocumentsubcollectionsoptions) |

#### Returns

[`UseDocumentSubcollectionsResult`](#usedocumentsubcollectionsresult)

***

<a id="usefirestorecollection"></a>

### useFirestoreCollection()

```ts
function useFirestoreCollection(query: any): SubscriptionState<QuerySnapshot>;
```

Subscribe to a Firestore query (a `Query` from `pyric/firestore`'s
modular surface, including any `CollectionReference`, which extends
`Query`). Returns `{ data, error, isLoading }`.

Null/undefined query short-circuits to idle. Cleanup is automatic
on unmount or query change. `Query` objects don't have a stable
structural identity, so the consumer must memoize at the call site
— pass the same instance across renders to avoid re-subscribing.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `query` | `any` |

#### Returns

[`SubscriptionState`](#subscriptionstate)\<`QuerySnapshot`\>

***

<a id="usefirestoredoc"></a>

### useFirestoreDoc()

```ts
function useFirestoreDoc(ref: any): SubscriptionState<DocumentSnapshot>;
```

Subscribe to a single Firestore document. Returns `{ data, error,
isLoading }`. Null/undefined ref short-circuits to an idle state
(`data: undefined, error: undefined, isLoading: false`) — useful
for conditional rendering before a ref is known.

Cleanup is automatic on unmount or ref change. Memoize the ref at
the call site; this hook's effect re-runs on identity change.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `ref` | `any` |

#### Returns

[`SubscriptionState`](#subscriptionstate)\<`DocumentSnapshot`\>

***

<a id="usequerybuilder"></a>

### useQueryBuilder()

```ts
function useQueryBuilder(options?: UseQueryBuilderOptions): UseQueryBuilderResult;
```

Headless query-builder state machine. Single-level — no nested
`and()`/`or()` groups in v1. Consumers compose the state into a
Firestore `Query` via `buildQuery(base)` and feed that into
`useDocumentList` / `useFirestoreCollection`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `options?` | [`UseQueryBuilderOptions`](#usequerybuilderoptions) |

#### Returns

[`UseQueryBuilderResult`](#usequerybuilderresult)

***

<a id="userecursivedelete"></a>

### useRecursiveDelete()

```ts
function useRecursiveDelete(impl: RecursiveDeleteImpl): UseRecursiveDeleteResult;
```

Drive a [RecursiveDeleteImpl](#recursivedeleteimpl) from a React component. Tracks
progress + running state so the consumer can render a progress
indicator. Errors are caught and surfaced via the returned state,
not thrown.

Stale-run protection: if the component remounts (or the user
cancels and starts a new run) before a previous iteration
finishes, the older run's progress updates are dropped via a
generation token.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `impl` | [`RecursiveDeleteImpl`](#recursivedeleteimpl) |

#### Returns

[`UseRecursiveDeleteResult`](#userecursivedeleteresult)

***

<a id="usereferencepicker"></a>

### useReferencePicker()

```ts
function useReferencePicker(__namedParameters: UseReferencePickerOptions): UseReferencePickerResult;
```

Picker state machine. Browses a Firestore tree level-by-level
(root → collection → document → collection → ...), maintains a
separately-validated text-input path, and commits a chosen
reference via `pick`.

Headless — consumers compose the resulting state into their own
UI, or use the bundled `<ReferencePicker>` component.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`UseReferencePickerOptions`](#usereferencepickeroptions) |

#### Returns

[`UseReferencePickerResult`](#usereferencepickerresult)
