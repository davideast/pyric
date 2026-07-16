# Errors

`pyric/rules` throws exactly three error classes on its public surface. Everything below the public surface (the parser, evaluator, and handlers on `pyric/rules/internal`) has its own error vocabulary; those types still apply, but only to the internal engine now.

## Public errors

### `RulesCompileError`

Thrown by `firestoreRules(source)` / `rtdbRules(...)` when the source doesn't compile.

```ts
class RulesCompileError extends Error {
  readonly issues: RuleIssue[];
}
```

Carries the compile-blocking issues on `.issues` so a caller can surface them without re-parsing.

### `RulesAssertionError`

Thrown by `assertCase` when the simulated decision did not match the case's expectation. The message is the rendered `explainCase` trace, so a test runner surfaces the "why" without extra wiring.

### `RulesUnsupportedError`

Thrown by `assertCase` when the simulator abstained: it hit a feature it doesn't implement, so neither a pass nor a genuine failure can be asserted. Distinct from `RulesAssertionError` so a runner can choose to skip rather than fail on a known simulator gap.

## Internal engine errors (`pyric/rules/internal`)

These are not part of the public contract. They belong to the parser, evaluator, and handlers exposed on `pyric/rules/internal` and may change without notice. `firestoreRules`, `lint`, and the assertion adapters absorb all of them internally and never let them escape as-is; the sections above are what a public-surface caller actually sees.

### Parse failures

#### `ParseError`

Returned internally by `parseToASTOrError` and embedded in the internal `LintResult.parseError`. Not thrown. On the public surface this shows up as a `RuleIssue` with `origin: 'parse'` (from `lint()`) or inside `RulesCompileError.issues` (from `firestoreRules()`).

```ts
interface ParseError {
  line: number;        // 1-based
  column: number;      // 1-based
  offset: number;      // byte offset into the trimmed source
  expected: string;    // what the grammar wanted next
  actual: string;      // up to 40 chars at the failure point
  message: string;     // ohm's human-readable message with a caret
}
```

Use `line` / `column` for editor diagnostics, `message` for terminal output, `expected` / `actual` for custom UIs.

#### `ParseResult`

Returned by `parseExpression` and `parseRulesFile`:

```ts
interface ParseResult {
  valid: boolean;
  errors: Array<{ message: string }>;
  parseError?: ParseError;
}
```

`errors` is the legacy surface; `parseError` is the structured form.

### Evaluator errors

These extend `Error` and are thrown synchronously during expression evaluation. The internal simulator catches them and converts them into result states; callers using `evaluate` directly need to handle them. None of this escapes to the public surface: `firestoreRules(source).simulate(cases)` never throws on a rule outcome.

#### `EvalError`

Real evaluation failure: type mismatch, missing field, division by zero. Carries an optional `expr: Expression` for the failing AST node.

The handler catches `EvalError` and treats it as that rule denying, matching production's "runtime errors deny" behaviour. A test case where every rule denied via `EvalError` lands in `DENY` (not `UNSUPPORTED`).

#### `UnsupportedError` extends `EvalError`

The simulator hit a feature it does not yet implement: an unknown built-in function, a namespace method missing from a wrapper, a type it doesn't model. Caught by the handler and surfaced as `unsupported: true` on the public `CaseResult` / `RtdbCaseResult`.

`UnsupportedError` is the only path to an unsupported result. If every rule in a match block threw `EvalError` instead, the case decides `DENY`.

#### `ExpressionWalkError`

Thrown by `resolveExpressionsInData` when an `$expr` wrapper has the wrong shape (extra keys, non-string value, etc.). Carries `code: 'invalid-argument'` and a dotted `path` to the offending leaf.

```ts
class ExpressionWalkError extends Error {
  readonly code: 'invalid-argument';
  readonly path: string;   // e.g. 'users.0.balance'
}
```

#### `ExpressionLexError` and `ExpressionParseError`

Thrown by `tokenize` / `parse` in the sentinel expression DSL. Carry a `Position` so the caller can report `line:column` against the original `$expr` source.

### Handler results

The internal simulator, hosted test handler, and modules resolver never throw for expected failure modes. They return `Outcome`-shaped objects:

```ts
type Result<T> =
  | { success: true; data: T }
  | { success: false; error: { code: string; message: string; recoverable?: boolean } };
```

#### Simulator `error.code` values

- `PARSE_FAILED`: the source did not parse.

#### Rules Test API client `error.code` values

- `PARSE_FAILED`: the source did not parse (the API surfaced issues instead of running tests).
- `PERMISSION_DENIED`: service account lacks `firebaserules.releases.test`. `recoverable: false`.
- `INVALID_REQUEST`: 400 from the API. `recoverable: true`.
- `RULES_ERROR`: the API returned source-level issues. `recoverable: true`.
- `FETCH_FAILED`: network or unexpected non-2xx. `recoverable` depends on the underlying cause.

#### Modules resolver `error.code` values

- `PARSE_FAILED`: source did not parse.
- `NOT_MODULE_SOURCE`: version is not `'2+modules'`.
- `UNKNOWN_MODULE`: module name not found in stdlib, `modules` map, or `basePath`.
- `UNKNOWN_FUNCTION`: module exists but the imported function is not exported (or doesn't exist at all; the message disambiguates).
- `DUPLICATE_FUNCTION`: same function exported by two modules, or collision with a source-defined function.
