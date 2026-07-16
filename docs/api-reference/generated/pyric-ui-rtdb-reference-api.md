---
title: "API reference: @pyric/ui/rtdb"
navLabel: "@pyric/ui/rtdb"
outcome: "Published declarations for @pyric/ui/rtdb."
slug: "pyric-ui-rtdb-reference-api"
kind: "api"
apiPackage: "@pyric/ui"
apiImportPath: "@pyric/ui/rtdb"
apiSubpath: "rtdb"
apiSymbolCount: 42
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Interfaces

<a id="rtdbapi"></a>

### RtdbApi

The RTDB backend seam the viewer drives — an EXPLICIT bundle, not a context
default. Unlike Firestore/Auth/Storage there is no in-process handle typed
into `@pyric/ui`, so the consumer constructs the bundle and passes it to the
hook/components directly (Studio wires it to the SharedWorker client's
admin-lens ops; data views are always admin — PRINCIPLES M3).

#### Methods

<a id="remove"></a>

##### remove()

```ts
remove(path: string): Promise<void>;
```

Delete the subtree at `path`.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

###### Returns

`Promise`\<`void`\>

<a id="set"></a>

##### set()

```ts
set(path: string, value: unknown): Promise<void>;
```

Replace the value at `path` (`null` deletes, RTDB semantics).

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |
| `value` | `unknown` |

###### Returns

`Promise`\<`void`\>

<a id="subscribevalue"></a>

##### subscribeValue()

```ts
subscribeValue(
   path: string,
   next: (value: unknown) => void,
   error?: (err: unknown) => void): () => void;
```

Live value subscription at `path`: `next` fires with the subtree's plain
JSON value (`null` when absent) on subscribe and after every change.
Returns the unsubscribe.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |
| `next` | (`value`: `unknown`) => `void` |
| `error?` | (`err`: `unknown`) => `void` |

###### Returns

```ts
(): void;
```

###### Returns

`void`

***

<a id="rtdbcrumb"></a>

### RtdbCrumb

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="label"></a> `label` | `string` | The path segment to display. |
| <a id="path"></a> `path` | `string` | Absolute database path this crumb navigates to. |

***

<a id="rtdbpathbarprops"></a>

### RtdbPathBarProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="classname"></a> `className?` | `string` | - |
| <a id="inputprefix"></a> `inputPrefix?` | `string` | Text shown before the input while editing (the non-editable URL part). |
| <a id="onnavigate"></a> `onNavigate` | (`path`: `string`) => `void` | Fired with the parsed absolute path on crumb click or input submit. |
| <a id="path-1"></a> `path` | `string` | Current absolute database path (`'/'` for root). |
| <a id="rootlabel"></a> `rootLabel?` | `ReactNode` | Root crumb label — the database/instance identity (e.g. the sandbox slug). Default `'/'`. |

***

<a id="rtdbtreecontroller"></a>

### RtdbTreeController

