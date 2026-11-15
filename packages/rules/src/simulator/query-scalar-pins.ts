/**
 * Query scalar normalization, Rules literal AST construction, and numeric
 * int/float equivalence domain expansion for the list-query prover.
 *
 * Firestore `==` filters compare integers and doubles by numeric value
 * (including `0`, `+0.0`, and `-0.0`), so an equality filter on a whole number
 * can return documents storing either an `int` or a `float`. Membership
 * filters (`in`, `array-contains`) use strict wire value equality (matching
 * numeric type and zero sign without mixing ints and doubles).
 */
import type { Expression } from "../grammar/FirestoreAST.js";
import { hostNumber, isHostIntNumber } from "./rules-int.js";
import { listElementsEqual } from "./value-equality.js";
import { Bytes } from "./wrappers/bytes.js";
import { Duration } from "./wrappers/duration.js";
import { RulesFloat } from "./wrappers/float.js";
import { LatLng } from "./wrappers/latlng.js";
import { Path } from "./wrappers/path.js";
import { Reference } from "./wrappers/reference.js";
import { Timestamp } from "./wrappers/timestamp.js";

export type RulesWrapperScalar = Reference | Path | Timestamp | Bytes | LatLng | Duration;
export type Scalar = string | number | boolean | null | RulesWrapperScalar;
export type RulesScalar = string | number | bigint | boolean | null | RulesFloat | RulesWrapperScalar;
type PrimitiveScalar = string | number | boolean | null;

const MIN_INT64_NUMBER = -(2 ** 63);
const MAX_EXCLUSIVE_INT64_NUMBER = 2 ** 63;

function isRulesWrapperScalar(value: unknown): value is RulesWrapperScalar {
  return (
    value instanceof Reference ||
    value instanceof Path ||
    value instanceof Timestamp ||
    value instanceof Bytes ||
    value instanceof LatLng ||
    value instanceof Duration
  );
}

const isScalar = (value: unknown): value is Scalar =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value)) ||
  isRulesWrapperScalar(value);

export function isRulesScalar(value: unknown): value is RulesScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (value instanceof RulesFloat && Number.isFinite(value.value)) ||
    isRulesWrapperScalar(value)
  );
}

export function normalizeQueryConstraintScalar(value: unknown): Scalar | undefined {
  if (isScalar(value)) return value;
  if (value instanceof RulesFloat && Number.isFinite(value.value)) return value.value;
  if (
    typeof value === "bigint" &&
    value >= BigInt(Number.MIN_SAFE_INTEGER) &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(value);
  }
  return undefined;
}

export function toRulesQueryScalar(value: RulesScalar): RulesScalar {
  if (typeof value === "number") {
    return hostNumber(value);
  }
  return value;
}

/**
 * Normalize a query operand to its exact Firestore wire / Rules scalar
 * representation without cross-type expansion. Used for strict membership
 * filters (`in`, `array-contains`).
 */
export function normalizeStrictQueryScalar(value: unknown): RulesScalar | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    if (isHostIntNumber(value)) return value;
    return new RulesFloat(value);
  }
  if (value instanceof RulesFloat) {
    if (!Number.isFinite(value.value)) return undefined;
    return value;
  }
  if (typeof value === "bigint") {
    if (
      value >= BigInt(Number.MIN_SAFE_INTEGER) &&
      value <= BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      return Number(value);
    }
    return undefined;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    isRulesWrapperScalar(value)
  ) {
    return value;
  }
  return undefined;
}

/**
 * Identity comparison on typed query-domain Rules scalars: numeric types and
 * signed zeros stay distinct (`0`, `+0.0`, `-0.0`, `1`, `1.0`).
 */
export function sameDomainRulesScalar(a: RulesScalar, b: RulesScalar): boolean {
  if (a instanceof RulesFloat || b instanceof RulesFloat) {
    return a instanceof RulesFloat && b instanceof RulesFloat && Object.is(a.value, b.value);
  }
  if (typeof a === "bigint" || typeof b === "bigint") {
    return typeof a === "bigint" && typeof b === "bigint" && a === b;
  }
  if (typeof a === "number" || typeof b === "number") {
    return typeof a === "number" && typeof b === "number" && Object.is(a, b);
  }
  return listElementsEqual(a, b);
}

function isUnsafeInt64Number(value: number): boolean {
  return (
    Number.isInteger(value) &&
    !Number.isSafeInteger(value) &&
    value >= MIN_INT64_NUMBER &&
    value < MAX_EXCLUSIVE_INT64_NUMBER
  );
}

