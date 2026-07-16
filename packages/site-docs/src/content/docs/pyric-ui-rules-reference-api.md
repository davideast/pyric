---
title: "API reference: @pyric/ui/rules"
navLabel: "@pyric/ui/rules"
group: "API reference"
section: "@pyric/ui"
order: 24045
description: "Published declarations for @pyric/ui/rules."
kind: "api"
apiPackage: "@pyric/ui"
apiImportPath: "@pyric/ui/rules"
apiSubpath: "rules"
apiSymbolCount: 22
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Interfaces

<a id="denial"></a>

### Denial

One denied Firestore request, enriched with the simulator trace.

The live denial *event* carries only `debugMessages`; the rich trace
(`evaluation` / `pathResolution`) is produced by re-running the
simulator (tracing always on) against the captured request. Build one
with `useDenialTrace(request, rulesSource)` then spread the captured
request fields alongside.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="at"></a> `at` | `number` | Capture time (epoch ms). |
| <a id="auth"></a> `auth` | \{ `token`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} | `request.auth` — `null` for an unauthenticated request. |
| `auth.token` | `Record`\<`string`, `unknown`\> | - |
| `auth.uid` | `string` | - |
| <a id="decision"></a> `decision` | `"DENY"` | - |
| <a id="evaluation"></a> `evaluation` | `RuleEvaluation`[] | Per allow-rule evaluation, in source order. Each entry carries the `line`, `verdict`, `conditionText`, and `expressionTrace`. |
| <a id="lens"></a> `lens?` | [`DenialLens`](#deniallens-1) | Identity lens the request was issued under. |
| <a id="method"></a> `method` | `FirestoreMethod` | - |
| <a id="path"></a> `path` | `string` | Resource path, e.g. `notes/3agHoZHZ`. |
| <a id="pathresolution"></a> `pathResolution?` | `PathResolutionTrace` | Path-resolution attempts — present for no-match (default-deny) denials, where no `allow` rule was evaluated because no `match` block covered the path. |
| <a id="requestdata"></a> `requestData?` | `Record`\<`string`, `unknown`\> | `request.resource.data` — present for writes. |
| <a id="resourcedata"></a> `resourceData?` | `Record`\<`string`, `unknown`\> | `resource.data` — the existing document, `null` when absent. |
| <a id="rulessource"></a> `rulesSource` | `string` | `firestore.rules` source the request was evaluated against. |

***

<a id="denialinspectorprops"></a>

### DenialInspectorProps

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="classname"></a> `className?` | `string` | - |
| <a id="cluster"></a> `cluster?` | [`Denial`](#denial)[] | Sibling denials produced by the same rule. |
| <a id="denial-1"></a> `denial` | [`Denial`](#denial) | - |

#### Methods

<a id="onrerunas"></a>

##### onRerunAs()?

```ts
optional onRerunAs(uid: string): void;
```

Re-run the request under `{ mode: 'as', uid }`.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `uid` | `string` |

###### Returns

`void`

<a id="onselectcluster"></a>

##### onSelectCluster()?

```ts
optional onSelectCluster(d: Denial): void;
```

A cluster sibling was selected.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `d` | [`Denial`](#denial) |

###### Returns

`void`

<a id="ontesteditedrule"></a>

##### onTestEditedRule()?

```ts
optional onTestEditedRule(): void;
```

Re-run against an edited ruleset (a branch).

###### Returns

`void`

***

<a id="denialrequest"></a>

### DenialRequest

The captured request a host re-runs through the simulator to produce a
`Denial`. A subset of the simulator's `TestCase` — no expectation /
description (those are test-runner concerns); the host already knows
the request was denied.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="auth-1"></a> `auth?` | \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} | `request.auth` — `null`/omitted for unauthenticated. |
| `auth.token?` | `Record`\<`string`, `unknown`\> | - |
| `auth.uid` | `string` | - |
| <a id="method-1"></a> `method` | `FirestoreMethod` | - |
| <a id="path-1"></a> `path` | `string` | Resource path, e.g. `notes/3agHoZHZ`. |
| <a id="requestdata-1"></a> `requestData?` | `Record`\<`string`, `unknown`\> | `request.resource.data` — for writes. |
| <a id="requesttime"></a> `requestTime?` | `string` | Override `request.time` (ISO-8601). Defaults to wallclock. |
| <a id="resourcedata-1"></a> `resourceData?` | `Record`\<`string`, `unknown`\> | `resource.data` — the existing document. |

***

<a id="denialtrace"></a>

### DenialTrace

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="error"></a> `error?` | `string` | Populated when `ok` is false (e.g. the rules source failed to parse). |
| <a id="evaluation-1"></a> `evaluation` | `RuleEvaluation`[] | Per allow-rule evaluation, in source order. Empty for no-match denials. |
| <a id="ok"></a> `ok` | `boolean` | True when the simulator could parse + evaluate. False on a parse error. |
| <a id="pathresolution-1"></a> `pathResolution?` | `PathResolutionTrace` | Which `match` blocks the resolver tried — present for no-match denials. |

***

<a id="ruleline"></a>

### RuleLine

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="note"></a> `note?` | `string` | A short note for skipped lines, e.g. "not checked, this is an update". |
| <a id="number"></a> `number` | `number` | - |
| <a id="text"></a> `text` | `string` | - |
| <a id="verdict"></a> `verdict?` | [`LineVerdict`](#lineverdict) | - |

***

<a id="scopevar"></a>

### ScopeVar

The set of scope variable roots whose deciding values appear in the
trace — `request.auth`, `request.resource.data`, `resource.data`.
Used to underline the values the rule actually read.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="hits"></a> `hits` | `string`[] | Leaf keys whose values the rule read (for the `hit` underline). |
| <a id="name"></a> `name` | `string` | The dotted path, e.g. `request.auth`. |
| <a id="tag"></a> `tag` | `string` | A short human tag, e.g. "who made the request". |
| <a id="value"></a> `value` | `unknown` | The value to render. |

## Type Aliases

<a id="deniallens-1"></a>

### DenialLens

```ts
type DenialLens =
  | "admin"
  | {
  as: string;
}
  | "app-session";
```

The lens a request was issued under, mirroring the Studio's identity
model:
  - `'admin'`        — the admin handle (bypasses rules in production,
                       shown here for provenance only)
  - `{ as: uid }`    — acting as a specific signed-in user
  - `'app-session'`  — the ambient app session (whoever is signed in
                       in the running preview)

***

<a id="lineverdict"></a>

### LineVerdict

```ts
type LineVerdict = "deny" | "allow" | "skip";
```

Per-line verdict for the rule-source view. `deny` is the deciding
allow line; `skip` is an allow line whose operations don't include
the request method ("not checked"); `allow` is any other allow line.
Non-allow lines (match/braces/comments) get no verdict.

***

<a id="ruleevaluation"></a>

### RuleEvaluation

```ts
type RuleEvaluation = any;
```

## Functions

<a id="decidingevaluation"></a>

### decidingEvaluation()

```ts
function decidingEvaluation(evaluation: RuleEvaluation[]): any;
```

The allow rule that decided the denial: the last rule actually
evaluated (DENY/ERROR). Under OR semantics the simulator stops at the
first ALLOW; on a denial no rule allowed, so the deciding rule is the
last evaluated one — the closest miss the user should reason about.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `evaluation` | `RuleEvaluation`[] |

#### Returns

`any`

***

<a id="denialinspector"></a>

### DenialInspector()

```ts
function DenialInspector(__namedParameters: DenialInspectorProps): Element;
```

Headless inspector for a single denied Firestore request. Renders, per
the `denial-inspector-spec`:
  - the plain-language reason (`data-pyric-denial-reason`)
  - the rule source, line-marked (`data-pyric-rule-source`, per-line
    `data-pyric-line-verdict="deny|allow|skip"`)
  - the expression step-through (`data-pyric-trace` + per-node hooks)
  - data in scope (`data-pyric-scope`, `-scope-var`, `-scope-hit`)
  - the re-run / verify loop (`data-pyric-rerun`)
  - the cluster of sibling denials (`data-pyric-denial-cluster`)
  - path resolution for no-match denials (`data-pyric-path-resolution`)

Zero styling — every visual decision is a consumer's via the
`data-pyric-*` hooks. `mocks/c-debug.html` is the CSS spec.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `__namedParameters` | [`DenialInspectorProps`](#denialinspectorprops) |

#### Returns

`Element`

***

<a id="denialreason"></a>

### denialReason()

```ts
function denialReason(
   evaluation: RuleEvaluation[],
   method: FirestoreMethod,
   path: string): string;
```

A plain-language reason for the denial, derived from the deciding
`RuleEvaluation`. Falls back to a no-match explanation when no allow
rule was evaluated.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `evaluation` | `RuleEvaluation`[] |
| `method` | `FirestoreMethod` |
| `path` | `string` |

#### Returns

`string`

***

<a id="formatvalue"></a>

### formatValue()

```ts
function formatValue(value: unknown): string;
```

Render a trace value the way the mock shows it: JSON-ish, quoted
 strings, `false`/`true`/`null` bare.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `value` | `unknown` |

#### Returns

`string`

***

<a id="markrulelines"></a>

### markRuleLines()

```ts
function markRuleLines(
   rulesSource: string,
   evaluation: RuleEvaluation[],
   method: FirestoreMethod): RuleLine[];
```

Split the rules source into numbered lines and mark each `allow` line
with a verdict per the spec:
  - the deciding rule's line  → `deny`
  - an allow line whose operations don't include the method → `skip`
  - any other allow line      → `allow`

Verdicts are matched to source lines via `RuleEvaluation.line` (1-indexed
`allow` keyword). Lines without a matching evaluation entry get no verdict.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `rulesSource` | `string` |
| `evaluation` | `RuleEvaluation`[] |
| `method` | `FirestoreMethod` |

#### Returns

[`RuleLine`](#ruleline)[]

***

<a id="methodoperations"></a>

### methodOperations()

```ts
function methodOperations(method: FirestoreMethod): string[];
```

Operations a request method satisfies — `update` matches `update` and
 `write`, etc. Mirrors the simulator's `methodToOperations`.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `method` | `FirestoreMethod` |

#### Returns

`string`[]

***

<a id="scopevars"></a>

### scopeVars()

```ts
function scopeVars(denial: Denial): ScopeVar[];
```

Build the "data in scope" rows for a denial: `request.auth`,
`request.resource.data`, and `resource.data` — each present only when
the denial carries that payload. `hits` marks the leaf keys the
deciding rule actually read.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `denial` | [`Denial`](#denial) |

#### Returns

[`ScopeVar`](#scopevar)[]

***

<a id="tracedepth"></a>

### traceDepth()

```ts
function traceDepth(entries: ExprTraceEntry[], index: number): number;
```

Depth of a trace node from its `parent` chain (0 for roots).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `entries` | `ExprTraceEntry`[] |
| `index` | `number` |

#### Returns

`number`

***

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

## References

<a id="exprtraceentry"></a>

### ExprTraceEntry

Renames and re-exports [RuleEvaluation](#ruleevaluation)

***

<a id="firestoremethod"></a>

### FirestoreMethod

Renames and re-exports [RuleEvaluation](#ruleevaluation)

***

<a id="pathresolutionentry"></a>

### PathResolutionEntry

Renames and re-exports [RuleEvaluation](#ruleevaluation)

***

<a id="pathresolutiontrace"></a>

### PathResolutionTrace

Renames and re-exports [RuleEvaluation](#ruleevaluation)