Everything a tree view needs: the reducer state plus path-addressed
selectors and the expansion/paging commands. All paths are ABSOLUTE
database paths.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="pagesize"></a> `pageSize` | `number` |
| <a id="state"></a> `state` | [`RtdbTreeState`](#rtdbtreestate) |

#### Methods

<a id="childrenat"></a>

##### childrenAt()

```ts
childrenAt(path: string): RtdbVisibleChildren;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

###### Returns

[`RtdbVisibleChildren`](#rtdbvisiblechildren)

<a id="isexpanded"></a>

##### isExpanded()

```ts
isExpanded(path: string): boolean;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

###### Returns

`boolean`

<a id="showmore"></a>

##### showMore()

```ts
showMore(path: string): void;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

###### Returns

`void`

<a id="toggle"></a>

##### toggle()

```ts
toggle(path: string): void;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

###### Returns

`void`

<a id="updateat"></a>

##### updateAt()

```ts
updateAt(path: string): UpdateHighlight;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

###### Returns

`UpdateHighlight`

<a id="valueat"></a>

##### valueAt()

```ts
valueAt(path: string): unknown;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

###### Returns

`unknown`

***

<a id="rtdbtreeprops"></a>

### RtdbTreeProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="api"></a> `api` | [`RtdbApi`](#rtdbapi) | Mutation backend (admin lens in Studio). |
| <a id="classname-1"></a> `className?` | `string` | - |
| <a id="onnavigate-1"></a> `onNavigate?` | (`path`: `string`) => `void` | Key-click navigation: re-roots the viewer at the clicked node (wire to the same path state as the path bar). |
| <a id="rootlabel-1"></a> `rootLabel?` | `ReactNode` | Label for the view-root row when the root is `'/'` — the database / instance identity. Default `'/'`. |
| <a id="tree"></a> `tree` | [`RtdbTreeController`](#rtdbtreecontroller) | The live tree controller from `useRtdbTree`. |

***

<a id="rtdbtreestate"></a>

### RtdbTreeState

RTDB viewer tree state (pure reducer). The interaction form is the Firebase
console / firebase-tools-ui data viewer: one view root (set by the path
bar), expandable/collapsible descendants, and per-level paging for wide
child lists.

DATA-LOADING STRATEGY (documented decision): the worker protocol exposes
`rtdb.get` / value subscriptions per PATH but no shallow or depth-limited
reads — a read at a path always ships that path's WHOLE subtree over the
MessagePort. A per-expand fetch would therefore re-ship data the view-root
read already delivered. So the viewer holds ONE live value subscription at
the view root (realtime by construction) and makes RENDERING lazy instead:
nodes below the root start collapsed and mount nothing until expanded, and
an expanded level renders at most `pageSize` children until "show more"
(console-style paging at 50, chosen over virtualization for its simplicity —
it bounds the mounted DOM the same way). Cost is bounded by navigating the
view root deeper, which is the path bar's job.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="error"></a> `error` | `string` | - |
| <a id="expanded"></a> `expanded` | `Record`\<`string`, `true`\> | Expanded descendant paths (absolute). The view root itself is always expanded and is never in this set. |
| <a id="pages"></a> `pages` | `Record`\<`string`, `number`\> | Per-path shown-children override (absolute path → count). Absent means one page. |
| <a id="path-2"></a> `path` | `string` | The view root — the absolute database path the path bar points at. |
| <a id="status"></a> `status` | `"loading"` \| `"live"` \| `"error"` | `loading` until the first snapshot after a navigate; then `live`. |
| <a id="value"></a> `value` | `unknown` | The subtree value AT `path` (plain JSON; `null` = nothing there). |

***

<a id="rtdbvisiblechildren"></a>

### RtdbVisibleChildren

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="entries"></a> `entries` | \[`string`, `unknown`\][] | The children to render, in key order, capped at the shown count. |
| <a id="hiddencount"></a> `hiddenCount` | `number` | How many more "show more" would reveal (0 = all shown). |
| <a id="total"></a> `total` | `number` | Total direct children at this path. |

***

<a id="usertdbtreeoptions"></a>

### UseRtdbTreeOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="pagesize-1"></a> `pageSize?` | `number` | Children rendered per level before "show more". Default 50. |

## Type Aliases

<a id="rtdbeditorresult"></a>

### RtdbEditorResult

```ts
type RtdbEditorResult =
  | {
  ok: true;
  value: unknown;
}
  | {
  error: string;
  ok: false;
};
```

***

<a id="rtdbeditortype"></a>

### RtdbEditorType

```ts
type RtdbEditorType = "string" | "number" | "boolean" | "json";
```

Inline value-editor logic (pure): the type select + text input pair used by
the tree's click-to-edit and add-child rows. Four author-facing types cover
every RTDB value: string / number / boolean scalars, and `json` for
objects/arrays/null (or any hand-written literal).

***

<a id="rtdbtreeaction"></a>

### RtdbTreeAction

```ts
type RtdbTreeAction =
  | {
  path: string;
  type: "navigate";
}
  | {
  path: string;
  type: "value";
  value: unknown;
}
  | {
  message: string;
  path: string;
  type: "error";
}
  | {
  path: string;
  type: "toggle";
}
  | {
  path: string;
  type: "expand";
}
  | {
  path: string;
  type: "collapse";
}
  | {
  pageSize: number;
  path: string;
  type: "show-more";
};
```

#### Type Declaration

```ts
{
  path: string;
  type: "navigate";
}
```

##### path

```ts
path: string;
```

##### type

```ts
type: "navigate";
```

Path bar navigation: reset to a new view root.

```ts
{
  path: string;
  type: "value";
  value: unknown;
}
```

##### path

```ts
path: string;
```

##### type

```ts
type: "value";
```

##### value

```ts
value: unknown;
```

A value snapshot arrived. `path` is the subscription's view root — a
 snapshot from a superseded subscription (its path no longer the state's)
 is ignored.

```ts
{
  message: string;
  path: string;
  type: "error";
}
```

##### message

```ts
message: string;
```

##### path

```ts
path: string;
```

##### type

```ts
type: "error";
```

The view-root subscription failed (same `path` guard as `value`).

```ts
{
  path: string;
  type: "toggle";
}
```

##### path

```ts
path: string;
```

##### type

```ts
type: "toggle";
```

```ts
{
  path: string;
  type: "expand";
}
```

##### path

```ts
path: string;
```

##### type

```ts
type: "expand";
```

```ts
{
  path: string;
  type: "collapse";
}
```

##### path

```ts
path: string;
```

##### type

```ts
type: "collapse";
```

```ts
{
  pageSize: number;
  path: string;
  type: "show-more";
}
```

##### pageSize

```ts
pageSize: number;
```

##### path

```ts
path: string;
```

##### type

```ts
type: "show-more";
```

Reveal one more page of children at `path`.

## Variables

<a id="rtdb_default_page_size"></a>

### RTDB\_DEFAULT\_PAGE\_SIZE

```ts
const RTDB_DEFAULT_PAGE_SIZE: 50 = 50;
```

Console-style child paging (Firebase console shows 50, then "show more").

***

<a id="rtdb_editor_types"></a>

### RTDB\_EDITOR\_TYPES

```ts
const RTDB_EDITOR_TYPES: readonly RtdbEditorType[];
```

## Functions

<a id="coercertdbeditorvalue"></a>

### coerceRtdbEditorValue()

```ts
function coerceRtdbEditorValue(type: RtdbEditorType, text: string): RtdbEditorResult;
```

Coerce the editor's text under the selected type, or explain why not.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `type` | [`RtdbEditorType`](#rtdbeditortype) |
| `text` | `string` |

#### Returns

[`RtdbEditorResult`](#rtdbeditorresult)

***

<a id="formatrtdbeditorvalue"></a>

### formatRtdbEditorValue()

```ts
function formatRtdbEditorValue(value: unknown, type: RtdbEditorType): string;
```

Seed the editor's text field from the current value under a type.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `value` | `unknown` |
| `type` | [`RtdbEditorType`](#rtdbeditortype) |

#### Returns

`string`

***

<a id="formatrtdbjson"></a>

### formatRtdbJson()

```ts
function formatRtdbJson(value: unknown): string;
```

`@pyric/ui/rtdb` — the headless RTDB data viewer, in the Firebase console /
firebase-tools-ui form: an editable path bar (crumbs + direct path entry)
over an expandable tree with inline add/edit/delete affordances. Follows
this package's firestore/auth/storage split: pure logic + hooks +
unstyled components on `data-*` styling contracts; the consumer (Studio)
brings the CSS and the backend bundle ([RtdbApi](#rtdbapi)).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `value` | `unknown` |

#### Returns

`string`

***

<a id="formatrtdbvaluelabel"></a>

### formatRtdbValueLabel()

```ts
function formatRtdbValueLabel(value: unknown): string;
```

Leaf value text, console style: strings quoted, primitives literal.
 Defensive on objects: never `String`-coerce (that's `[object Object]`) —
 fall back to JSON. Object values should have been normalized/expanded away
 before reaching a leaf label; this keeps the label honest if one slips in.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `value` | `unknown` |

#### Returns

`string`

***

<a id="hasrtdbchildren"></a>

### hasRtdbChildren()

```ts
function hasRtdbChildren(value: unknown): boolean;
```

Does this value render as a PARENT node (has child keys)? RTDB has no true
 arrays — an array is an object with numeric keys, and renders as one.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `value` | `unknown` |

#### Returns

`boolean`

***

<a id="inferrtdbeditortype"></a>

### inferRtdbEditorType()

```ts
function inferRtdbEditorType(value: unknown): RtdbEditorType;
```

The editor type a value opens under when clicked.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `value` | `unknown` |

#### Returns

[`RtdbEditorType`](#rtdbeditortype)

***

<a id="initialrtdbtree"></a>

### initialRtdbTree()

```ts
function initialRtdbTree(path: string): RtdbTreeState;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

#### Returns

[`RtdbTreeState`](#rtdbtreestate)

***

<a id="isrtdbobjectvalue"></a>

### isRtdbObjectValue()

```ts
function isRtdbObjectValue(value: unknown): value is Record<string, unknown>;
```

`@pyric/ui/rtdb` — the headless RTDB data viewer, in the Firebase console /
firebase-tools-ui form: an editable path bar (crumbs + direct path entry)
over an expandable tree with inline add/edit/delete affordances. Follows
this package's firestore/auth/storage split: pure logic + hooks +
unstyled components on `data-*` styling contracts; the consumer (Studio)
brings the CSS and the backend bundle ([RtdbApi](#rtdbapi)).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `value` | `unknown` |

#### Returns

`value is Record<string, unknown>`

***

<a id="isrtdbpathexpanded"></a>

### isRtdbPathExpanded()

```ts
function isRtdbPathExpanded(state: RtdbTreeState, path: string): boolean;
```

Is this absolute path expanded? The view root always is.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `state` | [`RtdbTreeState`](#rtdbtreestate) |
| `path` | `string` |

#### Returns

`boolean`

***

<a id="joinrtdbpath"></a>

### joinRtdbPath()

```ts
function joinRtdbPath(base: string, child: string): string;
```

`@pyric/ui/rtdb` — the headless RTDB data viewer, in the Firebase console /
firebase-tools-ui form: an editable path bar (crumbs + direct path entry)
over an expandable tree with inline add/edit/delete affordances. Follows
this package's firestore/auth/storage split: pure logic + hooks +
unstyled components on `data-*` styling contracts; the consumer (Studio)
brings the CSS and the backend bundle ([RtdbApi](#rtdbapi)).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `base` | `string` |
| `child` | `string` |

#### Returns

`string`

***

<a id="normalizertdbpath"></a>

### normalizeRtdbPath()

```ts
function normalizeRtdbPath(path: string): string;
```

RTDB path + value helpers (pure). Paths are ALWAYS normalized to the
`'/'`-rooted form (`'/'` for the root, `'/a/b'` otherwise) so every module in
this package — the tree reducer, the path bar, the viewer components — agrees
on what a path is.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

#### Returns

`string`

***

<a id="normalizertdbsnapshotvalue"></a>

### normalizeRtdbSnapshotValue()

```ts
function normalizeRtdbSnapshotValue(value: unknown): unknown;
```

Normalize a snapshot value to RTDB semantics before it enters tree state:
an empty object IS null (RTDB has no empty containers — the server prunes
them), so `{}` — and any object whose children all normalize away — becomes
`null`. Without this, an empty database's root value `{}` fails
`hasRtdbChildren` and renders as a scalar leaf (`String({})` →
`"[object Object]"`). Reuses the input object when nothing changed.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `value` | `unknown` |

#### Returns

`unknown`

***

<a id="parentrtdbpath"></a>

### parentRtdbPath()

```ts
function parentRtdbPath(path: string): string;
```

`@pyric/ui/rtdb` — the headless RTDB data viewer, in the Firebase console /
firebase-tools-ui form: an editable path bar (crumbs + direct path entry)
over an expandable tree with inline add/edit/delete affordances. Follows
this package's firestore/auth/storage split: pure logic + hooks +
unstyled components on `data-*` styling contracts; the consumer (Studio)
brings the CSS and the backend bundle ([RtdbApi](#rtdbapi)).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

#### Returns

`string`

***

<a id="parsertdbjson"></a>

### parseRtdbJson()

```ts
function parseRtdbJson(value: string): unknown;
```

`@pyric/ui/rtdb` — the headless RTDB data viewer, in the Firebase console /
firebase-tools-ui form: an editable path bar (crumbs + direct path entry)
over an expandable tree with inline add/edit/delete affordances. Follows
this package's firestore/auth/storage split: pure logic + hooks +
unstyled components on `data-*` styling contracts; the consumer (Studio)
brings the CSS and the backend bundle ([RtdbApi](#rtdbapi)).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `value` | `string` |

#### Returns

`unknown`

***

<a id="parsertdbpathinput"></a>

### parseRtdbPathInput()

```ts
function parseRtdbPathInput(raw: string): string;
```

Normalize raw path-input text to a database path. Tolerant of what people
paste into a database URL bar:
  - a plain path, with or without the leading slash (`rooms/r1`, `/rooms`)
  - a full URL (`https://x.firebaseio.com/rooms/r1` → `/rooms/r1`)
  - repeated/trailing slashes, surrounding whitespace
  - a `?query` / `#hash` tail (dropped)
Empty input is the root.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `raw` | `string` |

#### Returns

`string`

***

<a id="previewrtdbvalue"></a>

### previewRtdbValue()

```ts
function previewRtdbValue(value: unknown): string;
```

`@pyric/ui/rtdb` — the headless RTDB data viewer, in the Firebase console /
firebase-tools-ui form: an editable path bar (crumbs + direct path entry)
over an expandable tree with inline add/edit/delete affordances. Follows
this package's firestore/auth/storage split: pure logic + hooks +
unstyled components on `data-*` styling contracts; the consumer (Studio)
brings the CSS and the backend bundle ([RtdbApi](#rtdbapi)).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `value` | `unknown` |

#### Returns

`string`

***

<a id="relativertdbpath"></a>

### relativeRtdbPath()

```ts
function relativeRtdbPath(base: string, target: string): string;
```

The path of `target` RELATIVE to `base`, or `null` when `target` is not
`base` or one of its descendants. `'/'` means "target IS base". Lets the
tree address nodes by absolute database path while the loaded value sits at
the view root.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `base` | `string` |
| `target` | `string` |

#### Returns

`string`

***

<a id="rtdbchildentries"></a>

### rtdbChildEntries()

```ts
function rtdbChildEntries(value: unknown): [string, unknown][];
```

Child entries sorted RTDB-console style: numeric-aware key order
 (`2` before `10`), then lexicographic.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `value` | `unknown` |

#### Returns

\[`string`, `unknown`\][]

***

<a id="rtdbcrumbs"></a>

### rtdbCrumbs()

```ts
function rtdbCrumbs(path: string): RtdbCrumb[];
```

The non-root crumbs for a path, in order. `'/'` yields `[]` — the root crumb
is the caller's (it carries the database/instance label, not a segment).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

#### Returns

[`RtdbCrumb`](#rtdbcrumb)[]

***

<a id="rtdbkeyinputerror"></a>

### rtdbKeyInputError()

```ts
function rtdbKeyInputError(key: string): string;
```

Why a typed child key is unusable, or `null` when it's fine. RTDB forbids
 `. $ # [ ] /` in keys (a `/` would silently create a nested path).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `key` | `string` |

#### Returns

`string`

***

<a id="rtdbpathbar"></a>

### RtdbPathBar()

```ts
function RtdbPathBar(__namedParameters: RtdbPathBarProps): Element;
```

The editable path bar of the RTDB viewer — the interaction form of the
Firebase console / firebase-tools-ui database URL bar (clean-room
adaptation): in DISPLAY mode the path renders as clickable crumbs
(root → … → current) plus an edit affordance; EDIT mode swaps in a text
input seeded with the current path — Enter navigates, Escape or blur
cancels. Pasted full URLs and missing leading slashes are tolerated
(`parseRtdbPathInput`).

Headless. Consumers style via:
- `[data-pyric-ui="rtdb-path-bar"]` — the root (`data-rtdb-editing` when editing)
- `[data-rtdb-crumb]` / `[data-rtdb-crumb-root]` / `[data-pyric-current]`
- `[data-rtdb-crumb-separator]`
- `[data-rtdb-path-edit]` — the edit button
- `[data-rtdb-path-form]`, `[data-rtdb-path-prefix]`, `[data-rtdb-path-input]`

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`RtdbPathBarProps`](#rtdbpathbarprops) |

#### Returns

`Element`

***

<a id="rtdbpathsegments"></a>

### rtdbPathSegments()

```ts
function rtdbPathSegments(path: string): string[];
```

`@pyric/ui/rtdb` — the headless RTDB data viewer, in the Firebase console /
firebase-tools-ui form: an editable path bar (crumbs + direct path entry)
over an expandable tree with inline add/edit/delete affordances. Follows
this package's firestore/auth/storage split: pure logic + hooks +
unstyled components on `data-*` styling contracts; the consumer (Studio)
brings the CSS and the backend bundle ([RtdbApi](#rtdbapi)).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

#### Returns

`string`[]

***

<a id="rtdbtree"></a>

### RtdbTree()

```ts
function RtdbTree(__namedParameters: RtdbTreeProps): Element;
```

The RTDB data tree — the interaction form of the Firebase console /
firebase-tools-ui database viewer (clean-room adaptation of the
NodeContainer/NodeParent/NodeLeaf split):

- parents render a caret (expand/collapse), leaves a `key: value` row;
- keys navigate (re-root the view), carets only toggle;
- hover/focus reveals per-node actions: `+` add child, `×` delete —
  delete flips to an INLINE two-step confirm (no modal, C3);
- leaf values are click-to-edit inline (type select: string / number /
  boolean / JSON);
- wide levels page at `tree.pageSize` with a "show more" row (the console's
  form — see `reducers/tree.ts` for why paging over virtualization).

Headless: consumers style `[data-pyric-ui="rtdb-tree"]` and the
`data-rtdb-*` attributes (`node`, `row`, `caret`, `key`, `sep`, `value`,
`actions`, `action-add`, `action-delete`, `confirm`, `editor`, `children`,
`show-more`, `error`, `loading`). An empty root renders the console's
classic form — `<root>: null` — not an instructional empty state.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`RtdbTreeProps`](#rtdbtreeprops) |

#### Returns

`Element`

***

<a id="rtdbtreereducer"></a>

### rtdbTreeReducer()

```ts
function rtdbTreeReducer(state: RtdbTreeState, action: RtdbTreeAction): RtdbTreeState;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `state` | [`RtdbTreeState`](#rtdbtreestate) |
| `action` | [`RtdbTreeAction`](#rtdbtreeaction) |

#### Returns

[`RtdbTreeState`](#rtdbtreestate)

***

<a id="rtdbtreevalueat"></a>

### rtdbTreeValueAt()

```ts
function rtdbTreeValueAt(state: RtdbTreeState, path: string): unknown;
```

The subtree value at an ABSOLUTE database path, resolved against the
 loaded view-root value. `null` outside the view root.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `state` | [`RtdbTreeState`](#rtdbtreestate) |
| `path` | `string` |

#### Returns

`unknown`

***

<a id="rtdbvalueat"></a>

### rtdbValueAt()

```ts
function rtdbValueAt(root: unknown, path: string): unknown;
```

`@pyric/ui/rtdb` — the headless RTDB data viewer, in the Firebase console /
firebase-tools-ui form: an editable path bar (crumbs + direct path entry)
over an expandable tree with inline add/edit/delete affordances. Follows
this package's firestore/auth/storage split: pure logic + hooks +
unstyled components on `data-*` styling contracts; the consumer (Studio)
brings the CSS and the backend bundle ([RtdbApi](#rtdbapi)).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `root` | `unknown` |
| `path` | `string` |

#### Returns

`unknown`

***

<a id="rtdbvaluekind"></a>

### rtdbValueKind()

```ts
function rtdbValueKind(value: unknown): string;
```

`@pyric/ui/rtdb` — the headless RTDB data viewer, in the Firebase console /
firebase-tools-ui form: an editable path bar (crumbs + direct path entry)
over an expandable tree with inline add/edit/delete affordances. Follows
this package's firestore/auth/storage split: pure logic + hooks +
unstyled components on `data-*` styling contracts; the consumer (Studio)
brings the CSS and the backend bundle ([RtdbApi](#rtdbapi)).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `value` | `unknown` |

#### Returns

`string`

***

<a id="rtdbvisiblechildren-1"></a>

### rtdbVisibleChildren()

```ts
function rtdbVisibleChildren(
   state: RtdbTreeState,
   path: string,
   pageSize: number): RtdbVisibleChildren;
```

The page-capped child list at an absolute path (console pages at 50).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `state` | [`RtdbTreeState`](#rtdbtreestate) |
| `path` | `string` |
| `pageSize` | `number` |

#### Returns

[`RtdbVisibleChildren`](#rtdbvisiblechildren)

***

<a id="usertdbtree"></a>

### useRtdbTree()

```ts
function useRtdbTree(
   api: RtdbApi,
   path: string,
   options?: UseRtdbTreeOptions): RtdbTreeController;
```

Live tree state for the RTDB viewer: subscribes to the value at the view
root `path` (realtime — every write re-delivers the subtree) and runs the
expansion/paging reducer over it. See `reducers/tree.ts` for the
one-subscription-per-view-root loading strategy and why expansion is a
pure render toggle rather than a fetch.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `api` | [`RtdbApi`](#rtdbapi) |
| `path` | `string` |
| `options?` | [`UseRtdbTreeOptions`](#usertdbtreeoptions) |

#### Returns

[`RtdbTreeController`](#rtdbtreecontroller)