function literalRaw(value: PrimitiveScalar): string {
  if (typeof value !== "number") return JSON.stringify(value);
  if (Object.is(value, -0)) return "-0.0";
  const serialized = JSON.stringify(value);
  if (
    !isHostIntNumber(value) &&
    !serialized.includes(".") &&
    !serialized.includes("e") &&
    !serialized.includes("E")
  ) {
    return `${serialized}.0`;
  }
  return serialized;
}

export function literal(value: PrimitiveScalar): Expression {
  return {
    type: "literal",
    value,
    raw: literalRaw(value),
  };
}

function int64LiteralExpr(value: bigint): Expression {
  if (value >= 0n) {
    return { type: "literal", value: Number(value), raw: value.toString() };
  }
  const magnitude = -value;
  return {
    type: "unaryOp",
    op: "-",
    operand: {
      type: "literal",
      value: Number(magnitude),
      raw: magnitude.toString(),
    },
  };
}

function floatLiteralExpr(value: number): Expression {
  if (Object.is(value, -0)) return { type: "literal", value: -0, raw: "-0.0" };
  const serialized = JSON.stringify(value);
  let raw = serialized;
  if (!serialized.includes(".") && !serialized.includes("e") && !serialized.includes("E")) {
    raw = `${serialized}.0`;
  }
  return { type: "literal", value, raw };
}

function bytesLiteralRaw(data: Uint8Array): string {
  let inner = "";
  for (const byte of data) {
    inner += `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return `b'${inner}'`;
}

export function rulesScalarExpression(value: RulesScalar): Expression {
  if (typeof value === "bigint") return int64LiteralExpr(value);
  if (value instanceof RulesFloat) return floatLiteralExpr(value.value);
  if (value instanceof Path) {
    return { type: "pathLiteral", raw: value.toString(), segments: [...value.segments] };
  }
  if (value instanceof Reference) {
    return {
      type: "pathLiteral",
      raw: value.toPath().toString(),
      segments: [...value.segments],
      isReference: true,
    };
  }
  if (value instanceof Bytes) {
    return { type: "literal", value: value.data, raw: bytesLiteralRaw(value.data) };
  }
  if (value instanceof LatLng) {
    return {
      type: "methodCall",
      object: { type: "identifier", name: "latlng" },
      method: "value",
      args: [floatLiteralExpr(value.lat), floatLiteralExpr(value.lng)],
    };
  }
  if (value instanceof Timestamp) {
    const baseMillis: Expression = {
      type: "methodCall",
      object: { type: "identifier", name: "timestamp" },
      method: "value",
      args: [int64LiteralExpr(BigInt(value.seconds) * 1000n)],
    };
    if (value.nanos === 0) return baseMillis;
    const nanosOffset: Expression = {
      type: "methodCall",
      object: { type: "identifier", name: "duration" },
      method: "value",
      args: [int64LiteralExpr(BigInt(value.nanos)), literal("ns")],
    };
    return { type: "binaryOp", op: "+", left: baseMillis, right: nanosOffset };
  }
  if (value instanceof Duration) {
    const secsPart: Expression = {
      type: "methodCall",
      object: { type: "identifier", name: "duration" },
      method: "value",
      args: [int64LiteralExpr(BigInt(value.seconds)), literal("s")],
    };
    if (value.nanos === 0) return secsPart;
    const nanosPart: Expression = {
      type: "methodCall",
      object: { type: "identifier", name: "duration" },
      method: "value",
      args: [int64LiteralExpr(BigInt(value.nanos)), literal("ns")],
    };
    return { type: "binaryOp", op: "+", left: secsPart, right: nanosPart };
  }
  return literal(value);
}

/**
 * Runtime Rules scalar representations that a Firestore `==` filter operand
 * can match in a stored document via cross-type numeric comparison.
 */
export function expandEqualityDomainScalars(value: unknown): RulesScalar[] | undefined {
  const strict = normalizeStrictQueryScalar(value);
  if (strict === undefined) return undefined;
  if (typeof strict === "number") {
    if (strict === 0) return [0, new RulesFloat(0), new RulesFloat(-0)];
    return [strict, new RulesFloat(strict)];
  }
  if (strict instanceof RulesFloat) {
    const num = strict.value;
    if (num === 0) return [0, new RulesFloat(0), new RulesFloat(-0)];
    if (isHostIntNumber(num)) return [num, new RulesFloat(num)];
    if (isUnsafeInt64Number(num)) return [strict, BigInt(num)];
    return [strict];
  }
  return [strict];
}
