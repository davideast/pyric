---
title: "API reference: @pyric/ui/agents"
navLabel: "@pyric/ui/agents"
group: "API reference"
section: "@pyric/ui"
order: 9035
description: "Published declarations for @pyric/ui/agents."
kind: "api"
apiPackage: "@pyric/ui"
apiImportPath: "@pyric/ui/agents"
apiSubpath: "agents"
apiSymbolCount: 21
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Interfaces

<a id="contextwindowmeterprops"></a>

### ContextWindowMeterProps

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="buttonclassname"></a> `buttonClassName?` | `string` |
| <a id="classname"></a> `className?` | `string` |
| <a id="formattokens"></a> `formatTokens?` | (`tokens`: `number`) => `string` |
| <a id="onopen"></a> `onOpen?` | () => `void` |
| <a id="ringclassname"></a> `ringClassName?` | `string` |
| <a id="ringinnerclassname"></a> `ringInnerClassName?` | `string` |
| <a id="snapshot"></a> `snapshot` | `ContextWindowSnapshot` |
| <a id="tooltipclassname"></a> `tooltipClassName?` | `string` |

***

<a id="contextwindowpanelprops"></a>

### ContextWindowPanelProps

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="classname-1"></a> `className?` | `string` |
| <a id="formattokens-1"></a> `formatTokens?` | (`tokens`: `number`) => `string` |
| <a id="oncompactnow"></a> `onCompactNow?` | () => `void` |
| <a id="slots"></a> `slots?` | `ClassSlots` |
| <a id="snapshot-1"></a> `snapshot` | `ContextWindowSnapshot` |

***

<a id="contextwindowringprops"></a>

### ContextWindowRingProps

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="classname-2"></a> `className?` | `string` |
| <a id="innerclassname"></a> `innerClassName?` | `string` |
| <a id="size"></a> `size?` | `number` |
| <a id="snapshot-2"></a> `snapshot` | `ContextWindowSnapshot` |
| <a id="style"></a> `style?` | `CSSProperties` |

***

<a id="emptystateprops"></a>

### EmptyStateProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="body"></a> `body?` | `ReactNode` | - |
| <a id="classname-3"></a> `className?` | `string` | - |
| <a id="icon"></a> `icon?` | `ReactNode` | Optional pre-rendered icon node — consumers pass whatever icon primitive their app uses (Material Symbols span, lucide-react component, plain SVG, …). |
| <a id="title"></a> `title` | `ReactNode` | - |

***

<a id="foldprops"></a>

### FoldProps

`@pyric/ui/agents` — headless structural components for agentic UIs
(chat surfaces, tool-call drill-ins, streaming state indicators).

