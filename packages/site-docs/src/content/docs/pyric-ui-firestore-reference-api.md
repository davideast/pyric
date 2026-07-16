---
title: "API reference: @pyric/ui/firestore"
navLabel: "@pyric/ui/firestore"
group: "API reference"
section: "@pyric/ui"
order: 24041
description: "Published declarations for @pyric/ui/firestore."
kind: "api"
apiPackage: "@pyric/ui"
apiImportPath: "@pyric/ui/firestore"
apiSubpath: "firestore"
apiSymbolCount: 86
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Interfaces

<a id="collectionlistprops"></a>

### CollectionListProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="classname"></a> `className?` | `string` | - |
| <a id="collections"></a> `collections` | `CollectionReference`[] | - |
| <a id="emptystate"></a> `emptyState?` | `ReactNode` | Optional empty-state node. Rendered when `collections.length` is 0 and the list isn't loading. |
| <a id="error"></a> `error?` | `Error` | - |
| <a id="isloading"></a> `isLoading?` | `boolean` | - |
| <a id="onselect"></a> `onSelect?` | (`collection`: `CollectionReference`) => `void` | Fired when a list item is clicked. Consumer wires navigation. |

***

<a id="deletewithconfirmprops"></a>

### DeleteWithConfirmProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="body"></a> `body?` | `ReactNode` | Confirm-dialog body. |
| <a id="classname-1"></a> `className?` | `string` | Class forwarded to the default trigger button. |
| <a id="confirmlabel"></a> `confirmLabel?` | `string` | Label on the destructive button. |
| <a id="impl"></a> `impl` | [`RecursiveDeleteImpl`](#recursivedeleteimpl) | Implementation that walks the tree + deletes. Consumer-supplied. Sandbox-backed apps usually wire `pyric/sandbox` introspection; production apps usually call a Cloud Function. |
| <a id="ondeleted"></a> `onDeleted?` | () => `void` | Fired after the delete iterator finishes successfully. |
| <a id="rendertrigger"></a> `renderTrigger?` | (`props`: \{ `isRunning`: `boolean`; `onClick`: () => `void`; `progress`: `number`; \}) => `ReactNode` | Optional render override for the trigger button. |
| <a id="target"></a> `target` | `any` | The doc / collection to delete. |
| <a id="title"></a> `title?` | `string` | Confirm-dialog title. Defaults to a sensible derivation from the target's path. |

***

<a id="documenteditorrootprops"></a>

### DocumentEditorRootProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="children"></a> `children` | `ReactNode` | - |
| <a id="classname-2"></a> `className?` | `string` | - |
| <a id="fieldeditors"></a> `fieldEditors?` | [`FieldEditorRegistry`](#fieldeditorregistry) | Override or extend the built-in field editors. |
| <a id="initial"></a> `initial?` | `Record`\<`string`, `unknown`\> | Initial document data. Built into the editor's tree on first mount; later changes don't rebuild — call `editor.reset()` to re-initialize from a fresh `initial`. |
| <a id="onchange"></a> `onChange?` | (`state`: [`UseDocumentEditorResult`](#usedocumenteditorresult)) => `void` | Called on every state change with the latest editor state. The parent typically watches `state.isValid` + `state.isDirty` to enable/disable a Save button. |

***

<a id="documenteditorstate"></a>

### DocumentEditorState

Reducer state. `tree` is the live document under edit; `initial`
is the snapshot the editor was constructed from (used to
implement `reset` and `isDirty`).

#### Extended by

- [`UseDocumentEditorResult`](#usedocumenteditorresult)

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="errorcount"></a> `errorCount` | `number` | Count of nodes with an active `error`. Derived after every action; the reducer keeps it in state to avoid a tree walk on every render. |
| <a id="initial-1"></a> `initial` | [`EditorTree`](#editortree) | Frozen copy of the tree at construction. `reset` restores from here; `isDirty` is computed by comparing serializations. |
| <a id="tree"></a> `tree` | [`EditorTree`](#editortree) | - |

***

<a id="documentlistprops"></a>

### DocumentListProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="classname-3"></a> `className?` | `string` | - |
| <a id="documents"></a> `documents` | `QueryDocumentSnapshot`[] | - |
| <a id="emptystate-1"></a> `emptyState?` | `ReactNode` | - |
| <a id="error-1"></a> `error?` | `Error` | - |
| <a id="hasmore"></a> `hasMore?` | `boolean` | - |
| <a id="isloading-1"></a> `isLoading?` | `boolean` | - |
| <a id="onloadmore"></a> `onLoadMore?` | () => `void` | Fired when the user requests another page. Wire to the hook's `loadMore`. The component will not render a Load More button when this is undefined. |
| <a id="onselect-1"></a> `onSelect?` | (`ref`: `DocumentReference`) => `void` | - |
| <a id="renderlabel"></a> `renderLabel?` | (`doc`: `QueryDocumentSnapshot`) => `ReactNode` | Optional renderer for the row label. Default renders the doc id. Override to show a field value alongside, an icon, etc. |
| <a id="renderrowaction"></a> `renderRowAction?` | (`doc`: `QueryDocumentSnapshot`) => `ReactNode` | Optional per-row action(s), rendered as a SIBLING of the row's select button inside the entry (not nested in it — so the action carries its own click handling without an invalid button-in-button). Used for row-level affordances like delete. |
| <a id="rowheight"></a> `rowHeight?` | `number` \| (`index`: `number`) => `number` | Estimated row height when virtualizing. Default 36 — matches a single-line text button at 13px font + ~10px padding. Pass a function for variable sizing (TanStack measures the actual height via ResizeObserver after the first paint anyway). |
| <a id="updatescope"></a> `updateScope?` | `string` | Stable collection/query identity used to reset update highlighting when the rendered list changes scope. |
| <a id="virtualizedheight"></a> `virtualizedHeight?` | `string` \| `number` | Pixel height the virtualized scroll container fills. Only applies when `documents.length > virtualizeThreshold`. Default `'60vh'` — consumers usually constrain via their layout. |
| <a id="virtualizethreshold"></a> `virtualizeThreshold?` | `number` | Above this row count, the list switches to virtualization via `<VirtualList>`. Default 100. Set to `Infinity` to disable (e.g. when measuring layout shifts is more important than scroll perf). |

***

<a id="documentpreviewprops"></a>

### DocumentPreviewProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="classname-4"></a> `className?` | `string` | Forwarded to the root `<div>`. |
| <a id="documentref"></a> `documentRef?` | `any` | The document's own reference. Required to surface its subcollections — `DocumentSnapshot` (as typed by `pyric/firestore`) doesn't expose `.ref`, so the consumer threads the ref it already holds from fetching the doc. Without it (or without [listSubcollections](#listsubcollections)) the Subcollections section is omitted. |
| <a id="emptystate-2"></a> `emptyState?` | `ReactNode` | Content rendered when the snapshot is missing or `!exists()`. Defaults to `null` (renders nothing). |
| <a id="fieldeditors-1"></a> `fieldEditors?` | [`FieldEditorRegistry`](#fieldeditorregistry) | Override or extend the built-in field editors. Merged on top of [defaultFieldEditors](#defaultfieldeditors) — only the keys you provide override. |
| <a id="firestore"></a> `firestore?` | `Firestore` | Firestore handle passed to [listSubcollections](#listsubcollections). Required alongside `documentRef` + `listSubcollections` to surface the Subcollections section (the same explicit-handle shape `ReferencePicker` uses). |
| <a id="listsubcollections"></a> `listSubcollections?` | [`ListSubcollections`](#listsubcollections-2) | Injected lister for the document's subcollections. The modular Web SDK has no client-side `listCollections`; sandbox-backed apps wire `pyric/sandbox`'s in-process listing, production apps pass a known list or a server proxy. Same shape `ReferencePicker` / `useCollectionList` use. Omit to hide the Subcollections section. |
| <a id="onreferenceclick"></a> `onReferenceClick?` | (`ref`: `DocumentReference`) => `void` | Fired when a reference field is clicked. When supplied, the reference Display renders as an interactive `<button>` (with `data-pyric-clickable`); when omitted, it stays inert as a `<span>`. Consumers wire navigation here — the library does not depend on a router. |
| <a id="onsubcollectionclick"></a> `onSubcollectionClick?` | (`collection`: `CollectionReference`) => `void` | Fired when a subcollection's drill affordance is activated. Receives the subcollection's `CollectionReference` (its `.path` is the navigate target). Consumers wire navigation here. |
| <a id="snapshot"></a> `snapshot` | `any` | Snapshot from `useFirestoreDoc` or `getDoc`. When `null` / `undefined`, renders [emptyState](#emptystate-2). |

***

<a id="editortree"></a>

### EditorTree

Normalized tree of nodes. `nodes` is the lookup; `childIds` is the
ordered child list per parent. The root node is itself a `map`
node (its children are the document's top-level fields).

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="childids"></a> `childIds` | `Record`\<`string`, `string`[]\> |
| <a id="nodes"></a> `nodes` | `Record`\<`string`, [`FieldNode`](#fieldnode)\> |
| <a id="rootid"></a> `rootId` | `string` |

***

<a id="fielddisplayprops"></a>

### FieldDisplayProps

#### Type Parameters

| Type Parameter | Default type |
| :------ | :------ |
| `V` | `unknown` |

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="fieldeditors-2"></a> `fieldEditors?` | [`FieldEditorRegistry`](#fieldeditorregistry) | Recursive editors (Map, Array) need the registry to dispatch on their children. Leaf editors (String, Number, …) can ignore this prop. Required-but-optional because the consumer of the component (`<FieldRenderer>`, `<DocumentPreview>`) always threads it through. |
| <a id="path"></a> `path?` | `string` | Dotted/bracketed path from the document root, e.g. `users.alice` or `tags[0]`. Forwarded so consumer styles can target nested positions via `[data-field-path="users.alice"]`. |
| <a id="value"></a> `value` | `V` | Value to display. The component's `V` generic narrows this. |

***

<a id="fieldeditorcontract"></a>

### FieldEditorContract

Contract for one Firestore value type. `Display` (read-mode) is
required; `Edit` + `validate` + `defaultValue` are required for
leaf types that participate in M3's editor. Map/array contracts
supply only `Display` — their edit affordances come from the
`<DocumentEditor>` compound component.

#### Type Parameters

| Type Parameter | Default type |
| :------ | :------ |
| `V` | `unknown` |

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="display"></a> `Display` | `ComponentType`\<[`FieldDisplayProps`](#fielddisplayprops)\<`V`\>\> |
| <a id="edit"></a> `Edit?` | `ComponentType`\<[`FieldEditProps`](#fieldeditprops)\<`V`\>\> |
| <a id="type"></a> `type` | [`FieldType`](#fieldtype) |

***

<a id="fieldeditprops"></a>

### FieldEditProps

Props passed to a per-type `Edit` component. The leaf editors
(string, number, …) consume this directly. Map/array editing is
handled by the `<DocumentEditor>` compound component itself, not
by individual editors — Firestore's container shapes are special
enough that pushing them through the registry costs more than
it's worth.

#### Type Parameters

| Type Parameter | Default type |
| :------ | :------ |
| `V` | `unknown` |

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="error-2"></a> `error?` | `string` | Validation error attached by the reducer. Editors render it inline alongside the input. |
| <a id="onchange-1"></a> `onChange` | (`next`: `V`) => `void` | Commit a new value. The hook wires this to the reducer's `setValue` action. |
| <a id="path-1"></a> `path?` | `string` | Dotted/bracketed path from the document root. |
| <a id="value-1"></a> `value` | `V` | Current value. |

***

<a id="fieldnode"></a>

### FieldNode

One node in the normalized editor tree. Every Firestore field —
leaf or container — is a node with a uuid, a parent pointer, a
type, and a value. Containers (map, array) carry no value of
their own; their children represent the value.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="error-3"></a> `error?` | `string` | Validation error message attached to the node by the reducer after every action. `undefined` when valid. Computed on EVERY action regardless of [touched](#touched) — `errorCount` / `isValid` must reflect the true state so Save stays disabled. `touched` governs only whether a consumer chooses to DISPLAY the error. |
| <a id="id"></a> `id` | `string` | Stable uuid. Used as React `key` and as the action target. |
| <a id="key"></a> `key` | `string` | Map children carry their key here. Array children carry `null` (position comes from the parent's `childIds` order). The root also carries `null` (it has no parent). |
| <a id="parentid"></a> `parentId` | `string` | Parent uuid; `null` for the root. |
| <a id="touched"></a> `touched?` | `boolean` | Set once the field has been blurred (or a submit attempt swept the whole tree via `touchAll`). Consumers gate error display on `touched && error` so a freshly-added empty row doesn't show "Field name is required" before the user has interacted with it. |
| <a id="type-1"></a> `type` | [`FieldType`](#fieldtype) | Discriminated type. Drives which editor renders. |
| <a id="value-2"></a> `value` | `unknown` | Leaf value. `undefined` for `map` / `array` — those carry their value as children. `null` field type has `value === null`. |

***

<a id="fieldrendererprops"></a>

### FieldRendererProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="fieldeditors-3"></a> `fieldEditors` | [`FieldEditorRegistry`](#fieldeditorregistry) | Registry to dispatch through. Pass the merged registry — this component does not fall back to defaults on its own (to avoid a circular import with the editors). `<DocumentPreview>` is the entry point that merges user overrides into defaults. |
| <a id="path-2"></a> `path?` | `string` | - |
| <a id="value-3"></a> `value` | `unknown` | - |

***

<a id="parsedimportdoc"></a>

### ParsedImportDoc

One document to create. `id === null` means "let Firestore auto-id it"
 (only produced by the array shape when no `generateId` option is given —
 a map key is always a chosen id).

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="data"></a> `data` | `Record`\<`string`, `unknown`\> |
| <a id="id-1"></a> `id` | `string` |

***

<a id="parseimportoptions"></a>

### ParseImportOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="generateid"></a> `generateId?` | () => `string` | When provided, array-shape entries get their auto-id GENERATED AT PARSE TIME (instead of `id: null` / addDoc-at-write-time). Fixing ids at parse makes a retry after a partial failure idempotent: the same parse's ids are reused, so re-running the import cannot duplicate already-written docs. Use [firestoreAutoId](#firestoreautoid) for prod-parity ids. |

***

<a id="parseimportresult"></a>

### ParseImportResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="docs"></a> `docs` | [`ParsedImportDoc`](#parsedimportdoc)[] | - |
| <a id="errors"></a> `errors` | `string`[] | Human-readable problems found while parsing. A non-empty `errors` does NOT necessarily mean `docs` is empty — the parser is per-item tolerant so one bad entry doesn't block the rest; the caller decides whether to block on any error or proceed with the valid subset. |

***

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

<a id="querybuilderprops"></a>

### QueryBuilderProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="classname-5"></a> `className?` | `string` | - |
| <a id="initial-2"></a> `initial?` | `Partial`\<[`QueryBuilderState`](#querybuilderstate)\> | Drives the hook used internally. Both the state and the composed Query are exposed via `onChange`. |
| <a id="onchange-2"></a> `onChange?` | (`builder`: [`UseQueryBuilderResult`](#usequerybuilderresult)) => `void` | Fired on every state change with the latest builder API. The parent typically calls `builder.buildQuery(collection)` and feeds the result into `useDocumentList` / `useFirestoreCollection`. |

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
| <a id="id-2"></a> `id` | `string` |
| <a id="op"></a> `op` | `WhereFilterOp` |
| <a id="value-4"></a> `value` | `unknown` |

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

<a id="referencepickerprops"></a>

### ReferencePickerProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="classname-6"></a> `className?` | `string` | Forwarded to the root. |
| <a id="firestore-1"></a> `firestore` | `Firestore` | - |
| <a id="initialpath"></a> `initialPath?` | `string` | Initial path text. |
| <a id="listcollections"></a> `listCollections` | (`firestore`: `Firestore`, `parent`: `any`) => `Promise`\<`CollectionReference`[]\> | Lister for subcollections. Required — see `useReferencePicker` docs for the rationale. |
| <a id="onpick"></a> `onPick?` | (`ref`: `DocumentReference`) => `void` | Fired when the user commits a picked reference (browse pick OR a valid manually-typed path with the Commit button). |
| <a id="pathlabel"></a> `pathLabel?` | `string` | Label for the path text input. Default 'Document path'. |

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
| <a id="data-1"></a> `data` | `T` |
| <a id="error-4"></a> `error` | `Error` |
| <a id="isloading-2"></a> `isLoading` | `boolean` |

***

<a id="usecollectionlistoptions"></a>

### UseCollectionListOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="firestore-2"></a> `firestore` | `Firestore` | - |
| <a id="listcollections-1"></a> `listCollections` | (`firestore`: `Firestore`, `parent`: `any`) => `Promise`\<`CollectionReference`[]\> | Injected collection-listing function. The library doesn't ship a default — the modular Web SDK doesn't expose `listCollections` on the client. Sandbox-backed apps usually wire `pyric/sandbox`'s in-process listing; production apps either pass a known list (e.g. from a schema) or call a server proxy. |
| <a id="parent"></a> `parent?` | `any` | Parent document, or `null`/`undefined` for root collections. |

***

<a id="usecollectionlistresult"></a>

### UseCollectionListResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="collections-1"></a> `collections` | `CollectionReference`[] | - |
| <a id="createcollection"></a> `createCollection` | (`collectionId`: `string`, `firstDoc`: \{ `data`: `Record`\<`string`, `unknown`\>; `id`: `string`; \}) => `Promise`\<`DocumentReference`\> | Create a new collection by writing its first document. Firestore collections don't exist independently of their documents — `setDoc` on the first child path materializes the collection. |
| <a id="error-5"></a> `error` | `Error` | - |
| <a id="isloading-3"></a> `isLoading` | `boolean` | - |
| <a id="refresh"></a> `refresh` | () => `void` | Re-run the listing function. |

***

<a id="usedocumenteditoroptions"></a>

### UseDocumentEditorOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="initial-3"></a> `initial?` | `Record`\<`string`, `unknown`\> | Initial document data — the same shape a `DocumentSnapshot.data()` call returns. |

***

<a id="usedocumenteditorresult"></a>

### UseDocumentEditorResult

Reducer state. `tree` is the live document under edit; `initial`
is the snapshot the editor was constructed from (used to
implement `reset` and `isDirty`).

#### Extends

- [`DocumentEditorState`](#documenteditorstate)

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="addarrayentry"></a> `addArrayEntry` | (`parentId`: `string`, `childType`: [`FieldType`](#fieldtype)) => `void` | Append a child to an array. Nested arrays are silently rejected by the reducer (Firestore disallows them). |
| <a id="addmapentry"></a> `addMapEntry` | (`parentId`: `string`, `key`: `string`, `childType`: [`FieldType`](#fieldtype)) => `void` | Append a child to a map. |
| <a id="dispatch"></a> `dispatch` | (`action`: [`DocumentEditorAction`](#documenteditoraction)) => `void` | Raw dispatch — drops to the reducer-action surface. Prefer the named helpers below. |
| <a id="errorcount-1"></a> `errorCount` | `number` | Count of nodes with an active `error`. Derived after every action; the reducer keeps it in state to avoid a tree walk on every render. |
| <a id="initial-4"></a> `initial` | [`EditorTree`](#editortree) | Frozen copy of the tree at construction. `reset` restores from here; `isDirty` is computed by comparing serializations. |
| <a id="isdirty"></a> `isDirty` | `boolean` | `true` once any modifying action has fired since the last `reset`. Cleared by `reset`. Does NOT clear when the user manually re-enters the original values — checking that would require a full serialization comparison on every dispatch. |
| <a id="isvalid"></a> `isValid` | `boolean` | Convenience: `errorCount === 0`. |
| <a id="remove"></a> `remove` | (`nodeId`: `string`) => `void` | Remove a node (and all its descendants). Removing the root is a no-op. |
| <a id="replacedata"></a> `replaceData` | (`data`: `Record`\<`string`, `unknown`\>) => `void` | Replace the editor with a newly delivered snapshot and adopt it as the clean baseline. Intended for live document viewers. |
| <a id="reset-1"></a> `reset` | () => `void` | Restore the tree to its initial state. Clears `isDirty`. |
| <a id="setkey"></a> `setKey` | (`nodeId`: `string`, `key`: `string`) => `void` | Set a map-child's key. |
| <a id="settype"></a> `setType` | (`nodeId`: `string`, `newType`: [`FieldType`](#fieldtype)) => `void` | Switch a node's type. Map/array nodes drop their children. |
| <a id="setvalue"></a> `setValue` | (`nodeId`: `string`, `value`: `unknown`) => `void` | Update a leaf value. |
| <a id="todata"></a> `toData` | () => `Record`\<`string`, `unknown`\> | Serialize the tree back to a Firestore-shaped object suitable for `setDoc` / `updateDoc`. |
| <a id="touch"></a> `touch` | (`nodeId`: `string`) => `void` | Mark one node touched (dispatch on blur). Gates error display — a freshly-added row stays quiet until the user leaves it. |
| <a id="touchall"></a> `touchAll` | () => `void` | Mark every node touched (dispatch on a submit attempt) so any hidden errors surface at once. |
| <a id="tree-1"></a> `tree` | [`EditorTree`](#editortree) | - |

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
| <a id="documents-1"></a> `documents` | `QueryDocumentSnapshot`[] | - |
| <a id="error-6"></a> `error` | `Error` | - |
| <a id="hasmore-1"></a> `hasMore` | `boolean` | True if there might be another page. The hook tracks this via the last fetch's length === pageSize. |
| <a id="isloading-4"></a> `isLoading` | `boolean` | - |
| <a id="loadmore"></a> `loadMore` | () => `void` | Fetch the next page; live mode grows and re-establishes its window. |
| <a id="refresh-1"></a> `refresh` | () => `void` | Re-establish the active read/subscription. Useful after the consumer mutates data outside this hook. |
| <a id="subscriptiongeneration"></a> `subscriptionGeneration` | `number` | Identifies the active live subscription. Consumers that diff result snapshots can include this in their scope so a re-subscription (including load-more) establishes a silent baseline instead of looking like writes. |

***

<a id="usedocumentsubcollectionsoptions"></a>

### UseDocumentSubcollectionsOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="documentref-1"></a> `documentRef` | `any` | The document whose subcollections to list. When `null`/`undefined` the hook stays idle (empty, not loading) — used when the preview has no ref to drill from. |
| <a id="firestore-3"></a> `firestore` | `Firestore` | - |
| <a id="listsubcollections-1"></a> `listSubcollections` | [`ListSubcollections`](#listsubcollections-2) | - |

***

<a id="usedocumentsubcollectionsresult"></a>

### UseDocumentSubcollectionsResult

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="error-7"></a> `error` | `Error` |
| <a id="isloading-5"></a> `isLoading` | `boolean` |
| <a id="subcollections"></a> `subcollections` | `CollectionReference`[] |

***

<a id="usequerybuilderoptions"></a>

### UseQueryBuilderOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="initial-5"></a> `initial?` | `Partial`\<[`QueryBuilderState`](#querybuilderstate)\> | Pre-populate the builder. |

***

<a id="userecursivedeleteresult"></a>

### UseRecursiveDeleteResult

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="delete"></a> `delete` | (`target`: `any`) => `Promise`\<`void`\> | Run the delete. Resolves when the iterator signals `done`. |
| <a id="error-8"></a> `error` | `Error` | Error thrown by the iterator, if any. Cleared at the start of the next call. |
| <a id="isrunning"></a> `isRunning` | `boolean` | True while an iteration is in flight. |
| <a id="progress"></a> `progress` | `number` | Number of nodes deleted in the current/last run. |

***

<a id="usereferencepickeroptions"></a>

### UseReferencePickerOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="firestore-4"></a> `firestore` | `Firestore` | - |
| <a id="initialpath-1"></a> `initialPath?` | `string` | Initial value to pre-populate the text input + parse. |
| <a id="listcollections-2"></a> `listCollections` | (`firestore`: `Firestore`, `parent`: `any`) => `Promise`\<`CollectionReference`[]\> | Lister for subcollections under a parent (or root when `parent == null`). The library does not ship a default — see `useCollectionList` for the same rationale (the modular Web SDK can't enumerate collections client-side). |
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
| <a id="collections-2"></a> `collections` | `CollectionReference`[] | Collections available at the current browse level. Populated when `browseLocation` is `root` or `document`. |
| <a id="documents-2"></a> `documents` | `QueryDocumentSnapshot`[] | First page of documents in the current collection — populated when `browseLocation.kind === 'collection'`. |
| <a id="drillback"></a> `drillBack` | () => `void` | Step back one level. No-op when at root. |
| <a id="drillintocollection"></a> `drillIntoCollection` | (`ref`: `CollectionReference`) => `void` | Drill into a collection — fetches its first page of documents. |
| <a id="drillintodocument"></a> `drillIntoDocument` | (`ref`: `DocumentReference`) => `void` | Drill into a document — fetches its subcollections. |
| <a id="error-9"></a> `error` | `string` | Parse error, or `null` when valid. |
| <a id="isloading-6"></a> `isLoading` | `boolean` | True while a fetch is in flight. |
| <a id="pathinput"></a> `pathInput` | `string` | Current text input value. |
| <a id="pick"></a> `pick` | (`ref`: `DocumentReference`) => `void` | Commit a chosen reference. Updates `pathInput` (and therefore the parsed `reference`). |
| <a id="reference"></a> `reference` | `any` | Validated `DocumentReference` parsed from `pathInput`, or `null` when the path is empty / invalid. |
| <a id="setpathinput"></a> `setPathInput` | (`path`: `string`) => `void` | Set the text-input value. Parses on every change. |

***

<a id="vectorview"></a>

### VectorView

Normalized read-side view of a Firestore vector (embedding) value.
Editors and the renderer work against this rather than the raw shape
so they don't have to care which backend produced the value.

#### Properties

| Property | Modifier | Type | Description |
| :------ | :------ | :------ | :------ |
| <a id="dimension"></a> `dimension` | `readonly` | `number` | Number of components. Equivalent to `values.length`; surfaced separately because that's what the UI labels (`vector · <dims>`). |
| <a id="values"></a> `values` | `readonly` | `number`[] | The embedding components. Defensive copy — safe to read freely. |

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

<a id="documenteditoraction"></a>

### DocumentEditorAction

```ts
type DocumentEditorAction =
  | {
  nodeId: string;
  type: "setValue";
  value: unknown;
}
  | {
  newType: FieldType;
  nodeId: string;
  type: "setType";
}
  | {
  key: string;
  nodeId: string;
  type: "setKey";
}
  | {
  childType: FieldType;
  key: string;
  parentId: string;
  type: "addMapEntry";
}
  | {
  childType: FieldType;
  parentId: string;
  type: "addArrayEntry";
}
  | {
  nodeId: string;
  type: "remove";
}
  | {
  type: "reset";
}
  | {
  data: Record<string, unknown>;
  type: "replaceData";
}
  | {
  nodeId: string;
  type: "touch";
}
  | {
  type: "touchAll";
};
```

Discriminated union of every action the reducer accepts. Each
action carries a `type` discriminator plus the data the reducer
needs to apply it.

#### Type Declaration

```ts
{
  nodeId: string;
  type: "setValue";
  value: unknown;
}
```

##### nodeId

```ts
nodeId: string;
```

##### type

```ts
type: "setValue";
```

##### value

```ts
value: unknown;
```

```ts
{
  newType: FieldType;
  nodeId: string;
  type: "setType";
}
```

##### newType

```ts
newType: FieldType;
```

##### nodeId

```ts
nodeId: string;
```

##### type

```ts
type: "setType";
```

```ts
{
  key: string;
  nodeId: string;
  type: "setKey";
}
```

##### key

```ts
key: string;
```

##### nodeId

```ts
nodeId: string;
```

##### type

```ts
type: "setKey";
```

```ts
{
  childType: FieldType;
  key: string;
  parentId: string;
  type: "addMapEntry";
}
```

##### childType

```ts
childType: FieldType;
```

##### key

```ts
key: string;
```

##### parentId

```ts
parentId: string;
```

##### type

```ts
type: "addMapEntry";
```

```ts
{
  childType: FieldType;
  parentId: string;
  type: "addArrayEntry";
}
```

##### childType

```ts
childType: FieldType;
```

##### parentId

```ts
parentId: string;
```

##### type

```ts
type: "addArrayEntry";
```

```ts
{
  nodeId: string;
  type: "remove";
}
```

##### nodeId

```ts
nodeId: string;
```

##### type

```ts
type: "remove";
```

```ts
{
  type: "reset";
}
```

##### type

```ts
type: "reset";
```

```ts
{
  data: Record<string, unknown>;
  type: "replaceData";
}
```

##### data

```ts
data: Record<string, unknown>;
```

##### type

```ts
type: "replaceData";
```

```ts
{
  nodeId: string;
  type: "touch";
}
```

##### nodeId

```ts
nodeId: string;
```

##### type

```ts
type: "touch";
```

Mark one node touched (dispatched on blur). Doesn't change any
 value — only gates error display for consumers that check it.

```ts
{
  type: "touchAll";
}
```

##### type

```ts
type: "touchAll";
```

Mark every node touched (dispatched on a submit attempt), so
 errors that were hidden pre-interaction all surface at once.

***

<a id="fieldeditorregistry"></a>

### FieldEditorRegistry

```ts
type FieldEditorRegistry = Partial<Record<FieldType, FieldEditorContract<any>>>;
```

Map of field-type to editor contract. `Partial<…>` so consumers
can override one type without re-supplying the rest — the merge
happens at the `<DocumentPreview>` boundary.

The stored value type is `FieldEditorContract<any>` rather than
`FieldEditorContract<unknown>` because each per-type contract
narrows its generic (e.g., `FieldEditorContract<Timestamp>` for
timestamp) and TypeScript's `ComponentType` is invariant in
props. `any` at the registry layer means the type-safety lives
at the per-contract definition site, not in the dispatch map.
`FieldRenderer` narrows back from `unknown` -> the right contract
via `inferType` at dispatch time.

***

<a id="fieldtype"></a>

### FieldType

```ts
type FieldType =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "timestamp"
  | "geopoint"
  | "reference"
  | "bytes"
  | "map"
  | "array"
  | "vector";
```

The set of value types `@pyric/ui` knows how to display + edit.
Maps 1:1 to Firestore's serializable value shapes; consumers can
extend the registry but the built-in editors cover these.

***

<a id="firestoreapi"></a>

### FirestoreApi

```ts
type FirestoreApi = Pick<any,
  | "addDoc"
  | "collection"
  | "deleteDoc"
  | "doc"
  | "getDoc"
  | "getDocs"
  | "limit"
  | "onSnapshot"
  | "query"
  | "setDoc"
| "startAfter">;
```

The modular Firestore functions the data hooks call, as an INJECTABLE bundle.

WHY: the hooks default to the in-process `pyric/firestore` API, but Pyric
Studio's served mode drives the SAME ops over a SharedWorker via a PARALLEL
modular client (`@pyric/cli/serve/worker`: its own `collection`/`getDocs`/...
over a `MessagePort`, and a `ClientDb` that is not a `pyric/firestore`
`Firestore`). Statically importing the in-process fns hardwires the hooks to
the in-page sandbox; reading them from this context lets a consumer inject the
worker client's fns so the hooks operate on the live worker backend without
the hooks (or the components) knowing which backend they hit.

The bundle is typed to the in-process signatures. A worker bundle is adapted
(cast) to this shape at the Studio boundary: the worker handles + snapshots
are runtime-compatible at the surface the hooks use (`.id` / `.data()` /
`.docs` / `.ref`), which is the contract function-injection relies on.

Default = the real `pyric/firestore` fns, so every existing consumer (the
dev-seed review build, tests, any app embedding `@pyric/ui`) is unchanged: no
provider needed unless you are swapping the backend.

***

<a id="listsubcollections-2"></a>

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

<a id="defaultfieldeditors"></a>

### defaultFieldEditors

```ts
const defaultFieldEditors: FieldEditorRegistry;
```

Default registry. Covers every [FieldType](#fieldtype). Consumers extend
or override by passing their own (partial) registry into
`<DocumentPreview>` / `<FieldRenderer>` — the components merge
overrides into these defaults so a consumer can swap just one
editor without re-declaring the rest.

***

<a id="documenteditor"></a>

### DocumentEditor

```ts
const DocumentEditor: {
  Fields: typeof DocumentEditorFields;
  Root: typeof DocumentEditorRoot;
};
```

Compound root export. Consumers pattern-match via dot access:

  <DocumentEditor.Root initial={data} onChange={…}>
    <DocumentEditor.Fields />
  </DocumentEditor.Root>

#### Type Declaration

<a id="fields"></a>

##### Fields

```ts
Fields: typeof DocumentEditorFields;
```

<a id="root"></a>

##### Root

```ts
Root: typeof DocumentEditorRoot;
```

***

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

<a id="asvectorview"></a>

### asVectorView()

```ts
function asVectorView(value: unknown): VectorView;
```

Detect + normalize a Firestore vector value, or return `null` if the
value isn't a vector. Vectors reach `@pyric/ui` in several runtime
shapes depending on the backend the snapshot came from — there is no
single `VectorValue` class `pyric/firestore` re-exports, so we match
structurally (the same strategy isDocumentReferenceShape uses
for refs):

  1. **pyric `Vector` wrapper** — frozen `.value: number[]` array plus
     a `.dimension` getter (sandbox / rules-side reads).
  2. **firebase/firestore (web) `VectorValue`** — exposes `.toArray()`
     and nothing else publicly.
  3. **firebase-admin `VectorValue`** — internal `._values: number[]`
     (also a `.toArray()`).
  4. **wire sentinel** — `{ __type__: '__vector__', value: number[] }`,
     the plain-object encoded form a discover crawler / seed emits.

A bare `number[]` is intentionally NOT a vector — those stay `array`.
Only the typed/branded shapes above match.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `value` | `unknown` |

#### Returns

[`VectorView`](#vectorview)

***

<a id="collectionlist"></a>

### CollectionList()

```ts
function CollectionList(__namedParameters: CollectionListProps): Element;
```

Headless collection list. Takes a pre-fetched array of references
(from `useCollectionList`) plus a select callback. Renders one
row per collection with `data-pyric-collection-id` for styling
and testing. The library does not own the data fetch — the hook
does — so this component is a thin presentational layer.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`CollectionListProps`](#collectionlistprops) |

#### Returns

`Element`

***

<a id="deletewithconfirm"></a>

### DeleteWithConfirm()

```ts
function DeleteWithConfirm(__namedParameters: DeleteWithConfirmProps): Element;
```

Composition that wires `useConfirm` + `useRecursiveDelete`. Requires
a `<ConfirmProvider>` ancestor.

The default trigger renders a plain `<button>` carrying the
destructive intent (the consumer styles via `[data-pyric-destructive]`).
Consumers wanting different chrome pass `renderTrigger`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`DeleteWithConfirmProps`](#deletewithconfirmprops) |

#### Returns

`Element`

***

<a id="detectcollisions"></a>

### detectCollisions()

```ts
function detectCollisions(existingIds: readonly string[], docs: readonly ParsedImportDoc[]): string[];
```

Ids in `docs` (map-shape entries only — `id !== null`) that already exist
in `existingIds`. The UI shows the skip-or-overwrite policy choice ONLY
when this returns a non-empty list.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `existingIds` | readonly `string`[] |
| `docs` | readonly [`ParsedImportDoc`](#parsedimportdoc)[] |

#### Returns

`string`[]

***

<a id="documenteditorfields-1"></a>

### DocumentEditorFields()

```ts
function DocumentEditorFields(): Element;
```

Renders the top-level fields of the document. For finer control,
a consumer can call `useDocumentEditorContext()` and render the
tree themselves.

#### Returns

`Element`

***

<a id="documenteditorroot-1"></a>

### DocumentEditorRoot()

```ts
function DocumentEditorRoot(__namedParameters: DocumentEditorRootProps): Element;
```

Wires the `useDocumentEditor` hook + field-editor registry into a
React context so `<DocumentEditor.Fields>` and `<DocumentEditor.AddField>`
can render the tree without prop drilling.

Pattern: hook + compound component. Consumers wanting full control
over the layout call `useDocumentEditor` directly and render their
own tree; consumers wanting the default rendering use this.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`DocumentEditorRootProps`](#documenteditorrootprops) |

#### Returns

`Element`

***

<a id="documentlist"></a>

### DocumentList()

```ts
function DocumentList(__namedParameters: DocumentListProps): Element;
```

Headless document list. Below `virtualizeThreshold`, renders a
plain `<ul>`; above it, switches to TanStack-Virtual via
`<VirtualList>` so 10k-doc collections don't bloat the DOM.

The hook owns pagination state; this component just renders. The
Load More button only renders when `hasMore` is true AND
`onLoadMore` is provided. Consumers wanting infinite scroll
trigger `onLoadMore` from a sentinel `IntersectionObserver` in
their own code — the component doesn't bake that policy in.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`DocumentListProps`](#documentlistprops) |

#### Returns

`Element`

***

<a id="documentpreview"></a>

### DocumentPreview()

```ts
function DocumentPreview(__namedParameters: DocumentPreviewProps): Element;
```

Read-only renderer for a Firestore document. Iterates top-level
fields in lexicographic order; each field dispatches through the
field-editor registry on its inferred type.

Headless — no shipped CSS. Consumers style via `className` on the
root and `[data-pyric-field-type]` / `[data-pyric-field-path]`
attribute selectors on the per-field nodes.

Editing arrives in M3 (`<DocumentEditor>`). M2 only displays.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`DocumentPreviewProps`](#documentpreviewprops) |

#### Returns

`Element`

***

<a id="fieldrenderer"></a>

### FieldRenderer()

```ts
function FieldRenderer(__namedParameters: FieldRendererProps): Element;
```

Dispatches a single value to its registered display component.
Recursive editors (Map, Array) re-enter through this component
for their children, threading the same registry.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`FieldRendererProps`](#fieldrendererprops) |

#### Returns

`Element`

***

<a id="firestoreapiprovider"></a>

### FirestoreApiProvider()

```ts
function FirestoreApiProvider(__namedParameters: {
  children: ReactNode;
  value: FirestoreApi;
}): FunctionComponentElement<ProviderProps<FirestoreApi>>;
```

Provide a Firestore API bundle to the subtree. Pyric Studio wraps its data
surface with this, supplying the in-process bundle for dev-seed review and the
SharedWorker client bundle under `pyric dev --ui`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | \{ `children`: `ReactNode`; `value`: [`FirestoreApi`](#firestoreapi); \} |
| `__namedParameters.children` | `ReactNode` |
| `__namedParameters.value` | [`FirestoreApi`](#firestoreapi) |

#### Returns

`FunctionComponentElement`\<`ProviderProps`\<[`FirestoreApi`](#firestoreapi)\>\>

***

<a id="firestoreautoid"></a>

### firestoreAutoId()

```ts
function firestoreAutoId(): string;
```

A Firestore-style 20-char auto id (same alphabet/length the SDK uses).

#### Returns

`string`

***

<a id="firestorevaluesequal"></a>

### firestoreValuesEqual()

```ts
function firestoreValuesEqual(previous: unknown, next: unknown): boolean;
```

Firestore-aware structural equality for values delivered by either the
in-process SDK or the SharedWorker serializer.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `previous` | `unknown` |
| `next` | `unknown` |

#### Returns

`boolean`

***

<a id="infertype"></a>

### inferType()

```ts
function inferType(value: unknown): FieldType;
```

Runtime-classify a value into one of the [FieldType](#fieldtype)s.

The discrimination order matters:
  - `null` checked before `typeof === 'object'` (null is an object)
  - vector (a typed embedding wrapper) checked before `Array.isArray`
    and before generic objects — its wire-sentinel shape is a plain
    object, and a bare `number[]` must stay `array`, not `vector`
  - `Array.isArray` checked before generic objects
  - Firestore special types (Timestamp/GeoPoint/Bytes/DocumentRef)
    checked before falling through to `map`

`undefined` values aren't legal Firestore field values; we coerce
them to `'null'` rather than throw — the caller can decide whether
to display or filter.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `value` | `unknown` |

#### Returns

[`FieldType`](#fieldtype)

***

<a id="initstate"></a>

### initState()

```ts
function initState(initial: Record<string, unknown>): DocumentEditorState;
```

Initial state factory. Builds tree + initial snapshot + error count.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `initial` | `Record`\<`string`, `unknown`\> |

#### Returns

[`DocumentEditorState`](#documenteditorstate)

***

<a id="mergefieldeditors"></a>

### mergeFieldEditors()

```ts
function mergeFieldEditors(override: Partial<Record<FieldType, FieldEditorContract<any>>>): FieldEditorRegistry;
```

Merge a consumer-supplied registry over the defaults. `undefined`
input returns the defaults as-is. Used internally by
`<DocumentPreview>` so consumers don't have to spread manually.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `override` | `Partial`\<`Record`\<[`FieldType`](#fieldtype), [`FieldEditorContract`](#fieldeditorcontract)\<`any`\>\>\> |

#### Returns

[`FieldEditorRegistry`](#fieldeditorregistry)

***

<a id="parseimport"></a>

### parseImport()

```ts
function parseImport(input: string, options?: ParseImportOptions): ParseImportResult;
```

Parse raw JSON text into the documents it would create. Never throws —
a JSON syntax error or a wrong top-level shape becomes an entry in
`errors` with an empty `docs` array.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `input` | `string` |
| `options?` | [`ParseImportOptions`](#parseimportoptions) |

#### Returns

[`ParseImportResult`](#parseimportresult)

***

<a id="querybuilder"></a>

### QueryBuilder()

```ts
function QueryBuilder(__namedParameters: QueryBuilderProps): Element;
```

Default visible composition over `useQueryBuilder`. Renders the
condition list + orderBy + limit form. Headless — every node
carries `data-pyric-*` for styling.

Values are JSON-parsed on input. `42`, `"text"`, `true`, `null`,
and `[1, 2, 3]` (for `in`/`not-in`/`array-contains-any`) all
work; raw strings that aren't JSON-parsable fall through as-is.
For non-JSON Firestore values (Timestamp, GeoPoint, Reference,
Bytes), consumers either use the hook directly with their own
value editors or swap the rendered component out.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`QueryBuilderProps`](#querybuilderprops) |

#### Returns

`Element`

***

<a id="reducer"></a>

### reducer()

```ts
function reducer(state: DocumentEditorState, action: DocumentEditorAction): DocumentEditorState;
```

Pure reducer. Every action returns a fresh state — no in-place
mutation of `state.tree`. Validation re-runs after the structural
change so `errorCount` is always current. Container nodes (map /
array) ignore actions that don't apply to them rather than
throwing; the components only render valid affordances per type.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `state` | [`DocumentEditorState`](#documenteditorstate) |
| `action` | [`DocumentEditorAction`](#documenteditoraction) |

#### Returns

[`DocumentEditorState`](#documenteditorstate)

***

<a id="referencepicker"></a>

### ReferencePicker()

```ts
function ReferencePicker(__namedParameters: ReferencePickerProps): Element;
```

Visible reference picker — text input + browseable panel.

Two ways to commit a reference:

  1. Type a path, then click Commit (enabled only when the path
     parses to a valid `DocumentReference`).
  2. Drill into a collection in the panel and click a document
     row.

Either path fires `onPick(ref)`. Headless — emits structural
`data-pyric-*` for styling.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`ReferencePickerProps`](#referencepickerprops) |

#### Returns

`Element`

***

<a id="treefromdata"></a>

### treeFromData()

```ts
function treeFromData(data: Record<string, unknown>): EditorTree;
```

Build a normalized editor tree from a Firestore-shaped object.
The root node is a virtual `map` that holds the document's
top-level fields. Order of children mirrors `Object.entries` (the
renderer is responsible for any sort it wants).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `data` | `Record`\<`string`, `unknown`\> |

#### Returns

[`EditorTree`](#editortree)

***

<a id="treetodata"></a>

### treeToData()

```ts
function treeToData(tree: EditorTree): Record<string, unknown>;
```

Serialize a tree back to a Firestore-shaped object. Leaf values
pass through unchanged (so a `Timestamp` round-trips as the same
`Timestamp` instance). Maps recurse with their sorted keys; arrays
recurse in `childIds` order.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `tree` | [`EditorTree`](#editortree) |

#### Returns

`Record`\<`string`, `unknown`\>

***

<a id="truncatevectorsfordisplay"></a>

### truncateVectorsForDisplay()

```ts
function truncateVectorsForDisplay(value: unknown): unknown;
```

Deep-replace any vector-shaped value with a compact preview STRING, so the
 result can be `JSON.stringify`'d / formatted without dumping full embeddings.
 Recurses plain objects + arrays; class instances (Timestamp/GeoPoint) and
 scalars pass through untouched. Vector instances/sentinels are caught first.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `value` | `unknown` |

#### Returns

`unknown`

***

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

<a id="usedocumenteditorcontext"></a>

### useDocumentEditorContext()

```ts
function useDocumentEditorContext(): UseDocumentEditorResult;
```

Read access to the underlying editor state from inside a Root.

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

<a id="usefirestoreapi"></a>

### useFirestoreApi()

```ts
function useFirestoreApi(): FirestoreApi;
```

Read the active Firestore API bundle (defaults to in-process `pyric/firestore`).

#### Returns

[`FirestoreApi`](#firestoreapi)

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

***

<a id="validatecollectionid"></a>

### validateCollectionId()

```ts
function validateCollectionId(id: string): string;
```

Validate a collection id. Returns an error message, or `undefined` when valid.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `id` | `string` |

#### Returns

`string`

***

<a id="validatedocumentid"></a>

### validateDocumentId()

```ts
function validateDocumentId(id: string): string;
```

Validate a document id. Returns an error message, or `undefined` when valid.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `id` | `string` |

#### Returns

`string`

***

<a id="validateleaf"></a>

### validateLeaf()

```ts
function validateLeaf(type: FieldType, value: unknown): string;
```

Per-type leaf validator. Returns an error message when the value
doesn't satisfy the type's constraints, `undefined` when valid.

`map` and `array` aren't validated here — their integrity comes
from their children + (for maps) sibling-key uniqueness, which
is enforced in [validateTree](#validatetree).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `type` | [`FieldType`](#fieldtype) |
| `value` | `unknown` |

#### Returns

`string`

***

<a id="validatetree"></a>

### validateTree()

```ts
function validateTree(tree: EditorTree): {
  errorCount: number;
  tree: EditorTree;
};
```

Walk the tree, attach an `error` to each node, and return the
mutated tree along with the total error count. The function does
not mutate the input; it returns a fresh tree.

Per-leaf errors come from [validateLeaf](#validateleaf). Map nodes
additionally surface duplicate-key + empty-key errors on the
offending children (not on the parent).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `tree` | [`EditorTree`](#editortree) |

#### Returns

```ts
{
  errorCount: number;
  tree: EditorTree;
}
```

##### errorCount

```ts
errorCount: number;
```

##### tree

```ts
tree: EditorTree;
```

***

<a id="vectorpreview"></a>

### vectorPreview()

```ts
function vectorPreview(view: VectorView): string;
```

Compact, display-safe rendering of a vector: `vector · <dim> [a, b, c, …]`.
 So a real embedding never dumps its full array into a diff, a rules trace, or
 a debugger panel.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `view` | [`VectorView`](#vectorview) |

#### Returns

`string`
