/** Reduce query-guaranteed facts to a candidate-independent residual condition.
 * Every finite alternative must pass. Unknown predicates are never evaluated
 * against a fabricated partial document; only positive OR branches can omit them.
 */
import type { Expression, FunctionDef } from "../grammar/FirestoreAST.js";
import type { SimulationContext } from "./evaluation-context.js";
import { evaluate, requireBoolean } from "./evaluator.js";
import {
  attachOrBudgetStep,
  getOrBudgetSteps,
  projectWorstCaseBudgetExpr,
} from "./list-proof-budget.js";
import { analyzeListRulePathInvariance } from "./list-rule-path-proof.js";
import {
  getValidFunctionLexicalScope,
  type FunctionScopeBindings,
} from "./match-resolution.js";
import type { QueryConstraints } from "./query-proof.js";
import {
  callsResolveInOuterScope,
  dataFieldPath,
  inlineFunctionsInExpr,
  inlineIfNeeded,
  isProvablyDocIndependent,
  isRequestAuthUid,
  lexicalCaptureLiteralBindings,
  substituteIdentifiers,
} from "./query-proof-scope.js";
import { hostNumber, inInt64, isHostIntNumber } from "./rules-int.js";
import { listElementsEqual, rulesValuesEqual } from "./value-equality.js";
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

export const isScalar = (value: unknown): value is Scalar =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value)) ||
  isRulesWrapperScalar(value);

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

export function isQueryProofScalar(value: unknown): value is RulesScalar {
  return normalizeQueryConstraintScalar(value) !== undefined;
}

export interface FormatQueryScalarOptions {
  readonly uidExpression?: string;
  readonly dynamicExpression?: string;
}

function quoteSingleJsString(raw: string): string {
  return `'${raw
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")}'`;
}

function escapeTemplateChunk(raw: string): string {
  return raw
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
}

function formatPathSegmentForRemediation(
  seg: string,
  uidExpr: string,
  dynamicExpr?: string,
): string {
  if (seg === "__pyric_synth_uid__") return uidExpr;
  const claimMatch = /^__pyric_claim_(.+)__$/.exec(seg);
  if (claimMatch) return dynamicExpr ?? `<${claimMatch[1]}>`;
  const tokenMatch = /^__pyric_(?:seg|var|param)_(.+)__$/.exec(seg);
  if (tokenMatch) return dynamicExpr ?? `<${tokenMatch[1]}>`;
  if (seg.startsWith("__pyric_")) return dynamicExpr ?? "<id>";
  if (seg.includes("__pyric_synth_uid__")) {
    const chunks = seg.split("__pyric_synth_uid__").map(escapeTemplateChunk);
    return `\`${chunks.join(`\${${uidExpr}}`)}\``;
  }
  return quoteSingleJsString(seg);
}

function formatDocPathSegmentsForRemediation(
  databaseId: string,
  relSegments: readonly string[],
  uidExpr: string,
  dynamicExpr?: string,
): string {
  const dbArg =
    databaseId === "(default)"
      ? "db"
      : `getFirestore(app, ${formatPathSegmentForRemediation(databaseId, uidExpr, dynamicExpr)})`;
  const segArgs = relSegments.map((s) =>
    formatPathSegmentForRemediation(s, uidExpr, dynamicExpr),
  );
  return `doc(${[dbArg, ...segArgs].join(", ")})`;
}

export function formatQueryScalarForRemediation(
  value: unknown,
  options?: FormatQueryScalarOptions,
): string {
  const uidExpr = options?.uidExpression ?? "<uid>";
  const dynamicExpr = options?.dynamicExpression;
  if (typeof value === "string") {
    if (value === "__pyric_synth_uid__") return uidExpr;
    const claimMatch = /^__pyric_claim_(.+)__$/.exec(value);
    if (claimMatch) return dynamicExpr ?? `<${claimMatch[1]}>`;
    if (value.startsWith("__pyric_")) return dynamicExpr ?? "<value>";
    if (value.includes("__pyric_synth_uid__")) {
      const chunks = value.split("__pyric_synth_uid__").map(escapeTemplateChunk);
      return `\`${chunks.join(`\${${uidExpr}}`)}\``;
    }
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (Object.is(value, -0)) return "-0";
    return Number.isFinite(value) ? JSON.stringify(value) : String(value);
  }
  if (typeof value === "bigint") {
    const asNum = Number(value);
    return Number.isSafeInteger(asNum) ? String(asNum) : `${value.toString()}n`;
  }
  if (value instanceof RulesFloat) {
    if (Object.is(value.value, -0)) return "-0";
    return Number.isFinite(value.value) ? JSON.stringify(value.value) : String(value.value);
  }
  if (typeof value === "boolean" || value === null) {
    return JSON.stringify(value);
  }
  if (value instanceof Reference) {
    const rel = value.path.length > 0 ? value.path.split("/") : [];
    if (rel.length >= 2 && rel.length % 2 === 0) {
      return formatDocPathSegmentsForRemediation(value.databaseId, rel, uidExpr, dynamicExpr);
    }
    const rendered = rel.map((s) =>
      s === "__pyric_synth_uid__" ? uidExpr : s.replace(/__pyric_synth_uid__/g, uidExpr),
    );
    return quoteSingleJsString(rendered.join("/"));
  }
  if (value instanceof Path) {
    const segs = value.segments;
    if (
      segs.length >= 5 &&
      segs[0] === "databases" &&
      segs[2] === "documents" &&
      (segs.length - 3) % 2 === 0
    ) {
      return formatDocPathSegmentsForRemediation(
        segs[1]!,
        segs.slice(3),
        uidExpr,
        dynamicExpr,
      );
    }
    const rendered = segs.map((s) =>
      s === "__pyric_synth_uid__" ? uidExpr : s.replace(/__pyric_synth_uid__/g, uidExpr),
    );
    return `path(${quoteSingleJsString(`/${rendered.join("/")}`)})`;
  }
  if (value instanceof Timestamp) {
    if (value.nanos % 1_000_000 === 0) {
      const ms = value.seconds * 1000 + value.nanos / 1_000_000;
      const date = new Date(ms);
      if (Number.isFinite(date.getTime())) {
        return `Timestamp.fromDate(new Date(${quoteSingleJsString(date.toISOString())}))`;
      }
    }
    return `new Timestamp(${value.seconds}, ${value.nanos})`;
  }
  if (value instanceof Bytes) {
    return `Bytes.fromUint8Array(new Uint8Array([${Array.from(value.data).join(", ")}]))`;
  }
  if (value instanceof LatLng) {
    return `new GeoPoint(${value.lat}, ${value.lng})`;
  }
  if (value instanceof Duration) {
    if (value.nanos === 0) {
      return `duration.value(${value.seconds}, 's')`;
    }
    return `duration.time(0, 0, ${value.seconds}, ${value.nanos})`;
  }
  return JSON.stringify(value);
}