Matches the rest of `@pyric/ui`: zero shipped CSS. Components emit
`data-pyric-*` attributes and accept `className` slots. Consumers
bring their own design system (Tailwind, CSS modules, plain CSS)
and attach styling via attribute selectors or class names.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="bodyclassname"></a> `bodyClassName?` | `string` | Forwarded to the body wrapper revealed when open. |
| <a id="children"></a> `children` | `ReactNode` | Revealed when the user expands. |
| <a id="classname-4"></a> `className?` | `string` | Forwarded to the root `<details>` element. |
| <a id="defaultopen"></a> `defaultOpen?` | `boolean` | - |
| <a id="header"></a> `header` | `ReactNode` | Visible summary line, always rendered. |
| <a id="headeraction"></a> `headerAction?` | `ReactNode` | Optional right-aligned action (e.g. a copy button). Children should `stopPropagation` so clicks don't toggle the fold. |
| <a id="summaryclassname"></a> `summaryClassName?` | `string` | Forwarded to the `<summary>` element. |
| <a id="tone"></a> `tone?` | [`FoldTone`](#foldtone) | Surfaced via `[data-pyric-fold-tone]` so consumers can tint the summary or border based on semantic context (error / thought). Defaults to `normal`. |

***

<a id="modalprops"></a>

### ModalProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="arialabel"></a> `ariaLabel?` | `string` | - |
| <a id="backdropclassname"></a> `backdropClassName?` | `string` | Forwarded to the backdrop element. |
| <a id="children-1"></a> `children` | `ReactNode` | - |
| <a id="classname-5"></a> `className?` | `string` | Forwarded to the root wrapper (covers the full viewport). |
| <a id="onclose"></a> `onClose` | () => `void` | - |
| <a id="open"></a> `open` | `boolean` | - |
| <a id="panelclassname"></a> `panelClassName?` | `string` | Forwarded to the inner panel. |

***

<a id="pulsingdotprops"></a>

### PulsingDotProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="classname-6"></a> `className?` | `string` | Forwarded to the outer wrapper. Consumers attach all visual styling (size, animation, color) via this hook or by selecting on `[data-pyric-ui="pulsing-dot"]`. |

***

<a id="requestusagetimelineprops"></a>

### RequestUsageTimelineProps

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="classname-7"></a> `className?` | `string` |
| <a id="empty"></a> `empty?` | `ReactNode` |
| <a id="formattokens-2"></a> `formatTokens?` | (`tokens`: `number`) => `string` |
| <a id="onopentool"></a> `onOpenTool?` | (`messageId`: `string`, `callId`: `string`) => `void` |
| <a id="requests"></a> `requests` | readonly `SessionRequestUsage`[] |
| <a id="slots-1"></a> `slots?` | `ClassSlots` |

***

<a id="sessionspendsummaryprops"></a>

### SessionSpendSummaryProps

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="classname-8"></a> `className?` | `string` |
| <a id="currentcontexttokens"></a> `currentContextTokens?` | `number` |
| <a id="formattokens-3"></a> `formatTokens?` | (`tokens`: `number`) => `string` |
| <a id="slots-2"></a> `slots?` | `ClassSlots` |
| <a id="usage"></a> `usage?` | `SessionTokenUsage` |

***

<a id="tokenusageinlineprops"></a>

### TokenUsageInlineProps

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="classname-9"></a> `className?` | `string` |
| <a id="formattokens-4"></a> `formatTokens?` | (`tokens`: `number`) => `string` |
| <a id="labelclassname"></a> `labelClassName?` | `string` |
| <a id="usage-1"></a> `usage?` | `SessionTokenUsage` |
| <a id="valueclassname"></a> `valueClassName?` | `string` |

## Type Aliases

<a id="foldtone"></a>

### FoldTone

```ts
type FoldTone = "normal" | "error" | "thought";
```

`@pyric/ui/agents` — headless structural components for agentic UIs
(chat surfaces, tool-call drill-ins, streaming state indicators).

Matches the rest of `@pyric/ui`: zero shipped CSS. Components emit
`data-pyric-*` attributes and accept `className` slots. Consumers
bring their own design system (Tailwind, CSS modules, plain CSS)
and attach styling via attribute selectors or class names.

## Functions

<a id="contextwindowmeter"></a>

### ContextWindowMeter()

```ts
function ContextWindowMeter(__namedParameters: ContextWindowMeterProps): Element;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`ContextWindowMeterProps`](#contextwindowmeterprops) |

#### Returns

`Element`

***

<a id="contextwindowpanel"></a>

### ContextWindowPanel()

```ts
function ContextWindowPanel(__namedParameters: ContextWindowPanelProps): Element;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`ContextWindowPanelProps`](#contextwindowpanelprops) |

#### Returns

`Element`

***

<a id="contextwindowring"></a>

### ContextWindowRing()

```ts
function ContextWindowRing(__namedParameters: ContextWindowRingProps): Element;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`ContextWindowRingProps`](#contextwindowringprops) |

#### Returns

`Element`

***

<a id="emptystate"></a>

### EmptyState()

```ts
function EmptyState(__namedParameters: EmptyStateProps): Element;
```

Headless zero-state. Structural only: icon slot, title, optional
body, all wrapped in a flex container marked
`[data-pyric-ui="empty-state"]`. Consumers attach all visual
styling.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`EmptyStateProps`](#emptystateprops) |

#### Returns

`Element`

***

<a id="fold"></a>

### Fold()

```ts
function Fold(__namedParameters: FoldProps): Element;
```

Headless disclosure container — native `<details>` for keyboard /
a11y. Ships zero visual styling. Consumers style via the three
`className` slots or by selecting on:

  [data-pyric-ui="fold"]             — root `<details>`
  [data-pyric-ui="fold"][open]       — expanded state
  [data-pyric-fold-tone="error"]     — error tint
  [data-pyric-fold-tone="thought"]   — thought-stream tint
  [data-pyric-fold-summary]          — clickable summary row
  [data-pyric-fold-chevron]          — disclosure indicator slot
  [data-pyric-fold-body]             — revealed body wrapper

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`FoldProps`](#foldprops) |

#### Returns

`Element`

***

<a id="modal"></a>

### Modal()

```ts
function Modal(__namedParameters: ModalProps): Element;
```

Headless modal — provides behavior only (Escape-to-close, backdrop
click, `aria-modal`). Consumers attach all visual styling via the
three `className` slots or by selecting on the emitted data
attributes:

  [data-pyric-ui="modal"]            — root viewport wrapper
  [data-pyric-modal-backdrop]        — clickable backdrop
  [data-pyric-modal-panel]           — inner panel containing children

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`ModalProps`](#modalprops) |

#### Returns

`Element`

***

<a id="pulsingdot"></a>

### PulsingDot()

```ts
function PulsingDot(__namedParameters: PulsingDotProps): Element;
```

Headless "live / streaming" indicator. Ships zero visual styling.

Renders three nested spans so consumers can style ring + core
independently:

  <span data-pyric-ui="pulsing-dot">
    <span data-pyric-pulse-ring />
    <span data-pyric-pulse-core />
  </span>

Animation, color, and size are entirely consumer-defined.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`PulsingDotProps`](#pulsingdotprops) |

#### Returns

`Element`

***

<a id="requestusagetimeline"></a>

### RequestUsageTimeline()

```ts
function RequestUsageTimeline(__namedParameters: RequestUsageTimelineProps): Element;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`RequestUsageTimelineProps`](#requestusagetimelineprops) |

#### Returns

`Element`

***

<a id="sessionspendsummary"></a>

### SessionSpendSummary()

```ts
function SessionSpendSummary(__namedParameters: SessionSpendSummaryProps): Element;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`SessionSpendSummaryProps`](#sessionspendsummaryprops) |

#### Returns

`Element`

***

<a id="tokenusageinline"></a>

### TokenUsageInline()

```ts
function TokenUsageInline(__namedParameters: TokenUsageInlineProps): Element;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`TokenUsageInlineProps`](#tokenusageinlineprops) |

#### Returns

`Element`
