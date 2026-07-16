---
title: "Value wrapper design"
group: "pyric / rules"
section: "Explanation"
order: 12026
---
# Value wrapper design

Firestore rules have a small but real type system. `request.time` is a `timestamp`. `request.path` is a `path`. `bytes[0:10]` is a `bytes` value. `is duration`, `is timestamp`, `is reference` are type tests. None of these have first-class JavaScript representations (`Timestamp` is not a primitive, `Path` is not a primitive), so the simulator has to model them somehow.

We model them as classes. Each Firestore rules type is a TypeScript class extending `RulesValue`. This page explains why, and what falls out.

## What the rules engine sees

When a rule says `request.time.toMillis() > 1700000000000`, the production engine evaluates:

1. `request.time`: a value of type `timestamp`.
2. `.toMillis()`: a method dispatch on `timestamp`, returning `int`.
3. `> 1700000000000`: a binary comparison on `int`.

For step 2 to work, the simulator's representation of `request.time` has to remember that it's a `timestamp` (not a bare number, not a generic object) and dispatch `toMillis` accordingly.

Three options were on the table:

- **Plain objects with a discriminator field** (`{ __type: 'timestamp', seconds, nanos }`). Lightweight and JSON-serialisable, but every method call goes through a switch and `instanceof` doesn't work.
- **Tagged union with a service registry** (`evaluator.dispatch('timestamp', 'toMillis', value, args)`). Decouples values from behaviour. Hard to extend without touching central code.
- **Class instances** (`class Timestamp { toMillis() {...} }`). Methods live with their data, `instanceof` works, but classes have to be imported by every package that touches them.

We chose classes. The class-instances approach pulled together best in practice:

- Methods are co-located with the data they operate on, so adding a new method to `Timestamp` is a one-file change.
- `instanceof Timestamp` works, so the evaluator can branch on type at runtime without a registry.
- `equals()` is a method that knows how to compare two instances, so deep-equality of test data and rule results is straightforward.
- `toJSON()` is built into the protocol: the wrappers serialise to plain objects when crossing the wire to the Rules Test API.

## The `RulesValue` base class

All wrappers extend `RulesValue`. The base class is intentionally thin:

```ts
abstract class RulesValue {
  readonly typeName: string;            // 'timestamp', 'path', 'bytes', ...
  callMethod(method, args): unknown | NoOp;
  binaryOp?(op, other): unknown | NoOp;
  equals(other): boolean;
  toJSON(): unknown;
  toString(): string;
}
```

`callMethod` and `binaryOp` exist so the evaluator can dispatch generically: `if (lhs instanceof RulesValue) return lhs.callMethod(method, args)`. The handler doesn't need a per-type switch; the polymorphism does the work.

`typeName` is the lowercase identifier the rules engine uses for the `is` operator. `request.time is timestamp` works because `Timestamp.typeName === 'timestamp'`.

## The `NO_OP` sentinel

When a wrapper is asked to dispatch a method or operation it doesn't implement, it returns `NO_OP` rather than throwing or returning `undefined`. The evaluator catches `NO_OP` and throws `UnsupportedError`, which the handler maps to `state: 'UNSUPPORTED'`.

The sentinel exists so that:

- The wrapper can decline cleanly without knowing why the caller is dispatching.
- The evaluator can distinguish "method returned `undefined`" (a legitimate result) from "method does not exist" (an `UnsupportedError`).
- Adding a new method to a wrapper does not require updating the evaluator: add the case to `callMethod` and start returning a real value instead of `NO_OP`.

## Equality semantics

`equals()` is what makes test data comparable. Two `Timestamp` instances with the same `seconds` and `nanos` are equal. Two `Path` instances with the same segments are equal. Without this, every rule that compares two timestamps would have to compare by reference, and test data, which constructs fresh wrappers every time, would never compare equal to the engine's wrappers.

Equality is a field-compare, not a reference compare. This is the same model production uses. It does mean care is needed when constructing test data: a `Timestamp` built from a different `seconds`/`nanos` split (say `seconds: 100, nanos: 0` vs `seconds: 99, nanos: 1_000_000_000`) is **not** equal under field-compare, even though both represent the same instant. The `Timestamp` constructor normalises through `seconds + Math.floor(nanos / 1e9)`, so canonical forms always compare correctly.

## The single-instance invariant for `SERVER_TIMESTAMP`

The handler resolves every `{ __type: 'serverTimestamp' }` sentinel in your test data to the **same** `Timestamp` instance, not a fresh one per occurrence. This matters because:

- `data.createdAt == request.time` succeeds via `equals` (field-compare), which would work either way.
- But the *single-instance* property documents the intent: the request's notion of "now" is one value, not many. If you ever refactor the resolver to construct per-call, deepEquals comparisons inside the engine will still pass, but the conceptual model breaks. The single-instance invariant exists to prevent that drift.

## Why the wrappers live here, not in `pyric/sandbox`

The sandbox in `pyric/sandbox` also needs `Timestamp`, `Vector`, `Reference`. When it reads a document containing a timestamp field, it needs to return a `Timestamp` instance that `instanceof Timestamp` is true for. If the wrapper classes lived in the sandbox, the rules simulator couldn't use them without depending on the sandbox; if they lived in both packages, `instanceof Timestamp` would lie depending on which copy was imported.

The classes themselves are engine-internal, importable from `pyric/rules/internal` for callers that need `instanceof` checks or custom evaluation. Most callers never import them directly: the public `pyric/rules` value helpers (`serverTimestamp()`, `timestamp()`, `bytes()`, `latlng()`, `duration()`, `reference()`, `vector()`) construct the right instance without exposing the class.

The wrappers live in `pyric/rules` (internally) because:

- This is the package that defines what `is timestamp` means.
- This is the package that evaluates expressions, which is where most wrapper code is exercised.
- One canonical class per type, so `instanceof` always works.

The cost is a small runtime cycle: `pyric/sandbox` imports the wrappers from this package, and this package imports the `LocalEnvironment` type from `pyric/sandbox/internal`. The cycle is type-only on the rules-tooling side and value-import on the sandbox side, which is benign at build time and runtime. We accepted the cycle over duplicating the wrappers.