export function replaceTokenInQueryScalar<T extends RulesScalar>(
  value: T,
  fromToken: string,
  toValue: string,
): T | string {
  if (value === fromToken) return toValue;
  if (typeof value === "string" && value.includes(fromToken)) {
    return value.split(fromToken).join(toValue);
  }
  if (value instanceof Path && value.segments.some((seg) => seg.includes(fromToken))) {
    const nextSegments = value.segments.map((seg) => seg.split(fromToken).join(toValue));
    const nextBindings: Record<string, string> = {};
    for (const [k, v] of Object.entries(value.bindings)) {
      Object.defineProperty(nextBindings, k, {
        value: v.split(fromToken).join(toValue),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return new Path(nextSegments, nextBindings) as T;
  }
  if (
    value instanceof Reference &&
    (value.path.includes(fromToken) || value.databaseId.includes(fromToken))
  ) {
    return new Reference(
      value.path.split(fromToken).join(toValue),
      value.databaseId.split(fromToken).join(toValue),
    ) as T;
  }
  return value;
}

type PrimitiveScalar = string | number | boolean | null;

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

const literal = (value: PrimitiveScalar): Expression => ({
  type: "literal",
  value,
  raw: literalRaw(value),
});

function sameQueryDomainScalar(a: Scalar, b: Scalar): boolean {
  if (typeof a === "number" && typeof b === "number") {
    return Object.is(a, b);
  }
  return listElementsEqual(toRulesQueryScalar(a), toRulesQueryScalar(b));
}

export function queryProofScalarsEqual(a: unknown, b: unknown): boolean {
  const sa = normalizeQueryConstraintScalar(a);
  const sb = normalizeQueryConstraintScalar(b);
  if (sa === undefined || sb === undefined) return false;
  return sameQueryDomainScalar(sa, sb);
}

/**
 * Collect the list of per-filter scalar sets (`==` or finite `in`) for each
 * constrained field in the query conjunction.
 */
export function computeFieldFilterSets(
  constraints: QueryConstraints,
): Map<string, Scalar[][]> {
  const filterSets = new Map<string, Scalar[][]>();
  for (const filter of constraints.where ?? []) {
    let filterValues: Scalar[] | undefined;
    if (filter.op === "==" && !Array.isArray(filter.value)) {
      const normalized = normalizeQueryConstraintScalar(filter.value);
      if (normalized !== undefined) {
        filterValues = normalized === 0 ? [0, -0] : [normalized];
      }
    } else if (
      filter.op === "in" &&
      Array.isArray(filter.value) &&
      filter.value.length > 0 &&
      filter.value.length <= 30
    ) {
      const deduped: Scalar[] = [];
      let allValid = true;
      for (const item of filter.value) {
        const normalized = normalizeQueryConstraintScalar(item);
        if (normalized === undefined) {
          allValid = false;
          break;
        }
        if (!deduped.some((existing) => sameQueryDomainScalar(existing, normalized))) {
          deduped.push(normalized);
        }
      }
      if (allValid) {
        filterValues = deduped;
      }
    }
    if (filterValues === undefined) continue;
    const existing = filterSets.get(filter.field);
    if (existing === undefined) {
      filterSets.set(filter.field, [filterValues]);
    } else {
      existing.push(filterValues);
    }
  }
  return filterSets;
}

/**
 * Compute the effective scalar domain for each constrained field by intersecting
 * all `==` and finite `in` filters on the same field (order-independent).
 * An empty array `[]` indicates contradictory equality/`in` filters on that field.
 */
export function computeWhereDomains(
  constraints: QueryConstraints,
): Map<string, Scalar[]> {
  const domains = new Map<string, Scalar[]>();
  for (const [field, sets] of computeFieldFilterSets(constraints)) {
    let intersected = sets[0]!;
    for (let i = 1; i < sets.length; i++) {
      const next = sets[i]!;
      intersected = intersected.filter((v) =>
        next.some((candidate) => sameQueryDomainScalar(candidate, v)),
      );
    }
    domains.set(field, intersected);
  }
  return domains;
}

function join(left: Expression, right: Expression, op: string): Expression {
  return { type: "binaryOp", op, left, right };
}

function not(operand: Expression): Expression {
  return { type: "unaryOp", op: "!", operand };
}

function isRulesScalar(value: unknown): value is RulesScalar {
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

export function toRulesQueryScalar(
  value: Scalar,
): Exclude<Scalar, number> | number | RulesFloat {
  return typeof value === "number" ? hostNumber(value) : value;
}

export function isSafePrecisionRulesScalar(value: RulesScalar): boolean {
  if (typeof value === "bigint") {
    return (
      value >= BigInt(Number.MIN_SAFE_INTEGER) &&
      value <= BigInt(Number.MAX_SAFE_INTEGER)
    );
  }
  return true;
}

export function rulesScalarToJsScalar(value: RulesScalar): Scalar {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof RulesFloat) return value.value;
  return value;
}

function substituteRequestAuthUid(expr: Expression, authUid: string): Expression {
  if (isRequestAuthUid(expr)) return literal(authUid);
  const sub = (child: Expression): Expression => substituteRequestAuthUid(child, authUid);
  switch (expr.type) {
    case "literal":
    case "identifier":
      return expr;
    case "unaryOp":
      return { ...expr, operand: sub(expr.operand) };
    case "binaryOp":
      return { ...expr, left: sub(expr.left), right: sub(expr.right) };
    case "ternary":
      return {
        ...expr,
        condition: sub(expr.condition),
        consequent: sub(expr.consequent),
        alternate: sub(expr.alternate),
      };
    case "inExpr":
      return { ...expr, element: sub(expr.element), collection: sub(expr.collection) };
    case "isExpr":
      return { ...expr, value: sub(expr.value) };
    case "listLiteral":
      return { ...expr, elements: expr.elements.map(sub) };
    case "mapLiteral":
      return {
        ...expr,
        entries: expr.entries.map((entry) => ({ key: sub(entry.key), value: sub(entry.value) })),
      };
    case "memberAccess":
      return { ...expr, object: sub(expr.object) };
    case "bracketAccess":
      return { ...expr, object: sub(expr.object), index: sub(expr.index) };
    case "sliceAccess":
      return { ...expr, object: sub(expr.object), start: sub(expr.start), end: sub(expr.end) };
    case "pathLiteral":
      return {
        ...expr,
        segments: expr.segments.map((seg) => (typeof seg === "string" ? seg : sub(seg))),
      };
    case "methodCall":
      return { ...expr, object: sub(expr.object), args: expr.args.map(sub) };
    case "functionCall":
      return { ...expr, args: expr.args.map(sub) };
  }
}

export function resolveStaticRulesOperand(
  expr: Expression,
  userFunctions: ReadonlyMap<string, FunctionDef>,
  authUid?: string,
  pathVariables?: Readonly<Record<string, string>>,
  functionScopes?: ReadonlyMap<FunctionDef, FunctionScopeBindings>,
): RulesScalar | undefined {
  const inlined = inlineIfNeeded(expr, userFunctions, undefined, functionScopes);
  if (!inlined) return undefined;
  if (
    inlined.type === "identifier" &&
    pathVariables !== undefined &&
    Object.hasOwn(pathVariables, inlined.name)
  ) {
    return pathVariables[inlined.name];
  }
  if (isRequestAuthUid(inlined)) {
    return authUid;
  }
  let candidate = inlined;
  if (pathVariables !== undefined) {
    const pathVarEntries = Object.entries(pathVariables);
    if (pathVarEntries.length > 0) {
      const bindings = new Map<string, Expression>(
        pathVarEntries.map(([name, val]) => [name, literal(val)]),
      );
      candidate = substituteIdentifiers(candidate, bindings);
    }
  }
  if (authUid !== undefined) {
    candidate = substituteRequestAuthUid(candidate, authUid);
  }
  if (isClosedConstantExpr(candidate, userFunctions)) {
    const value = evalConstValue(candidate, userFunctions);
    if (isRulesScalar(value)) return value;
    return undefined;
  }
  return undefined;
}

function resolveGuaranteedArrayContains(
  arrayField: string,
  element: Expression,
  constraints: QueryConstraints,
  userFunctions: ReadonlyMap<string, FunctionDef>,
  authUid?: string,
  pathVariables?: Readonly<Record<string, string>>,
  functionScopes?: ReadonlyMap<FunctionDef, FunctionScopeBindings>,
): RulesScalar | undefined {
  const ruleVal = resolveStaticRulesOperand(
    element,
    userFunctions,
    authUid,
    pathVariables,
    functionScopes,
  );
  if (ruleVal === undefined) return undefined;
  const matched = (constraints.where ?? []).some((filter) => {
    if (filter.field !== arrayField || filter.op !== "array-contains" || Array.isArray(filter.value)) {
      return false;
    }
    const normalized = normalizeQueryConstraintScalar(filter.value);
    return normalized !== undefined && listElementsEqual(ruleVal, toRulesQueryScalar(normalized));
  });
  return matched ? ruleVal : undefined;
}

function isGuaranteedByArrayContains(
  arrayField: string,
  element: Expression,
  constraints: QueryConstraints,
  userFunctions: ReadonlyMap<string, FunctionDef>,
  authUid?: string,
  pathVariables?: Readonly<Record<string, string>>,
  functionScopes?: ReadonlyMap<FunctionDef, FunctionScopeBindings>,
): boolean {
  return (
    resolveGuaranteedArrayContains(
      arrayField,
      element,
      constraints,
      userFunctions,
      authUid,
      pathVariables,
      functionScopes,
    ) !== undefined
  );
}

function isEqualityImpliedByFilterSet(
  left: Expression,
  right: Expression,
  filterSetsByField: ReadonlyMap<string, Scalar[][]>,
  userFunctions: ReadonlyMap<string, FunctionDef>,
  authUid?: string,
  pathVariables?: Readonly<Record<string, string>>,
  functionScopes?: ReadonlyMap<FunctionDef, FunctionScopeBindings>,
): boolean {
  const checkSide = (dataExpr: Expression, valueExpr: Expression): boolean => {
    const field = dataFieldPath(dataExpr);
    if (field === null) return false;
    const sets = filterSetsByField.get(field);
    if (!sets) return false;
    const target = resolveStaticRulesOperand(
      valueExpr,
      userFunctions,
      authUid,
      pathVariables,
      functionScopes,
    );
    if (target === undefined || !isSafePrecisionRulesScalar(target)) return false;
    return sets.some(
      (set) =>
        set.length > 0 &&
        set.every((v) => rulesValuesEqual(toRulesQueryScalar(v), target)),
    );
  };
  return checkSide(left, right) || checkSide(right, left);
}

function isInImpliedByFilterSet(
  element: Expression,
  collection: Expression,
  filterSetsByField: ReadonlyMap<string, Scalar[][]>,
  userFunctions: ReadonlyMap<string, FunctionDef>,
  authUid?: string,
  pathVariables?: Readonly<Record<string, string>>,
  functionScopes?: ReadonlyMap<FunctionDef, FunctionScopeBindings>,
): boolean {
  const field = dataFieldPath(element);
  if (field === null || collection.type !== "listLiteral") return false;
  const sets = filterSetsByField.get(field);
  if (!sets) return false;
  const allowedValues: RulesScalar[] = [];
  for (const el of collection.elements) {
    const resolved = resolveStaticRulesOperand(
      el,
      userFunctions,
      authUid,
      pathVariables,
      functionScopes,
    );
    if (resolved === undefined) return false;
    allowedValues.push(resolved);
  }
  return sets.some(
    (set) =>
      set.length > 0 &&
      set.every((v) => {
        const qv = toRulesQueryScalar(v);
        return allowedValues.some((allowed) => listElementsEqual(allowed, qv));
      }),
  );
}

const CONST_ERROR = Symbol("constError");
const LOOKUP_FUNCTIONS: ReadonlySet<string> = new Set([
  "get",
  "exists",
  "getAfter",
  "existsAfter",
]);
const BUILTIN_NAMESPACE_METHODS: Readonly<Record<string, ReadonlySet<string>>> = {
  math: new Set(["abs", "ceil", "floor", "round", "sqrt", "pow", "isNaN", "isInfinite"]),
  timestamp: new Set(["date", "value"]),
  duration: new Set(["value", "time", "abs"]),
  latlng: new Set(["value"]),
  hashing: new Set(["md5", "sha256", "crc32", "crc32c"]),
};
const EMPTY_PATH = new Path([]);
const CLOSED_CONST_CTX: SimulationContext = {
  request: {
    auth: null,
    resource: { data: {} },
    method: "list",
    path: EMPTY_PATH,
    time: Timestamp.fromMillis(0),
  },
  resource: null,
  mockDocuments: new Map(),
  pathVariables: Object.create(null) as Record<string, string>,
  functions: new Map(),
  database: "(default)",
  afterStatePath: EMPTY_PATH,
  afterState: null,
  existsAfter: false,
};

export function isClosedConstantExpr(
  expr: Expression,
  userFunctions: ReadonlyMap<string, FunctionDef> = new Map(),
): boolean {
  switch (expr.type) {
    case "literal":
      return true;
    case "identifier":
      return false;
    case "unaryOp":
      return isClosedConstantExpr(expr.operand, userFunctions);
    case "binaryOp":
      return (
        isClosedConstantExpr(expr.left, userFunctions) &&
        isClosedConstantExpr(expr.right, userFunctions)
      );
    case "ternary":
      return (
        isClosedConstantExpr(expr.condition, userFunctions) &&
        isClosedConstantExpr(expr.consequent, userFunctions) &&
        isClosedConstantExpr(expr.alternate, userFunctions)
      );
    case "inExpr":
      return (
        isClosedConstantExpr(expr.element, userFunctions) &&
        isClosedConstantExpr(expr.collection, userFunctions)
      );
    case "isExpr":
      return isClosedConstantExpr(expr.value, userFunctions);
    case "listLiteral":
      return expr.elements.every((el) => isClosedConstantExpr(el, userFunctions));
    case "mapLiteral":
      return expr.entries.every(
        (entry) =>
          isClosedConstantExpr(entry.key, userFunctions) &&
          isClosedConstantExpr(entry.value, userFunctions),
      );
    case "memberAccess":
      return isClosedConstantExpr(expr.object, userFunctions);
    case "bracketAccess":
      return (
        isClosedConstantExpr(expr.object, userFunctions) &&
        isClosedConstantExpr(expr.index, userFunctions)
      );
    case "sliceAccess":
      return (
        isClosedConstantExpr(expr.object, userFunctions) &&
        isClosedConstantExpr(expr.start, userFunctions) &&
        isClosedConstantExpr(expr.end, userFunctions)
      );
    case "pathLiteral":
      return expr.segments.every(
        (seg) => typeof seg === "string" || isClosedConstantExpr(seg, userFunctions),
      );
    case "methodCall": {
      const receiverClosed =
        isClosedConstantExpr(expr.object, userFunctions) ||
        (expr.object.type === "identifier" &&
          BUILTIN_NAMESPACE_METHODS[expr.object.name]?.has(expr.method) === true);
      return receiverClosed && expr.args.every((arg) => isClosedConstantExpr(arg, userFunctions));
    }
    case "functionCall":
      return (
        !LOOKUP_FUNCTIONS.has(expr.name) &&
        !userFunctions.has(expr.name) &&
        expr.args.every((arg) => isClosedConstantExpr(arg, userFunctions))
      );
  }
}

export function evalConstValue(
  expr: Expression,
  userFunctions: ReadonlyMap<string, FunctionDef> = new Map(),
): unknown {
  const inlined = inlineIfNeeded(expr, userFunctions);
  if (!inlined || !isClosedConstantExpr(inlined, userFunctions)) return undefined;
  try {
    const val = evaluate(inlined, CLOSED_CONST_CTX);
    if (typeof val === "bigint" && !inInt64(val)) return CONST_ERROR;
    return val;
  } catch {
    return CONST_ERROR;
  }
}

function isConstRefuted(
  expr: Expression,
  userFunctions: ReadonlyMap<string, FunctionDef>,
): boolean {
  const inlined = inlineIfNeeded(expr, userFunctions);
  if (!inlined || !isClosedConstantExpr(inlined, userFunctions)) return false;
  try {
    const val = evaluate(inlined, CLOSED_CONST_CTX);
    return !requireBoolean(val, inlined);
  } catch {
    return true;
  }
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

function rulesScalarExpression(value: RulesScalar): Expression {
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
    const baseMillis = {
      type: "methodCall" as const,
      object: { type: "identifier" as const, name: "timestamp" },
      method: "value",
      args: [int64LiteralExpr(BigInt(value.seconds) * 1000n)],
    };
    if (value.nanos === 0) return baseMillis;
    const nanosOffset = {
      type: "methodCall" as const,
      object: { type: "identifier" as const, name: "duration" },
      method: "value",
      args: [int64LiteralExpr(BigInt(value.nanos)), literal("ns")],
    };
    return join(baseMillis, nanosOffset, "+");
  }
  if (value instanceof Duration) {
    const secsPart = {
      type: "methodCall" as const,
      object: { type: "identifier" as const, name: "duration" },
      method: "value",
      args: [int64LiteralExpr(BigInt(value.seconds)), literal("s")],
    };
    if (value.nanos === 0) return secsPart;
    const nanosPart = {
      type: "methodCall" as const,
      object: { type: "identifier" as const, name: "duration" },
      method: "value",
      args: [int64LiteralExpr(BigInt(value.nanos)), literal("ns")],
    };
    return join(secsPart, nanosPart, "+");
  }
  return literal(value);
}

function pinCandidateExpressions(value: Scalar): Expression[] {
  if (isRulesWrapperScalar(value)) {
    return [rulesScalarExpression(value)];
  }
  const primary = literal(value);
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    !Number.isSafeInteger(value) &&
    value >= -(2 ** 63) &&
    value < 2 ** 63
  ) {
    return [primary, int64LiteralExpr(BigInt(value))];
  }
  return [primary];
}

export interface PathInvarianceContext {
  readonly candidateVariables: ReadonlySet<string>;
  readonly ambiguousNames: ReadonlySet<string>;
}

export function queryResidual(
  condition: Expression,
  constraints: QueryConstraints,
  functions: ReadonlyMap<string, FunctionDef>,
  authUid?: string,
  pathVariables?: Readonly<Record<string, string>>,
  functionScopes?: ReadonlyMap<FunctionDef, FunctionScopeBindings>,
  pathInvariance?: PathInvarianceContext,
): { condition: Expression; partial: boolean } | undefined {
  let partial = false;
  const filterSetsByField = computeFieldFilterSets(constraints);
  const domains = computeWhereDomains(constraints);
  const nonEmptyDomains = new Map<string, Expression[]>();
  for (const [name, values] of domains) {
    if (values.length > 0) {
      nonEmptyDomains.set(name, values.flatMap(pinCandidateExpressions));
    }
  }
  let variants: Map<string, Expression>[] = [new Map()];
  for (const [name, pinExprs] of nonEmptyDomains) {
    if (variants.length * pinExprs.length > 30) return undefined;
    variants = variants.flatMap((variant) =>
      pinExprs.map((pinExpr) => new Map([...variant, [name, pinExpr]])),
    );
  }
  const residuals: Expression[] = [];
  let variantIndex = 0;
  for (const pins of variants) {
    const includeBudgetBranches = variantIndex++ === 0;
    let budget = 2000;
    function rewrite(
      expr: Expression,
      currentFunctions: ReadonlyMap<string, FunctionDef> = functions,
      visiting: ReadonlySet<FunctionDef> = new Set(),
    ): Expression {
      if (--budget < 0) throw new Error("proof expansion budget");
      const directKey = dataFieldPath(expr);
      if (directKey !== null && pins.has(directKey)) {
        return pins.get(directKey)!;
      }
      if (expr.type === "functionCall" && currentFunctions.has(expr.name)) {
        // Leave already-independent helpers intact to preserve evaluator scoping/budgets,
        // provided every function call in `expr` resolves to the same FunctionDef in the
        // outer rule scope `functions` as in `currentFunctions`.
        if (
          callsResolveInOuterScope(expr, currentFunctions, functions) &&
          isProvablyDocIndependent(expr, currentFunctions)
        ) {
          return expr;
        }
        const fn = currentFunctions.get(expr.name)!;
        if (visiting.has(fn)) throw new Error("recursive proof helper");
        if (fn.parameters.length !== expr.args.length)
          throw new Error("proof arity");
        const nextFunctions = getValidFunctionLexicalScope(fn, currentFunctions);
        if (!nextFunctions) throw new Error("lexically invalid proof helper");
        const rewrittenArgs = expr.args.map((arg) => {
          const rewrittenArg = rewrite(arg, currentFunctions, visiting);
          if (
            currentFunctions !== nextFunctions &&
            !callsResolveInOuterScope(rewrittenArg, currentFunctions, nextFunctions)
          ) {
            const expandedArg = inlineFunctionsInExpr(rewrittenArg, currentFunctions, visiting, functionScopes);
            if (
              !expandedArg ||
              !callsResolveInOuterScope(expandedArg, currentFunctions, nextFunctions) ||
              !callsResolveInOuterScope(expandedArg, currentFunctions, functions)
            ) {
              throw new Error("cross-scope argument expansion");
            }
            return expandedArg;
          }
          return rewrittenArg;
        });
        const bindings = lexicalCaptureLiteralBindings(fn, functionScopes);
        for (let i = 0; i < fn.parameters.length; i++) {
          bindings.set(fn.parameters[i]!, rewrittenArgs[i]!);
        }
        const nextVisiting = new Set([...visiting, fn]);
        for (const binding of fn.lets)
          bindings.set(
            binding.name,
            rewrite(
              substituteIdentifiers(binding.value, bindings),
              nextFunctions,
              nextVisiting,
            ),
          );
        return rewrite(
          substituteIdentifiers(fn.body, bindings),
          nextFunctions,
          nextVisiting,
        );
      }
      if (expr.type === "inExpr") {
        const element = rewrite(expr.element, currentFunctions, visiting);
        const collection = rewrite(expr.collection, currentFunctions, visiting);
        const arrayField = dataFieldPath(collection);
        if (
          arrayField !== null &&
          isGuaranteedByArrayContains(
            arrayField,
            element,
            constraints,
            currentFunctions,
            authUid,
            pathVariables,
            functionScopes,
          )
        ) {
          return literal(true);
        }
        if (
          isInImpliedByFilterSet(
            element,
            collection,
            filterSetsByField,
            currentFunctions,
            authUid,
            pathVariables,
            functionScopes,
          )
        ) {
          return literal(true);
        }
        return {
          ...expr,
          element,
          collection,
        };
      }
      const sub = (value: Expression) => rewrite(value, currentFunctions, visiting);
      switch (expr.type) {
        case "literal":
        case "identifier":
          return expr;
        case "memberAccess": {
          const rewritten: Expression = { ...expr, object: sub(expr.object) };
          const key = dataFieldPath(rewritten);
          if (key !== null && pins.has(key)) return pins.get(key)!;
          return rewritten;
        }
        case "bracketAccess": {
          const rewritten: Expression = {
            ...expr,
            object: sub(expr.object),
            index: sub(expr.index),
          };
          const key = dataFieldPath(rewritten);
          if (key !== null && pins.has(key)) return pins.get(key)!;
          return rewritten;
        }
        case "sliceAccess":
          return {
            ...expr,
            object: sub(expr.object),
            start: sub(expr.start),
            end: sub(expr.end),
          };
        case "binaryOp": {
          const left = sub(expr.left);
          const right = sub(expr.right);
          if (
            expr.op === "==" &&
            isEqualityImpliedByFilterSet(
              left,
              right,
              filterSetsByField,
              currentFunctions,
              authUid,
              pathVariables,
              functionScopes,
            )
          ) {
            return literal(true);
          }
          return { ...expr, left, right };
        }
        case "unaryOp":
          return { ...expr, operand: sub(expr.operand) };
        case "ternary":
          return {
            ...expr,
            condition: sub(expr.condition),
            consequent: sub(expr.consequent),
            alternate: sub(expr.alternate),
          };
        case "isExpr":
          return { ...expr, value: sub(expr.value) };
        case "methodCall": {
          const object = sub(expr.object);
          const args = expr.args.map(sub);
          const arrayField = dataFieldPath(object);
          if (
            arrayField !== null &&
            args.length === 1 &&
            args[0]!.type === "listLiteral" &&
            args[0]!.elements.every((el) => isProvablyDocIndependent(el, currentFunctions))
          ) {
            const elements = args[0]!.elements;
            if (expr.method === "hasAny") {
              for (const el of elements) {
                const matched = resolveGuaranteedArrayContains(
                  arrayField,
                  el,
                  constraints,
                  currentFunctions,
                  authUid,
                  pathVariables,
                  functionScopes,
                );
                if (matched !== undefined) {
                  return {
                    ...expr,
                    object: { type: "listLiteral", elements: [rulesScalarExpression(matched)] },
                    args,
                  };
                }
              }
            }
            if (expr.method === "hasAll" && elements.length > 0) {
              const matchedElements: Expression[] = [];
              let allMatched = true;
              for (const el of elements) {
                const matched = resolveGuaranteedArrayContains(
                  arrayField,
                  el,
                  constraints,
                  currentFunctions,
                  authUid,
                  pathVariables,
                  functionScopes,
                );
                if (matched === undefined) {
                  allMatched = false;
                  break;
                }
                matchedElements.push(rulesScalarExpression(matched));
              }
              if (allMatched) {
                return {
                  ...expr,
                  object: { type: "listLiteral", elements: matchedElements },
                  args,
                };
              }
            }
          }
          return {
            ...expr,
            object,
            args,
          };
        }
        case "functionCall":
          if (currentFunctions !== functions && functions.has(expr.name)) {
            throw new Error("shadowed builtin");
          }
          return { ...expr, args: expr.args.map(sub) };
        case "listLiteral":
          return { ...expr, elements: expr.elements.map(sub) };
        case "mapLiteral":
          return {
            ...expr,
            entries: expr.entries.map((entry) => ({
              key: sub(entry.key),
              value: sub(entry.value),
            })),
          };
        case "pathLiteral":
          return {
            ...expr,
            segments: expr.segments.map((segment) => {
              if (typeof segment === "string") return segment;
              return sub(segment);
            }),
          };
      }
    }
    // A sufficient condition, never a guessed representative. Unknown branches
    // may be discarded only in monotone positive OR (including De Morgan duals),
    // never under an unpushed NOT or ternary.
    function sufficient(expr: Expression): Expression | undefined {
      if (expr.type === "unaryOp" && expr.op === "!") {
        const inner = expr.operand;
        if (inner.type === "binaryOp" && inner.op === "&&") {
          return sufficient(join(not(inner.left), not(inner.right), "||"));
        }
        if (inner.type === "binaryOp" && inner.op === "||") {
          return sufficient(join(not(inner.left), not(inner.right), "&&"));
        }
        if (inner.type === "unaryOp" && inner.op === "!") {
          const sub = sufficient(inner.operand);
          if (!sub) return undefined;
          return not(not(sub));
        }
        if (inner.type === "ternary" && isClosedConstantExpr(inner.condition, functions)) {
          return sufficient({
            ...inner,
            consequent: not(inner.consequent),
            alternate: not(inner.alternate),
          });
        }
      }
      if (expr.type === "ternary" && isClosedConstantExpr(expr.condition, functions)) {
        let cond: boolean;
        try {
          cond = requireBoolean(evaluate(expr.condition, CLOSED_CONST_CTX), expr.condition);
        } catch {
          return undefined;
        }
        return cond ? sufficient(expr.consequent) : sufficient(expr.alternate);
      }
      if (expr.type === "binaryOp" && (expr.op === "&&" || expr.op === "||")) {
        const left = sufficient(expr.left),
          right = sufficient(expr.right);
        if (left && right) {
          const combined = join(left, right, expr.op);
          return isConstRefuted(combined, functions) ? undefined : combined;
        }
        if (expr.op === "||") {
          if (!left && !right) return undefined;
          partial = true;
          if (!includeBudgetBranches) return left ?? right;
          if (!left && right) {
            const projectedLeft = projectWorstCaseBudgetExpr(expr.left, {
              outerFunctions: functions,
              functionScopes,
              candidateVariables: pathInvariance?.candidateVariables,
              ambiguousNames: pathInvariance?.ambiguousNames,
              checkResourceDependence: true,
            }).expr;
            return attachOrBudgetStep(right, {
              operator: expr,
              side: "before",
              branch: projectedLeft,
            });
          }
          if (left && !right) {
            const projectedRight = projectWorstCaseBudgetExpr(expr.right, {
              outerFunctions: functions,
              functionScopes,
              candidateVariables: pathInvariance?.candidateVariables,
              ambiguousNames: pathInvariance?.ambiguousNames,
              checkResourceDependence: true,
            }).expr;
            return attachOrBudgetStep(left, {
              operator: expr,
              side: "after",
              branch: projectedRight,
            });
          }
        }
        return undefined;
      }
      if (
        isProvablyDocIndependent(expr, functions) &&
        (!pathInvariance ||
          analyzeListRulePathInvariance(
            expr,
            pathInvariance.candidateVariables,
            functions,
            pathInvariance.ambiguousNames,
            functionScopes,
          ).pathInvariant)
      ) {
        return isConstRefuted(expr, functions) ? undefined : expr;
      }
      return undefined;
    }
    try {
      const residual = sufficient(rewrite(condition));
      if (!residual) return undefined;
      residuals.push(residual);
    } catch {
      return undefined;
    }
  }
  let combinedCondition = residuals.reduce((left, right) => join(left, right, "&&"));
  const priorSteps = getOrBudgetSteps(condition);
  if (priorSteps && priorSteps.length > 0) {
    if (combinedCondition === condition) {
      combinedCondition = { ...combinedCondition };
    }
    for (let i = priorSteps.length - 1; i >= 0; i--) {
      const projectedPriorBranch = buildRuleBudgetCondition(
        priorSteps[i]!.branch,
        constraints,
        functions,
        functionScopes,
        pathInvariance,
      );
      combinedCondition = attachOrBudgetStep(combinedCondition, {
        ...priorSteps[i]!,
        branch: projectedPriorBranch,
      });
    }
  }
  return {
    condition: combinedCondition,
    partial,
  };
}

/**
 * Substitutes single-value query equality pins into an unprovable rule or
 * prior budget branch and projects unconstrained guards for worst-case
 * lookup/expression budget evaluation.
 */
export function buildRuleBudgetCondition(
  condition: Expression,
  constraints: QueryConstraints,
  functions: ReadonlyMap<string, FunctionDef>,
  functionScopes?: ReadonlyMap<FunctionDef, FunctionScopeBindings>,
  pathInvariance?: PathInvarianceContext,
): Expression {
  const singlePins = new Map<string, Expression>();
  for (const [field, values] of computeWhereDomains(constraints)) {
    if (values.length === 1) {
      const exprs = pinCandidateExpressions(values[0]!);
      if (exprs.length > 0) {
        singlePins.set(field, exprs[0]!);
      }
    }
  }

  let budget = 2000;
  const rewritePinned = (
    expr: Expression,
    currentFunctions: ReadonlyMap<string, FunctionDef> = functions,
    visiting: ReadonlySet<FunctionDef> = new Set(),
  ): Expression => {
    if (singlePins.size === 0 || --budget < 0) return expr;
    const priorSteps = getOrBudgetSteps(expr);
    if (priorSteps && priorSteps.length > 0) {
      const stripped: Expression = { ...expr };
      let target = rewritePinned(stripped, currentFunctions, visiting);
      const rewrittenSteps = priorSteps.map((step) => ({
        ...step,
        branch: rewritePinned(step.branch, currentFunctions, visiting),
      }));
      for (let i = rewrittenSteps.length - 1; i >= 0; i--) {
        target = attachOrBudgetStep(target, rewrittenSteps[i]!);
      }
      return target;
    }
    const directKey = dataFieldPath(expr);
    if (directKey !== null && singlePins.has(directKey)) {
      return singlePins.get(directKey)!;
    }
    if (expr.type === "functionCall" && currentFunctions.has(expr.name)) {
      if (
        callsResolveInOuterScope(expr, currentFunctions, functions) &&
        isProvablyDocIndependent(expr, currentFunctions)
      ) {
        return expr;
      }
      const fn = currentFunctions.get(expr.name)!;
      const nextFunctions = getValidFunctionLexicalScope(fn, currentFunctions);
      if (
        visiting.has(fn) ||
        fn.parameters.length !== expr.args.length ||
        !nextFunctions
      ) {
        return { ...expr, args: expr.args.map((arg) => rewritePinned(arg, currentFunctions, visiting)) };
      }
      const rewrittenArgs: Expression[] = [];
      let crossScopeFailed = false;
      for (const arg of expr.args) {
        const rewrittenArg = rewritePinned(arg, currentFunctions, visiting);
        if (
          currentFunctions !== nextFunctions &&
          !callsResolveInOuterScope(rewrittenArg, currentFunctions, nextFunctions)
        ) {
          const expandedArg = inlineFunctionsInExpr(rewrittenArg, currentFunctions, visiting, functionScopes);
          if (
            !expandedArg ||
            !callsResolveInOuterScope(expandedArg, currentFunctions, nextFunctions) ||
            !callsResolveInOuterScope(expandedArg, currentFunctions, functions)
          ) {
            crossScopeFailed = true;
            break;
          }
          rewrittenArgs.push(expandedArg);
        } else {
          rewrittenArgs.push(rewrittenArg);
        }
      }
      if (crossScopeFailed) {
        return { ...expr, args: expr.args.map((arg) => rewritePinned(arg, currentFunctions, visiting)) };
      }
      const bindings = lexicalCaptureLiteralBindings(fn, functionScopes);
      for (let i = 0; i < fn.parameters.length; i++) {
        bindings.set(fn.parameters[i]!, rewrittenArgs[i]!);
      }
      const nextVisiting = new Set([...visiting, fn]);
      for (const binding of fn.lets) {
        bindings.set(
          binding.name,
          rewritePinned(substituteIdentifiers(binding.value, bindings), nextFunctions, nextVisiting),
        );
      }
      return rewritePinned(substituteIdentifiers(fn.body, bindings), nextFunctions, nextVisiting);
    }
    const sub = (child: Expression) => rewritePinned(child, currentFunctions, visiting);
    switch (expr.type) {
      case "literal":
      case "identifier":
        return expr;
      case "memberAccess": {
        const rewritten: Expression = { ...expr, object: sub(expr.object) };
        const key = dataFieldPath(rewritten);
        if (key !== null && singlePins.has(key)) return singlePins.get(key)!;
        return rewritten;
      }
      case "bracketAccess": {
        const rewritten: Expression = { ...expr, object: sub(expr.object), index: sub(expr.index) };
        const key = dataFieldPath(rewritten);
        if (key !== null && singlePins.has(key)) return singlePins.get(key)!;
        return rewritten;
      }
      case "sliceAccess":
        return { ...expr, object: sub(expr.object), start: sub(expr.start), end: sub(expr.end) };
      case "binaryOp":
        return { ...expr, left: sub(expr.left), right: sub(expr.right) };
      case "unaryOp":
        return { ...expr, operand: sub(expr.operand) };
      case "ternary":
        return {
          ...expr,
          condition: sub(expr.condition),
          consequent: sub(expr.consequent),
          alternate: sub(expr.alternate),
        };
      case "inExpr":
        return { ...expr, element: sub(expr.element), collection: sub(expr.collection) };
      case "isExpr":
        return { ...expr, value: sub(expr.value) };
      case "listLiteral":
        return { ...expr, elements: expr.elements.map(sub) };
      case "mapLiteral":
        return {
          ...expr,
          entries: expr.entries.map((entry) => ({ key: sub(entry.key), value: sub(entry.value) })),
        };
      case "pathLiteral":
        return {
          ...expr,
          segments: expr.segments.map((seg) => (typeof seg === "string" ? seg : sub(seg))),
        };
      case "methodCall":
        return { ...expr, object: sub(expr.object), args: expr.args.map(sub) };
      case "functionCall":
        return { ...expr, args: expr.args.map(sub) };
    }
  };

  const pinned = rewritePinned(condition);
  return projectWorstCaseBudgetExpr(pinned, {
    outerFunctions: functions,
    functionScopes,
    candidateVariables: pathInvariance?.candidateVariables,
    ambiguousNames: pathInvariance?.ambiguousNames,
    checkResourceDependence: true,
  }).expr;
}
