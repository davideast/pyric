---
title: "Errors"
group: "pyric / rules"
section: "Reference"
order: 13013
---
# Errors

The package surfaces failures in three ways: structured values for the parser, throwable classes for the evaluator, and `Outcome`-shaped objects for the handlers. This page lists every error type.

## Parse failures

### `ParseError`

Returned by `parseToASTOrError` and embedded in `LintResult.parseError`. Not thrown.
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

### `ParseResult`

Returned by `parseExpression` and `parseRulesFile`:
```ts
interface ParseResult {
  valid: boolean;
  errors: Array<{ message: string }>;
  parseError?: ParseError;
}
```
`errors` is the legacy surface; `parseError` is the structured form.

## Evaluator errors

These extend `Error` and are thrown synchronously during expression evaluation. `SimulateFirestoreRulesHandler.simulate` catches them and converts them into result states; callers using `evaluate` directly need to handle them.

### `EvalError`

Real evaluation failure: type mismatch, missing field, division by zero. Carries an optional `expr: Expression` for the failing AST node.

The handler catches `EvalError` and treats it as that rule denying, matching production's "runtime errors deny" behaviour. A test case where every rule denied via `EvalError` lands in `DENY` (not `UNSUPPORTED`).

### `UnsupportedError` extends `EvalError`

The simulator hit a feature it does not yet implement: an unknown built-in function, a namespace method missing from a wrapper, a type it doesn't model. Caught by the handler and surfaced as `TestResult.state === 'UNSUPPORTED'`.

`UnsupportedError` is the only path to `UNSUPPORTED`. If every rule in a match block threw `EvalError` instead, the case decides `DENY`.

### `ExpressionWalkError`

Thrown by `resolveExpressionsInData` when an `$expr` wrapper has the wrong shape (extra keys, non-string value, etc.). Carries `code: 'invalid-argument'` and a dotted `path` to the offending leaf.
```ts
class ExpressionWalkError extends Error {
  readonly code: 'invalid-argument';
  readonly path: string;   // e.g. 'users.0.balance'
}
```
### `ExpressionLexError` and `ExpressionParseError`

Thrown by `tokenize` / `parse` in the sentinel expression DSL. Carry a `Position` so the caller can report `line:column` against the original `$expr` source.

## Handler results

The handlers (`SimulateFirestoreRulesHandler`, `TestFirestoreRulesHandler`, the modules resolver) never throw for expected failure modes. They return `Outcome`-shaped objects:
```ts
type Result<T> =
  | { success: true; data: T }
  | { success: false; error: { code: string; message: string; recoverable?: boolean } };
```
### Simulator `error.code` values

- `PARSE_FAILED`: the source did not parse.

### Rules Test API client `error.code` values

- `PARSE_FAILED`: the source did not parse (the API surfaced issues instead of running tests).
- `PERMISSION_DENIED`: service account lacks `firebaserules.releases.test`. `recoverable: false`.
- `INVALID_REQUEST`: 400 from the API. `recoverable: true`.
- `RULES_ERROR`: the API returned source-level issues. `recoverable: true`.
- `FETCH_FAILED`: network or unexpected non-2xx. `recoverable` depends on the underlying cause.

### Modules resolver `error.code` values

- `PARSE_FAILED`: source did not parse.
- `NOT_MODULE_SOURCE`: version is not `'2+modules'`.
- `UNKNOWN_MODULE`: module name not found in stdlib, `modules` map, or `basePath`.
- `UNKNOWN_FUNCTION`: module exists but the imported function is not exported (or doesn't exist at all; the message disambiguates).
- `DUPLICATE_FUNCTION`: same function exported by two modules, or collision with a source-defined function.
