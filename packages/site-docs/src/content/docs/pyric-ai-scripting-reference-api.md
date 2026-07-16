---
title: "API reference: pyric/ai/scripting"
navLabel: "pyric/ai/scripting"
group: "API reference"
section: "pyric"
order: 24009
description: "Published declarations for pyric/ai/scripting."
kind: "api"
apiPackage: "pyric"
apiImportPath: "pyric/ai/scripting"
apiSubpath: "ai/scripting"
apiSymbolCount: 7
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Interfaces

<a id="httperrorrespond"></a>

### HttpErrorRespond

An HTTP error capture pasted whole: status + the wire error body.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="error"></a> `error` | \{ `body`: \{ `error`: \{ `code?`: `number`; `details?`: `Record`\<`string`, `unknown`\>[]; `message?`: `string`; `status?`: `string`; \}; \}; `httpStatus`: `number`; \} |
| `error.body` | \{ `error`: \{ `code?`: `number`; `details?`: `Record`\<`string`, `unknown`\>[]; `message?`: `string`; `status?`: `string`; \}; \} |
| `error.body.error` | \{ `code?`: `number`; `details?`: `Record`\<`string`, `unknown`\>[]; `message?`: `string`; `status?`: `string`; \} |
| `error.body.error.code?` | `number` |
| `error.body.error.details?` | `Record`\<`string`, `unknown`\>[] |
| `error.body.error.message?` | `string` |
| `error.body.error.status?` | `string` |
| `error.httpStatus` | `number` |

***

<a id="scriptentry"></a>

### ScriptEntry

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="match"></a> `match?` | [`ScriptMatcher`](#scriptmatcher) | Absent ⇒ unconditional next-in-queue. |
| <a id="respond"></a> `respond` | [`ScriptRespond`](#scriptrespond) | - |

***

<a id="scriptingentry"></a>

### ScriptingEntry

A script entry as authored: broker entries plus the HTTP-capture error form.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="match-1"></a> `match?` | [`ScriptMatcher`](#scriptmatcher) |
| <a id="respond-1"></a> `respond` | \| [`HttpErrorRespond`](#httperrorrespond) \| [`ScriptRespond`](#scriptrespond) |

## Type Aliases

<a id="scriptmatcher"></a>

### ScriptMatcher

```ts
type ScriptMatcher = string | RegExp | (req: GenerateContentRequest) => boolean;
```

Matcher: substring / regex against the last user turn text, or a predicate on the request.

***

<a id="scriptrespond"></a>

### ScriptRespond

```ts
type ScriptRespond = ScriptShorthand | RawEnvelope;
```

## Functions

<a id="encodesse"></a>

### encodeSse()

```ts
function encodeSse(envelopes: WireResponse[]): string;
```

Encode complete response envelopes as the captured SSE framing bytes:
every event is `data: <complete JSON>`, events separated by CRLF CRLF
(`ai-generate-stream-framing`: allEventsDataPrefixed, separatorIsCrlfCrlf).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `envelopes` | `WireResponse`[] |

#### Returns

`string`

***

<a id="script"></a>

### script()

```ts
function script(ai: AI, entries: ScriptingEntry[]): void;
```

Append entries to the scripted engine behind a sandbox AI handle. Entries
are consumed at most once, first unconsumed match wins, matcher-less
entries are unconditional FIFO (broker semantics).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `ai` | `AI` |
| `entries` | [`ScriptingEntry`](#scriptingentry)[] |

#### Returns

`void`
