---
title: "The sentinel expression engine ($expr)"
navLabel: "Sentinel expression engine"
group: "pyric / rules"
section: "Explanation"
order: 12023
---
# The sentinel expression engine (`$expr`)

Firestore writes are usually concrete: `{ count: 5, owner: 'alice' }`. But sometimes you want a write whose value depends on the document at write time: "increment `count` by one if it's less than 100", "set `lastSeen` to the current request time", "merge this list with the existing one and dedupe". The Firestore SDK offers a handful of `FieldValue` sentinels for the most common cases (`increment`, `arrayUnion`, `serverTimestamp`), but anything outside that small set requires a transaction.

The sentinel expression engine extends that surface. It defines a tiny expression DSL that can appear anywhere in a write payload, wrapped as `{ $expr: '...' }`. At commit time, every wrapper is resolved against the current document, *before* the write hits the data plane. The result is a fully-concrete payload that Firestore stores normally.

The engine is small (a hand-written lexer, parser, evaluator) and intentionally separate from the Firestore rules grammar. It powers `pyric/sandbox`'s declarative transactions. This page explains the model.

## The shape

A wrapper is an object whose *only* key is `$expr` and whose value is a string:

```ts
{ count: { $expr: 'doc.count + 1' } }
```

Anything else (extra keys alongside `$expr`, non-string `$expr` values, nested wrappers without proper shape) is rejected with `ExpressionWalkError`. The strict shape is deliberate: it makes the wrapper instantly recognisable when scanning a payload, and it prevents accidental collisions with field names.

## The walker

`resolveExpressionsInData(data, env)` walks the payload tree once:

- For each plain object, it checks "is this a wrapper?". If yes, evaluate the expression against `env` and use the result as the value.
- For each non-wrapper object, recurse into its values.
- For each array, preserve length and order; recurse into each element.
- Leaves (primitives, `null`, sentinel passthroughs) are unchanged.

The walker doesn't recurse into eval results. If a `$expr` resolves to an object that itself contains a `$expr` key, that nested key is treated as data, not another wrapper. Without this rule, you'd have wrappers chained through document reads in non-obvious ways.

## The DSL

The expression language has just enough surface to be useful and small enough to be safe:

- **Identifiers** read from `env`: `doc`, `now`, `auth`. The environment is supplied by the caller; sandbox transactions populate it with the document under the write, the server time, and the auth context.
- **Member access**: `doc.count`, `auth.uid`.
- **Numeric arithmetic**: `+`, `-`, `*`, `/`, `%`.
- **Comparison**: `==`, `!=`, `<`, `<=`, `>`, `>=`.
- **Logical**: `&&`, `||`, `!`.
- **Ternary**: `cond ? then : else`.
- **Built-ins**: a curated set. `min`, `max`, `concat`, `length`, plus deliberate omissions like `eval` and `fetch`.

No I/O. No loops. No assignment. No function definitions. The DSL is intentionally not Turing-complete; the expression has to terminate in bounded time.

## Why a separate parser

The rules grammar (the one in `FirestoreRules.ohm`) is much larger: imports, services, match blocks, allow statements, `is` expressions, path literals. Reusing it for `$expr` would buy nothing (rules-grammar features like `match` and `allow` are meaningless inside a payload) and would carry every rules-grammar quirk into the DSL. Worst case, a typo in `$expr` would produce an opaque parser error that mentioned `allow read: if`.

A hand-written lexer and parser stay small (a few hundred lines), produce focused error messages with `line:column` positions, and let us evolve the DSL without disturbing the rules language.

## Error model

Three classes of failure, each with a distinct error type:

- **`ExpressionWalkError`**: wrong wrapper shape. The walker found `$expr` alongside other keys, or with a non-string value. Carries a dotted `path` to the offending leaf.
- **`ExpressionLexError`**: the expression string contained characters the lexer doesn't recognise. Carries a position.
- **`ExpressionParseError`**: the token stream didn't form a valid expression. Carries a position.
- **`EvalError`**: the expression parsed but failed at runtime (missing identifier, type mismatch).

The four types let tool authors translate each failure into a precise diagnostic: shape errors point at the payload, lex/parse errors point at the expression string, eval errors point at the runtime context.

## When to reach for `$expr`

The sandbox layer uses `$expr` in its declarative transaction API:

```ts
await sandbox.firestore('/notes/n1').set({
  count: { $expr: 'doc.count + 1' },
  lastSeen: { $expr: 'now' },
}, { merge: true });
```

Outside the sandbox, you generally don't need it. The production Firestore data plane has `FieldValue.increment` and `FieldValue.serverTimestamp` for the common cases. The engine exists because the sandbox needs a way to express *any* depends-on-current-state write without each write becoming a four-step transaction.

If you're building tooling that operates on `$expr`-bearing payloads (for example, a UI that displays pending writes), you'll want `resolveExpressionsInData` and `tokenize` / `parse` to inspect the expressions before they resolve. Both are exported for that reason.
