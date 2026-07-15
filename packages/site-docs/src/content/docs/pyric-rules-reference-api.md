---
title: "API reference: pyric/rules"
navLabel: "pyric/rules"
group: "API reference"
section: "pyric"
order: 24028
description: "Published declarations for pyric/rules."
kind: "api"
apiPackage: "pyric"
apiImportPath: "pyric/rules"
apiSubpath: "rules"
apiSymbolCount: 94
apiEvidenceSlug: "pyric-rules-compat"
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Classes

<a id="rulesassertionerror"></a>

### RulesAssertionError

Thrown by `assertCase` / a runner case's `run()` when the simulated
decision did not match the case's expectation. The message is the
rendered trace from `explainCase`, so a test runner surfaces the "why"
without extra wiring.

#### Extends

- `Error`

#### Constructors

<a id="constructor"></a>

##### Constructor

```ts
new RulesAssertionError(message: string): RulesAssertionError;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `message` | `string` |

###### Returns

[`RulesAssertionError`](#rulesassertionerror)

###### Overrides

```ts
Error.constructor
```

***

<a id="rulescompileerror"></a>

### RulesCompileError

Thrown by `firestoreRules(source)` / `rtdbRules(...)` when the source
cannot compile. Carries the compile-blocking issues on `.issues` so a
caller can surface them without re-parsing.

#### Extends

- `Error`

#### Constructors

<a id="constructor-1"></a>

##### Constructor

```ts
new RulesCompileError(message: string, issues: RuleIssue[]): RulesCompileError;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `message` | `string` |
| `issues` | [`RuleIssue`](#ruleissue)[] |

###### Returns

[`RulesCompileError`](#rulescompileerror)

###### Overrides

```ts
Error.constructor
```

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="issues"></a> `issues` | `readonly` | [`RuleIssue`](#ruleissue)[] |

***

<a id="rulesunsupportederror"></a>

### RulesUnsupportedError

Thrown by `assertCase` / a runner case's `run()` when the simulator
abstained — it hit a feature it does not implement, so neither a pass nor
a genuine failure can be asserted. Distinct from
[RulesAssertionError](#rulesassertionerror) so a runner can choose to skip rather than
fail on a known simulator gap.

#### Extends

- `Error`

#### Constructors

<a id="constructor-2"></a>

##### Constructor

```ts
new RulesUnsupportedError(message: string): RulesUnsupportedError;
```

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `message` | `string` |

###### Returns

[`RulesUnsupportedError`](#rulesunsupportederror)

###### Overrides

```ts
Error.constructor
```

## Interfaces

<a id="caseresult"></a>

### CaseResult

The outcome of running one Firestore case through `simulate`. Never a
 thrown error — a denied or abstained case is data, not an exception.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="case"></a> `case` | [`FirestoreCase`](#firestorecase) | The case that produced this result. |
| <a id="decision"></a> `decision` | `"ALLOW"` \| `"DENY"` \| `"UNSUPPORTED"` | The engine's absolute verdict, independent of expectation. |
| <a id="description"></a> `description` | `string` | - |
| <a id="expectation"></a> `expectation` | `"ALLOW"` \| `"DENY"` | - |
| <a id="notes"></a> `notes` | `string`[] | Top-level diagnostic strings. |
| <a id="passed"></a> `passed` | `boolean` | `true` when `decision` matched `expectation`. |
| <a id="pathresolution"></a> `pathResolution?` | [`PathResolutionTrace`](#pathresolutiontrace) | Which match blocks the resolver considered and where each fell apart. |
| <a id="trace"></a> `trace` | [`RuleEvaluation`](#ruleevaluation)[] | Per-rule evaluation entries in source order. |
| <a id="unsupported"></a> `unsupported` | `boolean` | `true` when the simulator abstained on a feature it does not implement — neither a pass nor a genuine failure. |

***

<a id="evaluatedruleinfo"></a>

### EvaluatedRuleInfo

The DECIDING rule's source position + sub-expression trace, projected from a
TestResult — for BOTH verdicts: the `allow` rule that granted an
ALLOW, or the rule responsible for a DENY. Additive companion to
renderLegacyDebugMessages: that flattens the per-rule trace to
strings (dropping `line` and `expressionTrace`); this preserves the
structured detail a UI needs to point at the exact source line and step
through the evaluation ("show the work"). Position/trace fields are optional
so a partial trace projects honestly.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="expression"></a> `expression?` | `string` | Pretty-printed condition text of the deciding rule. |
| <a id="expressiontrace"></a> `expressionTrace?` | [`ExprTraceEntry`](#exprtraceentry)[] | Per-sub-expression evaluation trace of the deciding rule. |
| <a id="line"></a> `line?` | `number` | 1-indexed source line of the deciding `allow` rule. |
| <a id="verdict"></a> `verdict` | `"allow"` \| `"deny"` | The verdict the deciding rule produced for the op. |

***

<a id="explanation"></a>

### Explanation

The structured account of why one Firestore case resolved as it did.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="deciding"></a> `deciding?` | [`EvaluatedRuleInfo`](#evaluatedruleinfo) | The deciding `allow` rule (line, condition text, sub-expression trace), when one was evaluated. Absent on default-deny / abstain. |
| <a id="decision-1"></a> `decision` | `"ALLOW"` \| `"DENY"` \| `"UNSUPPORTED"` | - |
| <a id="expectation-1"></a> `expectation` | `"ALLOW"` \| `"DENY"` | - |
| <a id="notes-1"></a> `notes` | `string`[] | - |
| <a id="passed-1"></a> `passed` | `boolean` | - |
| <a id="pathresolution-1"></a> `pathResolution?` | [`PathResolutionTrace`](#pathresolutiontrace) | - |
| <a id="trace-1"></a> `trace` | [`RuleEvaluation`](#ruleevaluation)[] | - |
| <a id="unsupported-1"></a> `unsupported` | `boolean` | - |

***

<a id="exprtraceentry"></a>

### ExprTraceEntry

One entry in the per-rule expression trace recorded by `TraceRecorder`.

Trace entries are emitted in evaluation order. The tree shape is
reconstructable via `parent`: root entries have `parent: null`, and
each child entry's `parent` is the array index of its evaluating
ancestor. This is denser than nested objects for transport (a tool
call returns a single flat array) and easier for the agent to scan
top-to-bottom.

`value` carries the evaluation result. For nodes that threw, see
`error`; for short-circuit skips, `skipped: true` is set instead.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="error"></a> `error?` | `string` | Error message when the expression threw. The wrapper still re-throws; this captures the diagnostic for the caller. |
| <a id="inlinedfrom"></a> `inlinedFrom?` | \{ `name`: `string`; \} | Set on entries recorded *inside* a user-defined function's body (after parameter binding). Carries the enclosing function's name so the agent can filter the trace by frame — `entries.filter(e => e.inlinedFrom?.name === 'isOwner')` — without walking the parent chain to find the surrounding `functionCall`. Parameter expressions are *not* tagged: they evaluate in the caller's scope, before the frame is entered. The `functionCall` entry itself is recorded in the caller's frame too, so a top-level `isOwner()` shows `inlinedFrom: undefined` on the `functionCall`, but `'isOwner'` on its body children. |
| `inlinedFrom.name` | `string` | - |
| <a id="kind"></a> `kind` | \| `"literal"` \| `"identifier"` \| `"memberAccess"` \| `"methodCall"` \| `"bracketAccess"` \| `"sliceAccess"` \| `"binaryOp"` \| `"unaryOp"` \| `"ternary"` \| `"inExpr"` \| `"isExpr"` \| `"listLiteral"` \| `"mapLiteral"` \| `"pathLiteral"` \| `"functionCall"` | AST node type — useful for filtering by structural kind. |
| <a id="letbinding"></a> `letBinding?` | \{ `name`: `string`; \} | Set on entries that record a `let` binding evaluation inside a user-defined function. `value` holds the bound value. |
| `letBinding.name` | `string` | - |
| <a id="parent"></a> `parent` | `number` | Index of the parent entry in the trace array; null at the root. |
| <a id="skipped"></a> `skipped?` | `boolean` | True for an `&&` / `||` operand that was *not* evaluated due to short-circuit. The recorder emits a placeholder entry so the trace shape mirrors the surface AST. |
| <a id="source"></a> `source` | `string` | Pretty-printed source of the expression (via `assembleExpression`). |
| <a id="value"></a> `value?` | `unknown` | Evaluation result. Undefined when `skipped` or `error` is set. |

***

<a id="firestorecase"></a>

### FirestoreCase

One Firestore rules case: a single request plus the outcome it should
produce. Structurally identical to the engine's `TestCase` — re-exported
here under the public name so callers never reach into the engine seam.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="auth"></a> `auth?` | \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} | Auth context; `null`/omitted for unauthenticated. |
| `auth.token?` | `Record`\<`string`, `unknown`\> | - |
| `auth.uid` | `string` | - |
| <a id="data"></a> `data?` | `Record`\<`string`, `unknown`\> | `request.resource.data` for write operations. |
| <a id="description-1"></a> `description` | `string` | Human-readable description of what this case verifies. |
| <a id="expectation-2"></a> `expectation` | `"ALLOW"` \| `"DENY"` | Expected outcome. |
| <a id="functionmocks"></a> `functionMocks?` | \{ `function`: `"get"` \| `"exists"`; `path`: `string`; `result`: `boolean` \| `Record`\<`string`, `unknown`\>; \}[] | Mock `get()` / `exists()` calls the rules make. |
| <a id="method"></a> `method` | `"get"` \| `"list"` \| `"create"` \| `"update"` \| `"delete"` | Firestore method under test. |
| <a id="path"></a> `path` | `string` | Document path, e.g. `"users/alice"`. |
| <a id="query"></a> `query?` | \{ `limit?`: `number`; `offset?`: `number`; `orderBy?`: `string`; \} | `request.query` payload (list ops only): limit/offset/orderBy. |
| `query.limit?` | `number` | - |
| `query.offset?` | `number` | - |
| `query.orderBy?` | `string` | - |
| <a id="requesttime"></a> `requestTime?` | `string` | Override for `request.time` (ISO-8601). Defaults to wallclock. |
| <a id="resource"></a> `resource?` | `Record`\<`string`, `unknown`\> | Existing document data (`resource.data`). |
| <a id="writemode"></a> `writeMode?` | \| \{ `kind`: `"create"`; \} \| \{ `kind`: `"set"`; `merge`: `boolean`; \} \| \{ `kind`: `"update"`; \} \| \{ `kind`: `"delete"`; \} | Explicit write semantics — controls update-merge and getAfter() projection. Omit to treat `data` as the full after-state. |

***

<a id="firestoreruleset"></a>

### FirestoreRuleset

#### Methods

<a id="explain"></a>

##### explain()

```ts
explain(oneCase: FirestoreCase): Explanation;
```

The structured account of why one case resolved as it did.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `oneCase` | [`FirestoreCase`](#firestorecase) |

###### Returns

[`Explanation`](#explanation)

<a id="lint"></a>

##### lint()

```ts
lint(): RuleIssue[];
```

Structural, security, and budget findings on the compiled ruleset.
 No parse errors — the source already compiled.

###### Returns

[`RuleIssue`](#ruleissue)[]

<a id="simulate"></a>

##### simulate()

```ts
simulate(cases: FirestoreCase[]): SimulationSummary;
```

Run every case. Never throws on a rule outcome: a denied or abstained
 case is reported in the returned summary.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `cases` | [`FirestoreCase`](#firestorecase)[] |

###### Returns

[`SimulationSummary`](#simulationsummary)

<a id="tojson"></a>

##### toJSON()

```ts
toJSON(): FirestoreRules;
```

The parsed ruleset as plain data (the AST).

###### Returns

`FirestoreRules`

***

<a id="pathdef"></a>

### PathDef

Definition of rules for a single database path.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="children"></a> `children?` | `Record`\<`string`, [`PathDef`](#pathdef)\> |
| <a id="fieldconstraints"></a> `fieldConstraints?` | `Record`\<`string`, [`Expr`](#expr)[]\> |
| <a id="indexon"></a> `indexOn?` | `string`[] |
| <a id="read"></a> `read?` | `string` |
| <a id="schema"></a> `schema?` | `ZodObject`\<`any`\> |
| <a id="validate"></a> `validate?` | `string` |
| <a id="write"></a> `write?` | `string` |

***

<a id="pathresolutionentry"></a>

### PathResolutionEntry

One `match` block the simulator considered while resolving the
request path. Together, `PathResolutionTrace.attempts` forms a
complete picture of "what did the resolver try, and where did
each attempt fall apart?" — useful for the agent when a request
lands in the default-deny path because no block matched.

Recorded only by the local simulator; the production Test API
client doesn't expose path-resolution internals.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="bindings"></a> `bindings` | `Record`\<`string`, `string`\> | Wildcard / recursive bindings the block produced (even when the overall match failed — the partial bindings are still diagnostic). |
| <a id="blockpath"></a> `blockPath` | `string` | Raw match path as written in the source, e.g. `'/users/{uid}/messages/{mId}'`. |
| <a id="line-1"></a> `line?` | `number` | Source line of the `match` keyword. Absent when the parser didn't populate `loc` (programmatically-constructed blocks). |
| <a id="matched"></a> `matched` | `boolean` | True for a block that fully resolved (no remaining request segments AND every nested match either completed or wasn't needed). MULTIPLE entries may be `matched: true` in one trace: a request path can match several overlapping `match` blocks (e.g. `/docs/{doc}` and a sibling `/{document=**}`), and every matching block's allows OR-combine. Container blocks whose children completed the resolution are also flagged matched. |
| <a id="matchedsegments"></a> `matchedSegments` | `number` | How many of the block's path segments matched against the request path before the resolver gave up or completed. |
| <a id="reason"></a> `reason?` | `"literal-mismatch"` \| `"request-shorter"` \| `"no-matching-child"` | Why the resolver moved on. Absent when `matched: true`. - `'literal-mismatch'` — a literal segment in the block didn't match the corresponding request segment. - `'request-shorter'` — block path had more segments than the request supplied (e.g. block is `/a/{b}/c`, request is `/a/x`). - `'no-matching-child'` — block matched its own segments but remaining request segments weren't covered by any child block. |
| <a id="totalsegments"></a> `totalSegments` | `number` | Total segments in the block's path pattern. |

***

<a id="pathresolutiontrace"></a>

### PathResolutionTrace

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="attempts"></a> `attempts` | [`PathResolutionEntry`](#pathresolutionentry)[] | One entry per match block the resolver considered, in the order it tried them. `attempts[i].matched: true` marks a block that fully resolved; one or more per trace, since overlapping blocks all match and OR-combine. |
| <a id="requestpath"></a> `requestPath` | `string` | The request path that was resolved, verbatim from `TestCase.path`. |

***

<a id="rtdbcase"></a>

### RtdbCase

One Realtime Database rules case. `expectation` is required so a `simulate`
run can partition cases into passed/failed the same way Firestore does —
the RTDB simulator otherwise returns only a raw allow/deny with no notion
of an expectation.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="auth-1"></a> `auth?` | \| `string` \| \{ `token?`: `Record`\<`string`, `unknown`\>; `uid`: `string`; \} | Auth context; a bare uid string, a full identity, or `null`. |
| <a id="data-1"></a> `data?` | `Record`\<`string`, `unknown`\> | Existing tree data the rule reads (`data`). |
| <a id="description-2"></a> `description?` | `string` | Human-readable description of what this case verifies. |
| <a id="expectation-3"></a> `expectation` | `"ALLOW"` \| `"DENY"` | Expected outcome. |
| <a id="newdata"></a> `newData?` | `unknown` | Proposed write value (`newData`), for write/validate cases. |
| <a id="operation"></a> `operation` | `"validate"` \| `"read"` \| `"write"` | RTDB rule kind under test. |
| <a id="path-1"></a> `path` | `string` | Absolute, root-relative tree path, e.g. `"/users/alice"`. |

***

<a id="rtdbcaseresult"></a>

### RtdbCaseResult

The outcome of running one RTDB case through `simulate`.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="case-1"></a> `case` | [`RtdbCase`](#rtdbcase) | - |
| <a id="decision-2"></a> `decision` | `"ALLOW"` \| `"DENY"` \| `"UNSUPPORTED"` | - |
| <a id="description-3"></a> `description?` | `string` | - |
| <a id="expectation-4"></a> `expectation` | `"ALLOW"` \| `"DENY"` | - |
| <a id="matchedpath"></a> `matchedPath` | `string` | The tree path whose rule decided the request. |
| <a id="matchedrule"></a> `matchedRule` | `string` | Which rule kind (`.read` / `.write` / `.validate`) decided. |
| <a id="passed-2"></a> `passed` | `boolean` | - |
| <a id="reason-1"></a> `reason` | `string` | Engine-provided reason string. |
| <a id="unsupported-2"></a> `unsupported` | `boolean` | - |

***

<a id="rtdbexplanation"></a>

### RtdbExplanation

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="decision-3"></a> `decision` | `"ALLOW"` \| `"DENY"` \| `"UNSUPPORTED"` |
| <a id="expectation-5"></a> `expectation` | `"ALLOW"` \| `"DENY"` |
| <a id="matchedpath-1"></a> `matchedPath` | `string` |
| <a id="matchedrule-1"></a> `matchedRule` | `string` |
| <a id="passed-3"></a> `passed` | `boolean` |
| <a id="reason-2"></a> `reason` | `string` |
| <a id="unsupported-3"></a> `unsupported` | `boolean` |

***

<a id="rtdbrulescheckresult"></a>

### RtdbRulesCheckResult

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="errors"></a> `errors` | [`RtdbRulesFinding`](#rtdbrulesfinding)[] |
| <a id="ok"></a> `ok` | `boolean` |
| <a id="warnings"></a> `warnings` | [`RtdbRulesFinding`](#rtdbrulesfinding)[] |

***

<a id="rtdbrulesdefinition"></a>

### RtdbRulesDefinition

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="paths"></a> `paths` | \| `Record`\<`string`, [`PathDef`](#pathdef)\> \| (`ctx`: [`RulesetContext`](#rulesetcontext)) => `void` |

***

<a id="rtdbrulesdocument"></a>

### RtdbRulesDocument

The authored RTDB rules artifact `defineRtdbRules` returns.

Deliberately INERT on the public surface: it exposes no methods. It is a
value you author and hand to `rtdbRules()`, which is the one analysis
surface (`lint` / `simulate` / `explain` / `toJSON`). The brand is
type-level only; nothing exists at runtime.

#### Properties

| Property | Modifier | Type |
| :------ | :------ | :------ |
| <a id="rtdb_rules_document_brand"></a> `[RTDB_RULES_DOCUMENT_BRAND]?` | `readonly` | `never` |

***

<a id="rtdbruleset"></a>

### RtdbRuleset

#### Methods

<a id="explain-2"></a>

##### explain()

```ts
explain(oneCase: RtdbCase): RtdbExplanation;
```

The structured account of why one case resolved as it did.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `oneCase` | [`RtdbCase`](#rtdbcase) |

###### Returns

[`RtdbExplanation`](#rtdbexplanation)

<a id="lint-2"></a>

##### lint()

```ts
lint(): RuleIssue[];
```

Structural findings on the compiled ruleset (from `check()`).

###### Returns

[`RuleIssue`](#ruleissue)[]

<a id="simulate-2"></a>

##### simulate()

```ts
simulate(cases: RtdbCase[]): RtdbSimulationSummary;
```

Run every case. Never throws on a rule outcome.

###### Parameters

| Parameter | Type |
| :------ | :------ |
| `cases` | [`RtdbCase`](#rtdbcase)[] |

###### Returns

[`RtdbSimulationSummary`](#rtdbsimulationsummary)

<a id="tojson-2"></a>

##### toJSON()

```ts
toJSON(): RtdbRulesJson;
```

The compiled `rules.json`.

###### Returns

[`RtdbRulesJson`](#rtdbrulesjson)

***

<a id="rtdbrulesfinding"></a>

### RtdbRulesFinding

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="code"></a> `code` | `string` |
| <a id="message"></a> `message` | `string` |
| <a id="path-2"></a> `path` | `string` |
| <a id="rule"></a> `rule` | [`RtdbRulesFindingRule`](#rtdbrulesfindingrule-1) |

***

<a id="rtdbsimulationsummary"></a>

### RtdbSimulationSummary

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="cases"></a> `cases` | [`RtdbCaseResult`](#rtdbcaseresult)[] |
| <a id="failed"></a> `failed` | `number` |
| <a id="passed-4"></a> `passed` | `number` |
| <a id="unsupported-4"></a> `unsupported` | `number` |

***

<a id="ruleevaluation"></a>

### RuleEvaluation

Per-rule evaluation entry produced by the local simulator. Each entry
corresponds to one `allow` declaration the simulator evaluated, in
source order.

Populated only by `SimulateFirestoreRulesHandler` (which has the parsed
AST in hand); the production Test API client (`TestFirestoreRulesHandler`)
returns an empty `trace` and surfaces the wire text on `TestResult.notes`.

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="conditiontext"></a> `conditionText?` | `string` | Pretty-printed condition expression. Use this verbatim in agent-facing summaries — derived from the AST via `printExpression`, so it survives comment removal and whitespace re-flow in the source. |
| <a id="expressiontrace-1"></a> `expressionTrace?` | [`ExprTraceEntry`](#exprtraceentry)[] | Per-sub-expression evaluation trace for this rule's condition. Flat, in evaluation order; reconstruct the tree via the `parent` index on each entry. Populated by the local simulator when the caller enables tracing — currently always on for `SimulateFirestoreRulesHandler.simulate()` so agents can see *why* a rule's condition resolved as it did (which disjunct was true, which `let` binding the value flowed through, which method call threw). Absent on entries that came from the production Test API client (no AST visibility). |
| <a id="line-2"></a> `line?` | `number` | 1-indexed source line of the `allow` keyword. Populated when the rule's `loc` was set by the parser. |
| <a id="matchpath"></a> `matchPath?` | `string` | Source-rendered path of the `match` block this rule belongs to, e.g. `'/docs/{docId}'` or `'/{document=**}'`. Populated when the request path matches MORE THAN ONE overlapping `match` block: allows OR-combine across every matching block (production semantics — there is no first-match-wins), so a DENY trace can carry entries from several blocks. This field keeps them unambiguous — which block did this rule live in. Absent for the common single-block case. |
| <a id="message-1"></a> `message?` | `string` | Human-readable diagnostic — populated for `UNSUPPORTED` (which sim surface is missing) and `ERROR` (which runtime error caused the rule to abort). |
| <a id="operations"></a> `operations` | (`"get"` \| `"list"` \| `"create"` \| `"update"` \| `"delete"` \| `"read"` \| `"write"`)[] | Operations declared on the allow rule (`read`, `write`, `get`, ...). |
| <a id="ruleindex"></a> `ruleIndex` | `number` | Position of the `allow` declaration within its match block, 0-indexed in source order. |
| <a id="verdict-1"></a> `verdict` | `"ALLOW"` \| `"DENY"` \| `"UNSUPPORTED"` \| `"ERROR"` | Outcome for this single rule. The TestResult's overall `decision` is derived from the trace under OR semantics (any `'ALLOW'` ⇒ ALLOW, else any `'UNSUPPORTED'` ⇒ UNSUPPORTED, else DENY). |

***

<a id="ruleissue"></a>

### RuleIssue

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="code-1"></a> `code` | `string` | Stable machine code, e.g. `'PARSE_ERROR'`, `'SEC-4'`, `'GET_BUDGET'`. |
| <a id="fix"></a> `fix?` | `string` | Suggested remediation, verbatim, when the producing stage offers one. |
| <a id="line-3"></a> `line?` | `number` | 1-indexed source line, when known. |
| <a id="message-2"></a> `message` | `string` | Human-readable description. |
| <a id="origin"></a> `origin` | [`RuleIssueOrigin`](#ruleissueorigin-1) | - |
| <a id="path-3"></a> `path?` | `string` | Rules path the issue applies to, when known (e.g. `'/users/{uid}'`). |
| <a id="severity"></a> `severity` | [`RuleIssueSeverity`](#ruleissueseverity-1) | - |

***

<a id="rulesetcontext"></a>

### RulesetContext

Context passed to the callback overload of ruleset().

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="path-4"></a> `path` | (`path`: `string`, `def`: [`PathDef`](#pathdef)) => `void` |

***

<a id="schemarulesresult"></a>

### SchemaRulesResult

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="children-1"></a> `children` | `Record`\<`string`, \{ `children?`: `Record`\<`string`, \{ `validate`: [`Expr`](#expr); \}\>; `validate`: [`Expr`](#expr); \}\> |
| <a id="validate-1"></a> `validate` | `string` |

***

<a id="simulationsummary"></a>

### SimulationSummary

Aggregate of a `simulate(cases)` run. Counts partition the cases:
 `passed + failed + unsupported === cases.length`.

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="cases-1"></a> `cases` | [`CaseResult`](#caseresult)[] |
| <a id="failed-1"></a> `failed` | `number` |
| <a id="passed-5"></a> `passed` | `number` |
| <a id="unsupported-5"></a> `unsupported` | `number` |

## Type Aliases

<a id="expr"></a>

### Expr

```ts
type Expr = string;
```

Type alias for RTDB rule expression strings.

***

<a id="firestoremethod"></a>

### FirestoreMethod

```ts
type FirestoreMethod = typeof FIRESTORE_METHODS[number];
```

***

<a id="rtdbrulesfindingrule-1"></a>

### RtdbRulesFindingRule

```ts
type RtdbRulesFindingRule = ".read" | ".write" | ".validate" | "ruleset";
```

***

<a id="rtdbrulesjson"></a>

### RtdbRulesJson

```ts
type RtdbRulesJson = {
  rules: Record<string, unknown>;
};
```

#### Properties

| Property | Type |
| :------ | :------ |
| <a id="rules"></a> `rules` | `Record`\<`string`, `unknown`\> |

***

<a id="rtdbrulessimulationauth"></a>

### RtdbRulesSimulationAuth

```ts
type RtdbRulesSimulationAuth =
  | string
  | {
  token?: Record<string, unknown>;
  uid: string;
}
  | null;
```

***

<a id="rtdbrulessimulationinput"></a>

### RtdbRulesSimulationInput

```ts
type RtdbRulesSimulationInput = Omit<SimulationInput, "auth" | "mockData"> & {
  auth?: RtdbRulesSimulationAuth;
  data?: Record<string, unknown>;
  mockData?: Record<string, unknown>;
};
```

#### Type Declaration

##### auth?

```ts
optional auth: RtdbRulesSimulationAuth;
```

##### data?

```ts
optional data: Record<string, unknown>;
```

##### mockData?

```ts
optional mockData: Record<string, unknown>;
```

***

<a id="ruleissueorigin-1"></a>

### RuleIssueOrigin

```ts
type RuleIssueOrigin = "parse" | "validate" | "lint";
```

The stage that produced the issue.
  - `parse`    — the source did not parse; nothing downstream ran.
  - `validate` — a structural/security finding on a parsed ruleset.
  - `lint`     — a budget/quality/hallucination warning.

***

<a id="ruleissueseverity-1"></a>

### RuleIssueSeverity

```ts
type RuleIssueSeverity = "error" | "warning" | "info";
```

Ordered by decreasing urgency. `info` is advisory.

***

<a id="segment"></a>

### Segment

```ts
type Segment =
  | string
  | {
  $: string;
};
```

A path segment: string for literal, { $: name } for path variable.

## Variables

<a id="all"></a>

### all()

```ts
const all: (...exprs: Expr[]) => Expr;
```

All conditions must be true (AND).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| ...`exprs` | [`Expr`](#expr)[] |

#### Returns

[`Expr`](#expr)

***

<a id="allow"></a>

### allow()

```ts
const allow: () => Expr;
```

Always allow (true). Readable alias for always().

#### Returns

[`Expr`](#expr)

***

<a id="always"></a>

### always()

```ts
const always: () => Expr;
```

Always allow (true).

#### Returns

[`Expr`](#expr)

***

<a id="any"></a>

### any()

```ts
const any: (...exprs: Expr[]) => Expr;
```

At least one condition must be true (OR).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| ...`exprs` | [`Expr`](#expr)[] |

#### Returns

[`Expr`](#expr)

***

<a id="auth_uid"></a>

### AUTH\_UID

```ts
const AUTH_UID: Segment;
```

auth.uid as a comparison value (unquoted in expressions)

***

<a id="authenticated"></a>

### authenticated()

```ts
const authenticated: () => Expr;
```

#### Returns

[`Expr`](#expr)

***

<a id="dataexists"></a>

### dataExists()

```ts
const dataExists: (path?: string) => Expr;
```

Check if data exists at current node or a child path

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `path?` | `string` |

#### Returns

[`Expr`](#expr)

***

<a id="dataparentval"></a>

### dataParentVal()

```ts
const dataParentVal: (depth: number, field: string) => Expr;
```

Navigate up from data snapshot, then read a child field's value

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `depth` | `number` |
| `field` | `string` |

#### Returns

[`Expr`](#expr)

***

<a id="dataval"></a>

### dataVal()

```ts
const dataVal: (path?: string) => Expr;
```

Read data value at current node or a child path (pre-write state)

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `path?` | `string` |

#### Returns

[`Expr`](#expr)

***

<a id="deny"></a>

### deny()

```ts
const deny: () => Expr;
```

Always deny (false).

#### Returns

[`Expr`](#expr)

***

<a id="eq"></a>

### eq()

```ts
const eq: (left: Expr, right: CompareValue) => Expr;
```

Strict equality: left === right (right is a literal value or runtime ref)

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `left` | [`Expr`](#expr) |
| `right` | `CompareValue` |

#### Returns

[`Expr`](#expr)

***

<a id="expr-1"></a>

### expr()

```ts
const expr: (raw: string) => Expr;
```

Create an Expr from a raw expression string.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `raw` | `string` |

#### Returns

[`Expr`](#expr)

***

<a id="fieldenum"></a>

### fieldEnum()

```ts
const fieldEnum: (field: string, values: string[]) => Expr;
```

Field must be one of the allowed string values

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `field` | `string` |
| `values` | `string`[] |

#### Returns

[`Expr`](#expr)

***

<a id="fieldisboolean"></a>

### fieldIsBoolean()

```ts
const fieldIsBoolean: (field: string) => Expr;
```

Field must be a boolean

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `field` | `string` |

#### Returns

[`Expr`](#expr)

***

<a id="fieldisnumber"></a>

### fieldIsNumber()

```ts
const fieldIsNumber: (field: string) => Expr;
```

Field must be a number

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `field` | `string` |

#### Returns

[`Expr`](#expr)

***

<a id="fieldisstring"></a>

### fieldIsString()

```ts
const fieldIsString: (field: string) => Expr;
```

Field must be a string

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `field` | `string` |

#### Returns

[`Expr`](#expr)

***

<a id="fieldowneronly"></a>

### fieldOwnerOnly()

```ts
const fieldOwnerOnly: (field: string) => Expr;
```

Only the field owner (auth.uid === data.child(field).val()) can access

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `field` | `string` |

#### Returns

[`Expr`](#expr)

***

<a id="gt"></a>

### gt()

```ts
const gt: (left: Expr, right: number) => Expr;
```

Greater than: left > right

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `left` | [`Expr`](#expr) |
| `right` | `number` |

#### Returns

[`Expr`](#expr)

***

<a id="haschild"></a>

### hasChild()

```ts
const hasChild: (field: string) => Expr;
```

Incoming data must have a specific child field

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `field` | `string` |

#### Returns

[`Expr`](#expr)

***

<a id="haschildren"></a>

### hasChildren()

```ts
const hasChildren: () => Expr;
```

Incoming data must be an object with at least one child

#### Returns

[`Expr`](#expr)

***

<a id="hasrole"></a>

### hasRole()

```ts
const hasRole: (segments: Segment[], role: string) => Expr;
```

Cross-path role check via root lookup

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `segments` | [`Segment`](#segment)[] |
| `role` | `string` |

#### Returns

[`Expr`](#expr)

***

<a id="immutable"></a>

### immutable()

```ts
const immutable: (field: string) => Expr;
```

Field can be set on creation but never changed after

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `field` | `string` |

#### Returns

[`Expr`](#expr)

***

<a id="immutableself"></a>

### immutableSelf()

```ts
const immutableSelf: () => Expr;
```

This node's own value can be set on creation but never changed

#### Returns

[`Expr`](#expr)

***

<a id="ismember"></a>

### isMember()

```ts
const isMember: (listName: string, pathVarName: string) => Expr;
```

Cross-path membership check: root.child(list).child($var).child(auth.uid).exists()

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `listName` | `string` |
| `pathVarName` | `string` |

#### Returns

[`Expr`](#expr)

***

<a id="isnew"></a>

### isNew()

```ts
const isNew: () => Expr;
```

Data at this path doesn't exist yet (creation check)

#### Returns

[`Expr`](#expr)

***

<a id="lte"></a>

### lte()

```ts
const lte: (left: Expr, right: number) => Expr;
```

Less than or equal: left <= right

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `left` | [`Expr`](#expr) |
| `right` | `number` |

#### Returns

[`Expr`](#expr)

***

<a id="neq"></a>

### neq()

```ts
const neq: (left: Expr, right: CompareValue) => Expr;
```

Strict inequality: left !== right

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `left` | [`Expr`](#expr) |
| `right` | `CompareValue` |

#### Returns

[`Expr`](#expr)

***

<a id="newdataexists"></a>

### newDataExists()

```ts
const newDataExists: (path?: string) => Expr;
```

Check if incoming data exists at current node or a child path

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `path?` | `string` |

#### Returns

[`Expr`](#expr)

***

<a id="newdatais"></a>

### newDataIs()

```ts
const newDataIs: (type: "String" | "Number" | "Boolean") => Expr;
```

Check incoming data type at current node

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `type` | `"String"` \| `"Number"` \| `"Boolean"` |

#### Returns

[`Expr`](#expr)

***

<a id="newdataparentexists"></a>

### newDataParentExists()

```ts
const newDataParentExists: (depth: number, field: string) => Expr;
```

Navigate up from newData snapshot, then check if a child field exists

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `depth` | `number` |
| `field` | `string` |

#### Returns

[`Expr`](#expr)

***

<a id="newdataparentval"></a>

### newDataParentVal()

```ts
const newDataParentVal: (depth: number, field: string) => Expr;
```

Navigate up from newData snapshot, then read a child field's value

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `depth` | `number` |
| `field` | `string` |

#### Returns

[`Expr`](#expr)

***

<a id="newdataval"></a>

### newDataVal()

```ts
const newDataVal: (path?: string) => Expr;
```

Read incoming data value at current node or a child path (post-write state)

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `path?` | `string` |

#### Returns

[`Expr`](#expr)

***

<a id="not"></a>

### not()

```ts
const not: (e: Expr) => Expr;
```

Negate a condition.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `e` | [`Expr`](#expr) |

#### Returns

[`Expr`](#expr)

***

<a id="ownerornew"></a>

### ownerOrNew()

```ts
const ownerOrNew: (field: string) => Expr;
```

Anyone authenticated can create; only the field owner can edit

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `field` | `string` |

#### Returns

[`Expr`](#expr)

***

<a id="ownfield"></a>

### ownField()

```ts
const ownField: (field: string) => Expr;
```

Field-based ownership: auth.uid matches a value stored in a data field

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `field` | `string` |

#### Returns

[`Expr`](#expr)

***

<a id="ownpath"></a>

### ownPath()

```ts
const ownPath: (pathVar: string) => Expr;
```

Path-based ownership: auth.uid matches a URL path variable

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `pathVar` | `string` |

#### Returns

[`Expr`](#expr)

***

<a id="pathowneronly"></a>

### pathOwnerOnly()

```ts
const pathOwnerOnly: (pathVar: string) => Expr;
```

Only the path owner (auth.uid === $pathVar) can access

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `pathVar` | `string` |

#### Returns

[`Expr`](#expr)

***

<a id="required"></a>

### required()

```ts
const required: (...fields: string[]) => Expr;
```

All specified fields must be present in the incoming data

#### Parameters

| Parameter | Type |
| :------ | :------ |
| ...`fields` | `string`[] |

#### Returns

[`Expr`](#expr)

***

<a id="rootequals"></a>

### rootEquals()

```ts
const rootEquals: (segments: Segment[], value: string) => Expr;
```

Check if a path's value equals a specific string (via root)

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `segments` | [`Segment`](#segment)[] |
| `value` | `string` |

#### Returns

[`Expr`](#expr)

***

<a id="rootexists"></a>

### rootExists()

```ts
const rootExists: (segments: Segment[]) => Expr;
```

Check if a path exists in the database (via root)

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `segments` | [`Segment`](#segment)[] |

#### Returns

[`Expr`](#expr)

***

<a id="transition"></a>

### transition()

```ts
const transition: (field: string, allowed: [string, string][]) => Expr;
```

State machine: only allowed transitions on a field

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `field` | `string` |
| `allowed` | \[`string`, `string`\][] |

#### Returns

[`Expr`](#expr)

## Functions

<a id="assertcase"></a>

### assertCase()

#### Call Signature

```ts
function assertCase(result: CaseResult | RtdbCaseResult): void;
```

Throw when a case result did not pass. A simulator abstention throws
[RulesUnsupportedError](#rulesunsupportederror); a genuine expectation mismatch throws
[RulesAssertionError](#rulesassertionerror). Both carry the [explainCase](#explaincase) trace as
their message. Returns `void` on a passing result.

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `result` | [`CaseResult`](#caseresult) \| [`RtdbCaseResult`](#rtdbcaseresult) |

##### Returns

`void`

#### Call Signature

```ts
function assertCase(ruleset: FirestoreRuleset, oneCase: FirestoreCase): void;
```

Simulate one case against a ruleset and throw on a miss — the runner
form: `for (const c of cases) test(c.description, () => assertCase(ruleset, c))`.

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `ruleset` | [`FirestoreRuleset`](#firestoreruleset) |
| `oneCase` | [`FirestoreCase`](#firestorecase) |

##### Returns

`void`

#### Call Signature

```ts
function assertCase(ruleset: RtdbRuleset, oneCase: RtdbCase): void;
```

Throw when a case result did not pass. A simulator abstention throws
[RulesUnsupportedError](#rulesunsupportederror); a genuine expectation mismatch throws
[RulesAssertionError](#rulesassertionerror). Both carry the [explainCase](#explaincase) trace as
their message. Returns `void` on a passing result.

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `ruleset` | [`RtdbRuleset`](#rtdbruleset) |
| `oneCase` | [`RtdbCase`](#rtdbcase) |

##### Returns

`void`

#### Call Signature

```ts
function assertCase(source: string, oneCase: FirestoreCase): void;
```

Convenience: compile Firestore source and assert one case against it.

##### Parameters

| Parameter | Type |
| :------ | :------ |
| `source` | `string` |
| `oneCase` | [`FirestoreCase`](#firestorecase) |

##### Returns

`void`

***

<a id="bytes"></a>

### bytes()

```ts
function bytes(input: string | Uint8Array<ArrayBufferLike>): Bytes;
```

A `bytes` value.
  - string     → UTF-8 encoded
  - Uint8Array → used verbatim

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `input` | `string` \| `Uint8Array`\<`ArrayBufferLike`\> |

#### Returns

`Bytes`

***

<a id="definertdbrules"></a>

### defineRtdbRules()

```ts
function defineRtdbRules(definition: RtdbRulesDefinition): RtdbRulesDocument;
```

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `definition` | [`RtdbRulesDefinition`](#rtdbrulesdefinition) |

#### Returns

[`RtdbRulesDocument`](#rtdbrulesdocument)

***

<a id="duration"></a>

### duration()

```ts
function duration(value: number, unit?: string): Duration;
```

A `duration` value. `unit` is one of the Firestore duration units
(`'w' | 'd' | 'h' | 'm' | 's' | 'ms' | 'ns'`); defaults to seconds.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `value` | `number` |
| `unit?` | `string` |

#### Returns

`Duration`

***

<a id="explaincase"></a>

### explainCase()

```ts
function explainCase(result: CaseResult | RtdbCaseResult): string;
```

Render a case result as a human-readable trace. The single sanctioned
trace renderer — used as the message of the error `assertCase` throws, and
available directly for logging a result without asserting.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `result` | [`CaseResult`](#caseresult) \| [`RtdbCaseResult`](#rtdbcaseresult) |

#### Returns

`string`

***

<a id="firestorerules"></a>

### firestoreRules()

```ts
function firestoreRules(source: string): FirestoreRuleset;
```

Compile Firestore rules source into a deep, safe-by-default handle.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `source` | `string` |

#### Returns

[`FirestoreRuleset`](#firestoreruleset)

#### Throws

when the source does not parse. The thrown
  error carries the compile-blocking issues on `.issues`.

***

<a id="flip"></a>

### flip()

```ts
function flip(marks: string[]): string;
```

Turn flip: validates a turn field alternates between marks.
First mark is the initial value on creation.
Supports 2+ players with circular rotation.

#### Parameters

| Parameter | Type | Description |
| :------ | :------ | :------ |
| `marks` | `string`[] | ordered list of marks (e.g., ["X", "O"]) |

#### Returns

`string`

***

<a id="latlng"></a>

### latlng()

```ts
function latlng(lat: number, lng: number): LatLng;
```

A `latlng` geographic point.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `lat` | `number` |
| `lng` | `number` |

#### Returns

`LatLng`

***

<a id="lint-4"></a>

### lint()

```ts
function lint(source: string): RuleIssue[];
```

Lint Firestore rules source. Accepts anything — including empty or
syntactically broken source — and always returns an issue list.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `source` | `string` |

#### Returns

[`RuleIssue`](#ruleissue)[]

***

<a id="reference"></a>

### reference()

```ts
function reference(path: string): Reference;
```

A `reference` to a document, by its path (e.g. `"users/alice"`).

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `path` | `string` |

#### Returns

`Reference`

***

<a id="rtdbrules"></a>

### rtdbRules()

```ts
function rtdbRules(input: RtdbRulesInput): RtdbRuleset;
```

Build a deep handle on a Realtime Database ruleset from a definition, a
compiled document, or compiled `{ rules }` JSON.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `input` | `RtdbRulesInput` |

#### Returns

[`RtdbRuleset`](#rtdbruleset)

***

<a id="ruleset"></a>

### ruleset()

```ts
function ruleset(input:
  | Record<string, PathDef>
  | (ctx: RulesetContext) => void): RtdbNode;
```

Compile a declarative rules definition into an environment-independent tree.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `input` | \| `Record`\<`string`, [`PathDef`](#pathdef)\> \| (`ctx`: [`RulesetContext`](#rulesetcontext)) => `void` |

#### Returns

`RtdbNode`

***

<a id="schemarules"></a>

### schemaRules()

```ts
function schemaRules(schema: ZodObject<any>, fieldConstraints?: Record<string, Expr[]>): SchemaRulesResult;
```

Generate RTDB validate rules from a Zod object schema.
Optional fieldConstraints are AND-composed with the schema type check.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `schema` | `ZodObject`\<`any`\> |
| `fieldConstraints?` | `Record`\<`string`, [`Expr`](#expr)[]\> |

#### Returns

[`SchemaRulesResult`](#schemarulesresult)

***

<a id="servertimestamp"></a>

### serverTimestamp()

```ts
function serverTimestamp(): {
};
```

The server-timestamp sentinel — the case-data equivalent of
`FieldValue.serverTimestamp()`. The simulator resolves it to the request
time, so a rule comparing `data.createdAt == request.time` sees a match.

#### Returns

```ts
{
}
```

***

<a id="timestamp"></a>

### timestamp()

```ts
function timestamp(input:
  | string
  | number
  | {
  nanos?: number;
  seconds: number;
}): Timestamp;
```

A Firestore `timestamp` value.
  - number → milliseconds since the epoch
  - string → ISO-8601
  - object → explicit `{ seconds, nanos }`

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `input` | \| `string` \| `number` \| \{ `nanos?`: `number`; `seconds`: `number`; \} |

#### Returns

`Timestamp`

***

<a id="turnguard"></a>

### turnGuard()

```ts
function turnGuard(
   turnField: string,
   players: Record<string, string>,
   statusField?: string,
   playingValue?: string): string;
```

Turn enforcement: only the current turn's player can write.
Uses data (pre-write) for the turn check — NOT newData.

#### Parameters

| Parameter | Type | Description |
| :------ | :------ | :------ |
| `turnField` | `string` | the field that stores whose turn it is (e.g., "currentTurn") |
| `players` | `Record`\<`string`, `string`\> | map of mark → player field (e.g., { X: "playerX", O: "playerO" }) |
| `statusField?` | `string` | optional field that must equal playingValue for moves to be allowed |
| `playingValue?` | `string` | the value of statusField during active play (e.g., "playing") |

#### Returns

`string`

***

<a id="vector"></a>

### vector()

```ts
function vector(values: readonly number[]): Vector;
```

A `vector` value from its numeric components.

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `values` | readonly `number`[] |

#### Returns

`Vector`

***

<a id="wincheckhelper"></a>

### winCheckHelper()

```ts
function winCheckHelper(
   mark: string,
   lines: number[][],
   boardPath?: string): string;
```

Win check helper: validates a boolean field against winning lines on a board.
If true, at least one winning line must exist. If false, no winning line can exist.
Uses the "client claims, rules verify" pattern.

#### Parameters

| Parameter | Type | Description |
| :------ | :------ | :------ |
| `mark` | `string` | the player mark to check (e.g., "X") |
| `lines` | `number`[][] | array of winning line coordinates (e.g., [[0,1,2], [3,4,5], ...]) |
| `boardPath?` | `string` | the path to the board relative to the parent (default "board") |

#### Returns

`string`
