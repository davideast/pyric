---
title: "API reference: @pyric/ui/rules/hooks"
navLabel: "@pyric/ui/rules/hooks"
group: "API reference"
section: "@pyric/ui"
order: 24044
description: "Published declarations for @pyric/ui/rules/hooks."
kind: "api"
apiPackage: "@pyric/ui"
apiImportPath: "@pyric/ui/rules/hooks"
apiSubpath: "rules/hooks"
apiSymbolCount: 3
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Interfaces

<a id="denialrequest"></a>

### DenialRequest

The captured request a host re-runs through the simulator to produce a
`Denial`. A subset of the simulator's `TestCase` — no expectation /
description (those are test-runner concerns); the host already knows
the request was denied.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="auth"></a> `auth?` | \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} | `request.auth` — `null`/omitted for unauthenticated. |
| `auth.token?` | `Record`\<`string`, `unknown`\> | - |
| `auth.uid` | `string` | - |
| <a id="method"></a> `method` | `FirestoreMethod` | - |
| <a id="path"></a> `path` | `string` | Resource path, e.g. `notes/3agHoZHZ`. |
| <a id="requestdata"></a> `requestData?` | `Record`\<`string`, `unknown`\> | `request.resource.data` — for writes. |
| <a id="requesttime"></a> `requestTime?` | `string` | Override `request.time` (ISO-8601). Defaults to wallclock. |
| <a id="resourcedata"></a> `resourceData?` | `Record`\<`string`, `unknown`\> | `resource.data` — the existing document. |

***

<a id="denialtrace"></a>

### DenialTrace

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="error"></a> `error?` | `string` | Populated when `ok` is false (e.g. the rules source failed to parse). |
| <a id="evaluation"></a> `evaluation` | `RuleEvaluation`[] | Per allow-rule evaluation, in source order. Empty for no-match denials. |
| <a id="ok"></a> `ok` | `boolean` | True when the simulator could parse + evaluate. False on a parse error. |
| <a id="pathresolution"></a> `pathResolution?` | `PathResolutionTrace` | Which `match` blocks the resolver tried — present for no-match denials. |

## Functions

<a id="usedenialtrace"></a>

### useDenialTrace()

```ts
function useDenialTrace(request: DenialRequest, rulesSource: string): DenialTrace;
```

Re-run a captured (denied) Firestore request through the local rules
simulator — tracing is always on there — and return the structured
trace a `DenialInspector` renders.

Memoized on `(request, rulesSource)`; the simulator is pure and
in-process, so this is cheap to call on every render. A host produces
a `Denial` by spreading the request fields alongside the result:

```ts
const { evaluation, pathResolution } = useDenialTrace(req, rules);
const denial: Denial = { ...req, decision: 'DENY', rulesSource: rules,
                         at, evaluation, pathResolution };
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `request` | [`DenialRequest`](#denialrequest) |
| `rulesSource` | `string` |

#### Returns

[`DenialTrace`](#denialtrace)
