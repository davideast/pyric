---
title: "Public API"
group: "pyric / rules"
section: "Reference"
order: 102
---
# Public API

This page describes every symbol re-exported from `pyric/rules`. Symbols are grouped by submodule and listed alphabetically within each group.

## Parser and AST

### `parseToAST(input: string): FirestoreRules | null`

Parse a rules source into an AST. Returns `null` on parse failure.

### `parseToASTOrError(input: string): { ok: true; ast: FirestoreRules } | { ok: false; error: ParseError }`

Parse a rules source. Returns either the AST or a structured `ParseError` with `line`, `column`, `offset`, `expected`, `actual`, and `message`.

### `parseFunctions(input: string): FunctionDef[] | null`

Parse a fragment containing function definitions. Wraps the input in a minimal `rules_version='2'` shell. Returns the parsed functions, or `null` on failure.

### `assembleRules(ast: FirestoreRules): string`

Serialise an AST back to a rules source string. Used internally by the modules resolver.

### `validateFirestoreRules(ast: FirestoreRules): ValidationFinding[]`

Run the structural validator over a parsed AST. See [Validator findings](../pyric-rules-reference-validator-findings/) for every code.

### Types

- `FirestoreRules` — root of the AST: `{ version, imports, service }`.
- `MatchBlock` — `{ path, functions, allows, children }`.
- `AllowRule` — `{ operations, condition }`.
- `FunctionDef` — `{ name, parameters, exported, lets, body }`.
- `Expression` — discriminated union of every expression node. See [AST reference](../pyric-rules-reference-ast/).
- `PathSegment` — `{ type: 'literal' | 'wildcard' | 'recursive', ... }`.
- `ParseError` — `{ line, column, offset, expected, actual, message }`.
- `ParseResult` — `{ valid, errors, parseError? }`.
- `ValidationFinding` — `{ code, severity, path, operation?, message }`.

## Linter

### `lintFirestoreRules(source: string, options?: LintOptions): LintResult`

Run the linter. `LintResult` has `warnings`, `metrics`, and optional `parseError`. Callers must check `parseError` before reading warnings or metrics.

`LintOptions`:

- `testCases?: TestCase[]` — activates `REQUEST_TIME_NOT_PINNED`.
- `previousSource?: string` — activates `RULES_WEAKENED`.

See [Lint rules](../pyric-rules-reference-lint-rules/) for every rule code, threshold, and severity.

### Types

- `LintResult` — `{ warnings, metrics, parseError? }`.
- `LintWarning` — `{ rule, severity, message, location?, fix? }`.
- `LintOptions` — see above.
- `RulesMetrics` — `{ sourceSize, functionCount, allowRuleCount, maxChainDepth, maxChainOp, maxLetBindings, maxLetBindingsFunction, maxCallDepth, maxEstimatedExpressions, getCallCount }`.

## Modules resolver

### `resolveModules(source: string, options?: ResolveOptions): ResolveResult`

Resolve `rules_version = '2+modules'` imports. Returns the rewritten standard `'2'` source plus the list of modules used, or a coded error.

### `loadModule(moduleName: string, options?: ResolveOptions): { success: true; functions: FunctionDef[] } | { success: false; error }`

Load a single module's functions. Used internally by `resolveModules`; exposed for diagnostic tooling.

### `sanitizeModuleName(name: string): string`

Convert a module name (possibly relative) into a safe identifier-prefix. Used to namespace private functions when inlining.

### Types

- `ResolveResult` — `{ success: true; data: { resolved, modules } } | { success: false; error }`.
- `ResolveOptions` — `{ basePath?, modules? }`.

## Simulator

### `class SimulateFirestoreRulesHandler`

In-process evaluator.

- `simulate(source: string, testCases: TestCase[]): TestFirestoreRulesResult`

### `evaluate(expression: Expression, ctx: SimulationContext): unknown`

Evaluate a single expression against a context. Used by the handler; exposed for callers that build their own evaluation loops.

### `projectAfterState(writeMode: WriteMode, existing: Record<string, unknown> | null, payload: Record<string, unknown>): Record<string, unknown> | null`

Compute the post-write document for a given write mode (`create`, `set` with merge, `update`, `delete`).

### `const SERVER_TIMESTAMP`

Sentinel value for `FieldValue.serverTimestamp()` in test data. The handler resolves all sentinels in the request payload to a single `Timestamp` instance before evaluation.

### `class UnsupportedError extends EvalError`

Thrown by the evaluator when it hits a feature it doesn't yet implement. Caught by the handler and surfaced as `TestResult.state === 'UNSUPPORTED'`.

### Types

- `SimulationContext` — `{ request, resource, mockDocuments, pathVariables, functions, database, afterStatePath, afterState, existsAfter }`. See [Simulator context](../pyric-rules-reference-simulator-context/).

### `class MapDiff` and `class FirestoreSet`

Helpers used by `request.resource.data.diff(resource.data)` and the `keys()` family. Exposed for callers that need to share the same semantics in custom analysis.

## Expression DSL primitives

### `tokenize(input: string): Token[]`
### `parse(tokens: Token[]): AstNode`
### `resolveExpressionsInData(data, env): unknown`
### `class ExpressionWalkError`
### `class EvalError`
### `class ExpressionLexError`
### `class ExpressionParseError`

The sentinel expression engine — used by `pyric/sandbox` to resolve `{ $expr: '...' }` wrappers in declarative writes. See [The sentinel expression engine](../pyric-rules-explanation-sentinel-expression-engine/).

## Value wrappers

Re-exported classes for the runtime types Firestore rules expose. All extend `RulesValue`.

- `class Timestamp`
- `class Path`
- `class Reference` and `referenceToResourceName(ref): string`
- `class Vector`
- `class Bytes`
- `class Duration`
- `class LatLng`
- `class RulesValue` (base class) and `const NO_OP` (method-dispatch sentinel)

See [Value wrappers](../pyric-rules-reference-value-wrappers/).

## Rules Test API client

### `class TestFirestoreRulesHandler`

Calls Google's Firebase Rules Test API.

- `execute(scope: ProjectScope, source: string, testCases: TestCase[]): Promise<TestFirestoreRulesResult>`

`ProjectScope` comes from `pyric-tools/deploy`.

### Types

- `TestCase` — see [`TestCase` schema](../pyric-rules-reference-test-case-schema/).
- `TestResult` — `{ description, expectation, state, debugMessages }`.
- `TestFirestoreRulesResult` — `{ success: true; data: { passed, failed, unsupported, results } } | { success: false; error }`.
- `FunctionMock` — `{ function: 'get' | 'exists', path, result }`.
- `const TestCaseSchema` — the underlying Zod schema for `TestCase`.

## Tool factories

### `createFirestoreRulesTools(deps?: FirestoreRulesToolDeps): ToolHandler[]`

Returns:

- `firestore_lint_rules`
- `firestore_resolve_modules`
- `firestore_simulate_rules`
- `firestore_test_rules` *(only when `deps.scope` is supplied)*

`FirestoreRulesToolDeps`:

- `scope?: ProjectScope` — credentials for the Rules Test API.

### `createFirestoreSimulatorTools(deps: FirestoreSimulatorToolDeps): ToolHandler[]`

Slice 8 scaffold. Returns an empty array today; the full seven-tool family lands as consumers register interest. The factory shape and `resolveSandbox` contract are stable.

`FirestoreSimulatorToolDeps`:

- `resolveSandbox: () => LocalEnvironment | Promise<LocalEnvironment>` — per-dispatch resolver returning the session-scoped sandbox environment.
