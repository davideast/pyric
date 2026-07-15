---
title: "API reference: @pyric/ui/primitives"
navLabel: "@pyric/ui/primitives"
group: "API reference"
section: "@pyric/ui"
order: 24040
description: "Published declarations for @pyric/ui/primitives."
kind: "api"
apiPackage: "@pyric/ui"
apiImportPath: "@pyric/ui/primitives"
apiSubpath: "primitives"
apiSymbolCount: 31
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Interfaces

<a id="badgeprops"></a>

### BadgeProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="arialabel"></a> `ariaLabel?` | `string` | Accessible label. When set, the visible text becomes `aria-hidden` and screen readers announce this instead — useful when the badge is a terse glyph but the meaning is longer. |
| <a id="children"></a> `children` | `ReactNode` | Badge content — usually a short word like "ALLOW" or "GET". |
| <a id="classname"></a> `className?` | `string` | Forwarded to the underlying `<span>`. |
| <a id="kind"></a> `kind?` | `string` | Freeform category surfaced as `data-pyric-badge-kind`. The library doesn't enumerate kinds — the consumer decides what values exist (`allow`, `deny`, `get`, `update`, …) and styles them via `[data-pyric-badge-kind="…"]`. |

***

<a id="confirmdialogprops"></a>

### ConfirmDialogProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="body"></a> `body?` | `ReactNode` | Body content — explanation, consequences, paths affected. |
| <a id="cancellabel"></a> `cancelLabel?` | `string` | - |
| <a id="classname-1"></a> `className?` | `string` | Forwarded to the content node so consumers can style. |
| <a id="confirmlabel"></a> `confirmLabel?` | `string` | - |
| <a id="destructive"></a> `destructive?` | `boolean` | When `true`, the confirm button carries `data-pyric-destructive` so consumers can style it differently (e.g. red). |
| <a id="onconfirm"></a> `onConfirm` | () => `void` | Fires when the user presses confirm. The component does NOT close itself on confirm — the consumer typically dismisses after the destructive action resolves. |
| <a id="onopenchange"></a> `onOpenChange` | (`open`: `boolean`) => `void` | Called when the user dismisses via overlay click, Escape, or the cancel button. NOT called by `onConfirm`. |
| <a id="open"></a> `open` | `boolean` | Controlled open state. |
| <a id="title"></a> `title` | `string` | Heading. |

***

<a id="confirmoptions"></a>

### ConfirmOptions

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="body-1"></a> `body?` | `ReactNode` |
| <a id="cancellabel-1"></a> `cancelLabel?` | `string` |
| <a id="confirmlabel-1"></a> `confirmLabel?` | `string` |
| <a id="destructive-1"></a> `destructive?` | `boolean` |
| <a id="title-1"></a> `title` | `string` |

***

<a id="confirmproviderprops"></a>

### ConfirmProviderProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="children-1"></a> `children` | `ReactNode` | - |
| <a id="dialogclassname"></a> `dialogClassName?` | `string` | Forwarded to the rendered `<ConfirmDialog>`. |

***

<a id="copybuttonprops"></a>

### CopyButtonProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="arialabel-1"></a> `ariaLabel?` | `string` | Forwarded as the button's accessible label when in the idle state. Defaults to "Copy to clipboard". The copied state uses a hard-coded "Copied" label so screen readers announce the state change consistently. |
| <a id="children-2"></a> `children?` | `ReactNode` | Optional content to render inside the button. Defaults to a short text label that toggles between "Copy" and "Copied". |
| <a id="classname-2"></a> `className?` | `string` | Forwarded to the underlying `<button>`. Consumers compose Tailwind classes, CSS-module classes, or whatever they want. |
| <a id="resetms"></a> `resetMs?` | `number` | Milliseconds before the `data-copied` state attribute clears. Defaults to 2000. |
| <a id="text"></a> `text` | `string` | Text to copy to the clipboard on click. |

***

<a id="jsonviewprops"></a>

### JsonViewProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="classname-3"></a> `className?` | `string` | Forwarded to the root container. |
| <a id="defaultcollapseddepth"></a> `defaultCollapsedDepth?` | `number` | Depth at and below which object/array nodes start collapsed. `0` collapses the root, `1` collapses everything under the root, `Infinity` (default) leaves everything expanded. |
| <a id="value"></a> `value` | `unknown` | Any JSON-serializable value. |

***

<a id="segmentedcontrolprops"></a>

### SegmentedControlProps

#### Type Parameters

