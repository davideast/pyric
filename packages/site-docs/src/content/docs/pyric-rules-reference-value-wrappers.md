---
title: "Value wrappers"
group: "pyric / rules"
section: "Reference"
order: 12019
---
# Value wrappers

The simulator and the sentinel expression engine model Firestore's runtime types as TypeScript classes. Every wrapper extends `RulesValue`, exposes `equals`, `toJSON`, and `toString`, and dispatches method calls via `callMethod`. These classes are engine-internal, importable from `pyric/rules/internal`.

Most callers don't need the classes directly: `pyric/rules`'s public value helpers (`serverTimestamp()`, `timestamp()`, `bytes()`, `latlng()`, `duration()`, `reference()`, `vector()`) construct the right wrapper instance for a `FirestoreCase`'s `data` / `resource` field. See [Public API](../pyric-rules-reference-api/#value-helpers).

You reach for the classes on `pyric/rules/internal` directly when:

- Building a `SimulationContext` by hand (custom evaluator).
- Walking results from `evaluate()` and deciding what to do with them.
- Writing your own wrapper for a type the built-ins don't model.

## `RulesValue` (base class)
```ts
abstract class RulesValue {
  readonly typeName: string;
  callMethod(method: string, args: unknown[]): unknown | NoOp;
  binaryOp?(op: string, other: unknown): unknown | NoOp;
  equals(other: unknown): boolean;
  toJSON(): unknown;
  toString(): string;
}
```
`NO_OP` is the sentinel returned from `callMethod` and `binaryOp` when a wrapper doesn't implement a method or operation. The evaluator translates `NO_OP` into an `UnsupportedError`, which the handler maps to `state: 'UNSUPPORTED'`.

## `Timestamp`

Wraps `request.time`, `getAfter()` timestamps, and any field value that was `FieldValue.serverTimestamp()` in the request payload.
```ts
class Timestamp extends RulesValue {
  readonly seconds: number;
  readonly nanos: number;

  static fromMillis(ms: number): Timestamp;
  static fromYMD(year: number, month: number, day: number): Timestamp;  // timestamp.date(y, m, d) — 1-based month
  static fromIsoString(iso: string): Timestamp;

  toMillis(): number;
}
```
Methods exposed to rules (via `callMethod`): `date`, `day`, `dayOfWeek`, `dayOfYear`, `hours`, `minutes`, `month`, `nanos`, `seconds`, `time`, `toMillis`, `year`.

Binary ops: `==`, `!=`, `<`, `<=`, `>`, `>=` against another `Timestamp`; `+`/`-` against a `Duration` returning a new `Timestamp`; `-` against another `Timestamp` returning a `Duration`.

Internal storage uses signed `seconds` and non-negative `nanos` (protobuf convention). `equals` is a field-compare: two timestamps with the same epoch but different sub-second precision are equal only if both `seconds` and `nanos` match.

## `Path`

Wraps `request.path`, `__name__`, and path literals constructed from `path(...)`.
```ts
class Path extends RulesValue {
  readonly segments: readonly string[];
  readonly bindings: Readonly<Record<string, string>>;

  static fromString(s: string): Path;

  bind(bindings: Record<string, unknown>): Path;
  field(name: string): unknown;                 // named-binding access
}
```
Methods: standard accessors. `bindings` is the wildcard map from the matched path pattern. `request.path.<name>` returns `bindings[name]` for `<name>` that was a wildcard in the match path. Without bindings, named-field access returns `null`.

## `Reference`

Wraps DocumentReference values inside test data.
```ts
class Reference extends RulesValue {
  readonly path: Path;
}

function referenceToResourceName(ref: Reference): string;
```
Use `referenceToResourceName` to get the full `/databases/.../documents/...` form when calling the Rules Test API.

## `Duration`

Wraps `request.time - resource.data.<ts>` results and `duration.value(n, 'h')` constructions.
```ts
class Duration extends RulesValue {
  readonly seconds: number;
  readonly nanos: number;

  static fromValue(magnitude: number, unit: string): Duration;   // duration.value(n, 'd'|'h'|'m'|'s'|'ms')
  static fromTime(h: number, m: number, s: number, ns: number): Duration;
  static abs(d: Duration): Duration;
}
```
Unit codes for `fromValue`: `'w'`, `'d'`, `'h'`, `'m'`, `'s'`, `'ms'`. Binary ops mirror `Timestamp`'s.

## `Bytes`

Wraps `bytes` values.
```ts
class Bytes extends RulesValue {
  readonly data: Uint8Array;

  static fromUtf8(s: string): Bytes;
  static fromHex(hex: string): Bytes;

  size(): number;
  toBase64(): string;      // URL-safe, no padding
  toHexString(): string;
}
```
Slice access (`bytes[start:end]`) is supported via `sliceAccess` expressions and produces a new `Bytes`.

## `LatLng`

Wraps geo-point values.
```ts
class LatLng extends RulesValue {
  readonly lat: number;
  readonly lng: number;

  constructor(lat: number, lng: number);

  // distance(other) returns metres via the haversine formula.
}
```
## `Vector`

Wraps embedding vectors.
```ts
class Vector extends RulesValue {
  readonly values: readonly number[];
}
```
## `RulesValue` and `NO_OP`

Exported for callers writing custom wrappers. To add support for a new type:

1. Extend `RulesValue`.
2. Set `typeName` to the lowercase namespace identifier (`'reference'`, `'timestamp'`, …).
3. Implement `callMethod` returning `NO_OP` for unsupported methods.
4. Implement `binaryOp` if your type participates in arithmetic or comparison.
5. Implement `equals` for cross-type equality (default is reference equality).
