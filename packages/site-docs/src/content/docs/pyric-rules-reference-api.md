---
title: "Public API"
group: "pyric / rules"
section: "Reference"
order: 13010
---
# Public API

This page describes every symbol exported from `pyric/rules`. The surface is small: two constructors, one tolerant lint function, three assertion adapters, a handful of value helpers, the RTDB constraints DSL, and the error/type vocabulary they share.

The parser, linter internals, validator, simulator handler, modules resolver, and RTDB engine are not exported from `pyric/rules`. They live on `pyric/rules/internal` and its subpaths, described at the bottom of this page.

## Constructors

### `firestoreRules(source: string): FirestoreRuleset`

Compiles Firestore rules source into a handle. Throws `RulesCompileError` (carrying `.issues: RuleIssue[]`) if the source doesn't parse. Past construction, the handle never throws on a rule outcome.

`FirestoreRuleset`:

- `lint(): RuleIssue[]`: structural, security, and budget findings on the compiled ruleset. No parse errors; the source already compiled.
- `simulate(cases: FirestoreCase[]): SimulationSummary`: runs every case. A denied or abstained case is reported in the result, not thrown.
- `explain(oneCase: FirestoreCase): Explanation`: the structured account of why one case resolved as it did.
- `toJSON(): FirestoreRules`: the parsed ruleset as plain data (the AST).

### `rtdbRules(input: RtdbRulesDefinition | RtdbRulesDocument | RtdbRulesJson): RtdbRuleset`

Builds a handle on a Realtime Database ruleset. Accepts an `RtdbRulesDefinition` (the `{ paths }` object), the value `defineRtdbRules(...)` returns, or compiled `{ rules }` JSON.

The `RtdbRulesDocument` that `defineRtdbRules` returns is an inert authored artifact on the public surface: the type exposes no methods. `rtdbRules()` is the one analysis surface for it (`lint` / `simulate` / `explain` / `toJSON`).

The definition and document inputs support the full surface. A compiled `{ rules }` JSON input can only round-trip through `toJSON`: there is no IR left to lint or simulate against, so `lint()` returns `[]` and `simulate()` reports every case as unsupported.

`RtdbRuleset`:

- `lint(): RuleIssue[]`: structural findings on the compiled ruleset.
- `simulate(cases: RtdbCase[]): RtdbSimulationSummary`: runs every case. Never throws on a rule outcome.
- `explain(oneCase: RtdbCase): RtdbExplanation`: the structured account of one case's outcome.
- `toJSON(): RtdbRulesJson`: the compiled `rules.json`.

## Tolerant lint

### `lint(source: string): RuleIssue[]`

The AI-authoring front door. Accepts anything, including empty or unparseable source. Never throws. Returns every issue it can find, parse errors included, folded into one `RuleIssue[]` list.

## Assertion adapter

The only throwing verb beyond the constructors. It bridges the data-returning front door to a throwing test runner.

### `assertCase(result: CaseResult | RtdbCaseResult): void`

Throws on a failed or abstained case result. `RulesUnsupportedError` for an abstention, `RulesAssertionError` for a genuine expectation mismatch. Returns `void` on a passing result.

### `assertCase(ruleset: FirestoreRuleset, oneCase: FirestoreCase): void`
### `assertCase(ruleset: RtdbRuleset, oneCase: RtdbCase): void`
### `assertCase(source: string, oneCase: FirestoreCase): void`

Simulates that single case and throws on a miss, with the same semantics as the result form: `RulesAssertionError` (message is the `explainCase` trace) when the decision didn't match the expectation, `RulesUnsupportedError` on a simulator abstention. The `source` form compiles Firestore source first (throwing `RulesCompileError` if it doesn't parse).

Runner wiring:

```ts
const ruleset = firestoreRules(source);
for (const c of cases) test(c.description, () => assertCase(ruleset, c));
```

### `explainCase(result: CaseResult | RtdbCaseResult): string`

The single sanctioned trace renderer. Used as the message of the errors `assertCase` throws, and available directly for logging a result without asserting.

## Errors

The only three error classes the public surface throws.

- `RulesCompileError`: thrown by `firestoreRules(source)` / `rtdbRules(...)` when the source doesn't compile. Carries `.issues: RuleIssue[]`.
- `RulesAssertionError`: thrown by `assertCase` when the decision didn't match the expectation. Message is the `explainCase` trace.
- `RulesUnsupportedError`: thrown by `assertCase` when the simulator abstained.

See [Errors](../pyric-rules-reference-errors/) for the full picture, including the internal-engine error types these are built from.

## Unified issue type

### `RuleIssue`

```ts
interface RuleIssue {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  path?: string;
  line?: number;
  fix?: string;
  origin: 'parse' | 'validate' | 'lint';
}
```

Replaces the old `LintWarning`, `ValidationFinding`, and `ParseError` shapes with one. `origin` records which stage produced the issue: `'parse'` for compile blockers, `'validate'` for structural/security findings, `'lint'` for budget/quality/hallucination warnings. Filtering on `origin === 'parse'` gets the compile blockers without needing three separate types.

## Case and result types

Firestore and RTDB cases are kept distinct on purpose: the two rules languages take different request shapes, and unifying them would force every field to be optional. They share the assertion adapters and `RuleIssue`, nothing more.