| Type Parameter |
| :------ |
| `T` *extends* `string` |

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="arialabel-2"></a> `ariaLabel?` | `string` | Accessible label for the radiogroup. |
| <a id="classname-4"></a> `className?` | `string` | Forwarded to the container. |
| <a id="onchange"></a> `onChange` | (`value`: `T`) => `void` | Fired with the new value when a segment is clicked. |
| <a id="options"></a> `options` | readonly [`SegmentedOption`](#segmentedoption)\<`T`\>[] | The selectable segments, rendered left-to-right. |
| <a id="value-1"></a> `value` | `T` | The currently-selected value. |

***

<a id="segmentedoption"></a>

### SegmentedOption

#### Type Parameters

| Type Parameter |
| :------ |
| `T` *extends* `string` |

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="label"></a> `label` | `ReactNode` | Visible label. |
| <a id="tone"></a> `tone?` | `string` | Freeform tone surfaced as `data-pyric-segment-tone` — e.g. `ok` / `error` so the consumer can tint the active label. The library doesn't enumerate tones. |
| <a id="value-2"></a> `value` | `T` | The value committed via `onChange` when this segment is picked. |

***

<a id="toastinput"></a>

### ToastInput

#### Extended by

- [`ToastRecord`](#toastrecord)

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="body-2"></a> `body?` | `ReactNode` | - |
| <a id="duration"></a> `duration?` | `number` | Auto-dismiss after this many ms. `0` makes the toast sticky; default is 5000. |
| <a id="kind-1"></a> `kind?` | [`ToastKind`](#toastkind) | - |
| <a id="title-2"></a> `title` | `string` | - |

***

<a id="toastproviderprops"></a>

### ToastProviderProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="children-3"></a> `children` | `ReactNode` | - |
| <a id="classname-5"></a> `className?` | `string` | Forwarded to the rendered container. |
| <a id="defaultduration"></a> `defaultDuration?` | `number` | Default auto-dismiss in ms. Per-toast `duration` overrides. Default 5000; pass `0` to make sticky-by-default. |
| <a id="regionlabel"></a> `regionLabel?` | `string` | Region label for assistive tech. Defaults to "Notifications". |

***

<a id="toastrecord"></a>

### ToastRecord

#### Extends

- [`ToastInput`](#toastinput)

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="body-3"></a> `body?` | `ReactNode` | - |
| <a id="duration-1"></a> `duration?` | `number` | Auto-dismiss after this many ms. `0` makes the toast sticky; default is 5000. |
| <a id="id"></a> `id` | `string` | - |
| <a id="kind-2"></a> `kind?` | [`ToastKind`](#toastkind) | - |
| <a id="title-3"></a> `title` | `string` | - |

***

<a id="updatehighlight"></a>

### UpdateHighlight

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="cycle"></a> `cycle` | `0` \| `1` |
| <a id="kind-3"></a> `kind` | [`UpdateHighlightKind`](#updatehighlightkind-1) |

***

<a id="usecontainersizeoptions"></a>

### UseContainerSizeOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="mediumbreakpoint"></a> `mediumBreakpoint?` | `number` | Width (px) below which the bucket is `'medium'` (and above which it is `'wide'`). Default 768. |
| <a id="narrowbreakpoint"></a> `narrowBreakpoint?` | `number` | Width (px) below which the bucket is `'narrow'`. Default 480. |

***

<a id="useupdatehighlightsoptions"></a>

### UseUpdateHighlightsOptions

#### Type Parameters

| Type Parameter |
| :------ |
| `T` |

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="durationms"></a> `durationMs?` | `number` |
| <a id="entries"></a> `entries` | `ReadonlyMap`\<`string`, `T`\> |
| <a id="equals"></a> `equals?` | (`previous`: `T`, `next`: `T`) => `boolean` |
| <a id="ready"></a> `ready?` | `boolean` |
| <a id="scope"></a> `scope` | `string` |

***

<a id="virtuallistprops"></a>

### VirtualListProps

#### Type Parameters

| Type Parameter |
| :------ |
| `T` |

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="classname-6"></a> `className?` | `string` | Forwarded to the scroll container. |
| <a id="estimatesize"></a> `estimateSize` | `number` \| (`index`: `number`) => `number` | Estimated row height in px. `useVirtualizer` measures actual rendered heights via ResizeObserver — this is just the guess used before measurement. Pass a function for variable sizing. |
| <a id="getitemkey"></a> `getItemKey?` | (`item`: `T`, `index`: `number`) => `string` \| `number` | Optional `key` resolver. Defaults to the index. Use when rows reorder so React can preserve component state across moves. |
| <a id="height"></a> `height?` | `string` \| `number` | Height the scroll container fills. Default `100%` — the consumer's parent typically constrains height. |
| <a id="items"></a> `items` | readonly `T`[] | - |
| <a id="overscan"></a> `overscan?` | `number` | Number of off-screen rows to render on each side. TanStack default is 5; bump for smoother fast scrolling. |
| <a id="renderitem"></a> `renderItem` | (`item`: `T`, `index`: `number`) => `ReactNode` | Render one row. The library handles positioning + key-by-index. |

## Type Aliases

<a id="confirmfn"></a>

### ConfirmFn()

```ts
type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `options` | [`ConfirmOptions`](#confirmoptions) |

#### Returns

`Promise`\<`boolean`\>

***

<a id="containersize"></a>

### ContainerSize

```ts
type ContainerSize = "narrow" | "medium" | "wide";
```

***

<a id="toastkind"></a>

### ToastKind

```ts
type ToastKind = "info" | "success" | "warning" | "error";
```

***

<a id="updatehighlightkind-1"></a>

### UpdateHighlightKind

```ts
type UpdateHighlightKind = "added" | "modified";
```

## Functions

<a id="badge"></a>

### Badge()

```ts
function Badge(__namedParameters: BadgeProps): Element;
```

Headless pill / tag. Renders an inline `<span>` carrying
`data-pyric-badge` and (when `kind` is set) `data-pyric-badge-kind`
so consumers can style categories with attribute selectors. Ships
no visual styling of its own.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`BadgeProps`](#badgeprops) |

#### Returns

`Element`

***

<a id="confirmdialog"></a>

### ConfirmDialog()

```ts
function ConfirmDialog(__namedParameters: ConfirmDialogProps): ReactPortal;
```

Headless confirmation dialog. Hand-rolled (we evaluated Radix
Dialog at M4 but Radix's Presence + Portal stack doesn't render
under our bun:test + JSDOM env — see plan section 7 risk #1).

Provides:
  - Portal to `document.body` (so the dialog can escape parent
    stacking contexts)
  - Escape-to-close
  - Overlay click to close
  - ARIA `role="dialog" aria-modal="true"` wiring
  - Focus restoration to the previously-focused element on close
  - Initial focus on the confirm button when opening

Ships no visual CSS. Consumers style via the structural
`data-pyric-*` attributes.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`ConfirmDialogProps`](#confirmdialogprops) |

#### Returns

`ReactPortal`

***

<a id="confirmprovider"></a>

### ConfirmProvider()

```ts
function ConfirmProvider(__namedParameters: ConfirmProviderProps): Element;
```

Mounts a single managed `<ConfirmDialog>` and exposes the
imperative `confirm()` API through context. Scoped — multiple
providers can coexist in different subtrees, each managing its
own dialog.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`ConfirmProviderProps`](#confirmproviderprops) |

#### Returns

`Element`

***

<a id="copybutton"></a>

### CopyButton()

```ts
function CopyButton(__namedParameters: CopyButtonProps): Element;
```

Headless copy-to-clipboard button. Exposes its `copied` state via
the `data-copied` attribute on the underlying `<button>` so
consumers can style the success state with `[data-copied]` (or
`data-[copied]:bg-green-500` in Tailwind's arbitrary-variant
syntax). Ships no visual styling of its own.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`CopyButtonProps`](#copybuttonprops) |

#### Returns

`Element`

***

<a id="jsonview"></a>

### JsonView()

```ts
function JsonView(__namedParameters: JsonViewProps): Element;
```

Headless collapsible JSON tree. One structural step above a
`<pre>` dump: object/array nodes are independently expandable, but
there's no editing and no syntax-color theme — just `data-pyric-*`
hooks for the consumer to style.

Styling hooks:
- `[data-pyric-ui="json-view"]` — root
- `[data-pyric-json-node]` — every node, with `data-pyric-json-type`
- `[data-pyric-json-toggle]` — the expand/collapse button (containers only)
- `[data-pyric-json-node][data-pyric-collapsed]` — a collapsed container
- `[data-pyric-json-key]` — the key/index label
- `[data-pyric-json-value]` — a primitive value
- `[data-pyric-json-summary]` — the `{…}` / `[…]` placeholder when collapsed

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`JsonViewProps`](#jsonviewprops) |

#### Returns

`Element`

***

<a id="segmentedcontrol"></a>

### SegmentedControl()

```ts
function SegmentedControl<T>(__namedParameters: SegmentedControlProps<T>): Element;
```

Headless segmented control — a single-select group of pill
buttons that reads as one widget. Wired as an ARIA radiogroup.

Ships no visual styling. Consumers style via:
- `[data-pyric-ui="segmented-control"]` — the container
- `[data-pyric-segment]` — each option button
- `[data-pyric-segment][data-pyric-active]` — the selected one
- `[data-pyric-segment-tone="…"]` — tone-tinted options

#### Type Parameters

| Type Parameter |
| :------ |
| `T` *extends* `string` |

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`SegmentedControlProps`](#segmentedcontrolprops)\<`T`\> |

#### Returns

`Element`

***

<a id="toastprovider"></a>

### ToastProvider()

```ts
function ToastProvider(__namedParameters: ToastProviderProps): Element;
```

Toast queue host. Mounts a single live region into `document.body`
via portal and exposes the imperative API via context. Scoped —
a subtree can host its own provider for isolated queues if needed.

Headless: every node carries structural `data-*` attributes, no
shipped CSS. Auto-dismiss timers are kept per-toast.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`ToastProviderProps`](#toastproviderprops) |

#### Returns

`Element`

***

<a id="useconfirm"></a>

### useConfirm()

```ts
function useConfirm(): ConfirmFn;
```

Imperative confirmation hook. Returns a function that opens the
provider-managed dialog and resolves to `true` on confirm, `false`
on cancel/dismiss.

  const confirm = useConfirm();
  const ok = await confirm({ title: 'Delete?', destructive: true });
  if (ok) await deleteDoc(ref);

Requires a `<ConfirmProvider>` ancestor.

#### Returns

[`ConfirmFn`](#confirmfn)

***

<a id="usecontainersize"></a>

### useContainerSize()

```ts
function useContainerSize<T>(options?: UseContainerSizeOptions): {
  ref: RefObject<T>;
  size: ContainerSize;
};
```

Container-query helper. Returns the current size bucket
(`'narrow' | 'medium' | 'wide'`) of the element pointed at by
the returned ref. Re-fires on resize via `ResizeObserver`.

  const { ref, size } = useContainerSize();
  return <div ref={ref} data-size={size}>…</div>;

Headless: the consumer styles via `[data-size='narrow']`
selectors. The library's feature components use this hook to
stamp their roots with `data-size`, which is the policy the
survey's modern-CSS subsection landed on (no viewport media
queries, no library-side breakpoints — push the threshold
decision to the consumer via data attributes).

#### Type Parameters

| Type Parameter | Default type |
| :------ | :------ |
| `T` *extends* `HTMLElement` | `HTMLDivElement` |

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `options?` | [`UseContainerSizeOptions`](#usecontainersizeoptions) |

#### Returns

```ts
{
  ref: RefObject<T>;
  size: ContainerSize;
}
```

##### ref

```ts
ref: RefObject<T>;
```

##### size

```ts
size: ContainerSize;
```

***

<a id="usetoast"></a>

### useToast()

```ts
function useToast(): ToastContextValue;
```

Imperative toast hook. Returns `{ toast, dismiss, toasts }`.

  const { toast } = useToast();
  toast({ title: 'Saved.', kind: 'success' });

Requires a `<ToastProvider>` ancestor.

#### Returns

`ToastContextValue`

***

<a id="useupdatehighlights"></a>

### useUpdateHighlights()

```ts
function useUpdateHighlights<T>(__namedParameters: UseUpdateHighlightsOptions<T>): ReadonlyMap<string, UpdateHighlight>;
```

Tracks transient additions and modifications between keyed snapshots.
The first ready snapshot in each scope is a silent baseline.

#### Type Parameters

| Type Parameter |
| :------ |
| `T` |

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`UseUpdateHighlightsOptions`](#useupdatehighlightsoptions)\<`T`\> |

#### Returns

`ReadonlyMap`\<`string`, [`UpdateHighlight`](#updatehighlight)\>

***

<a id="virtuallist"></a>

### VirtualList()

```ts
function VirtualList<T>(__namedParameters: VirtualListProps<T>): Element;
```

Thin wrapper around `@tanstack/react-virtual`. Renders a
scrollable container with absolutely-positioned rows, drawing
only the rows currently in view (plus `overscan` neighbors).

Headless — no shipped CSS beyond what's structurally required
to position rows (the inner spacer's `height` + each row's
`position: absolute; top: …px`). Consumers style via the
`className` prop and standard CSS targeting `[data-pyric-ui=
"virtual-list"]` on the scroll container and
`[data-pyric-virtual-row]` on each row.

#### Type Parameters

| Type Parameter |
| :------ |
| `T` |

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`VirtualListProps`](#virtuallistprops)\<`T`\> |

#### Returns

`Element`