### Firestore

- `FirestoreCase`: `{ description, expectation: 'ALLOW' | 'DENY', method, path, auth?, resource?, data?, writeMode?, functionMocks?, query?, requestTime? }`.
- `CaseResult`: `{ case, description, expectation, decision, passed, unsupported, trace, notes, pathResolution? }`.
- `Explanation`: `{ decision, expectation, passed, unsupported, deciding?, trace, pathResolution?, notes }`.
- `SimulationSummary`: `{ passed, failed, unsupported, cases: CaseResult[] }`.
- `FirestoreMethod`, `RuleEvaluation`, `PathResolutionTrace`, `PathResolutionEntry`, `ExprTraceEntry`, `EvaluatedRuleInfo`: the structured trace vocabulary. Plain data, no behavior.

### RTDB

- `RtdbCase`: `{ description?, expect: 'allow' | 'deny', operation: 'read' | 'write' | 'validate', path, auth?, data?, newData? }`.
- `RtdbCaseResult`: `{ case, description?, expect, decision, passed, unsupported, matchedPath, matchedRule, reason }`.
- `RtdbExplanation`: `{ decision, expect, passed, unsupported, matchedPath, matchedRule, reason }`.
- `RtdbSimulationSummary`: `{ passed, failed, unsupported, cases: RtdbCaseResult[] }`.

## Value helpers

Small named constructors for the typed values a case's `data` / `resource` carries. Each wraps an engine value-wrapper class so callers don't need to know the class shape, only the value it represents.

- `serverTimestamp()`: the `FieldValue.serverTimestamp()` sentinel. The simulator resolves it to the request time.
- `timestamp(msOrIsoOrObj: number | string | { seconds: number; nanos?: number })`: a Firestore `timestamp` value.
- `bytes(strOrU8: string | Uint8Array)`: a `bytes` value.
- `latlng(lat: number, lng: number)`: a `latlng` geographic point.
- `duration(value: number, unit = 's')`: a `duration` value. `unit` is one of `'w' | 'd' | 'h' | 'm' | 's' | 'ms' | 'ns'`.
- `reference(path: string)`: a `reference` to a document, by path.
- `vector(numbers: readonly number[])`: a `vector` value.

See [Value wrappers](../pyric-rules-reference-value-wrappers/) for the underlying classes these helpers construct.

## RTDB constraints DSL

Re-exported unchanged from `pyric/rules`: `defineRtdbRules`, `ruleset`, `schemaRules`, and the combinators `expr, all, any, not, deny, always, allow, authenticated, ownPath, ownField, isNew, hasChildren, hasChild, fieldIsString, fieldIsNumber, fieldIsBoolean, fieldEnum, immutable, immutableSelf, rootExists, rootEquals, pathOwnerOnly, fieldOwnerOnly, ownerOrNew, hasRole, isMember, required, transition, dataVal, newDataVal, dataExists, newDataExists, newDataIs, dataParentVal, newDataParentVal, newDataParentExists, eq, neq, gt, lte, AUTH_UID, turnGuard, flip, winCheckHelper`.

See [`pyric/database`'s constraints reference](../pyric-database-reference-constraints/) for the DSL itself.

## Internal engine (`pyric/rules/internal*`)

The lower-level engine still exists, but only on internal seams. These are not part of the public contract and may change without notice:

- `pyric/rules/internal`: parser (`parseToAST`), linter (`lintFirestoreRules`), validator (`validateFirestoreRules`), simulator (`SimulateFirestoreRulesHandler`), value-wrapper classes, browser resolver (`resolveModulesBrowser`), stdlib, trace/test types, network handlers (`TestFirestoreRulesHandler`, `WriteFirestoreRulesHandler`, `InspectFirestoreRulesHandler`), stdlib tools, inspect tools.
- `pyric/rules/internal/node`: the Node fs module resolver (`resolveModules`, `loadModule`, ...) and agent-tool factories (`createFirestoreRulesTools`, `createFirestoreSimulatorTools`, `createFirestoreRulesStdlibTools`).
- `pyric/rules/internal/rtdb`: the RTDB engine (`RtdbMapper`, `GenerateIRHandler`, `SimulateHandler`, `WriteRulesHandler`, `RtdbHost`, `RtdbIR`, `RtdbNode`, `getRtdbTools`, `createRtdbRulesTools`, and related types).
- `pyric/rules/internal/extract`: the composite-index extractor (`extractIndexes`, `ExtractFirestoreIndexesHandler`, `createFirestoreExtractTool`).

The subpaths that used to hold these (`pyric/rules/node`, `pyric/rules/extract`, `pyric/rules/rtdb`, `pyric/rules/rtdb/constraints`, `pyric/rules/rtdb-constraints`) no longer exist.

See [AST reference](../pyric-rules-reference-ast/), [Errors](../pyric-rules-reference-errors/), [Lint rules](../pyric-rules-reference-lint-rules/), [Validator findings](../pyric-rules-reference-validator-findings/), [Stdlib modules](../pyric-rules-reference-stdlib-modules/), and [Simulator context](../pyric-rules-reference-simulator-context/) for the engine detail behind these seams.
