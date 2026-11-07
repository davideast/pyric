/** Reduce query-guaranteed facts to a candidate-independent residual condition.
 * Every finite alternative must pass. Unknown predicates are never evaluated
 * against a fabricated partial document; only positive OR branches can omit them.
 */
import type { Expression, FunctionDef } from "../grammar/FirestoreAST.js";
import type { SimulationContext } from "./evaluation-context.js";
import { evaluate, requireBoolean } from "./evaluator.js";
import { getValidFunctionLexicalScope } from "./match-resolution.js";
import {
  isProvablyDocIndependent,
  substituteIdentifiers,
  type QueryConstraints,
} from "./query-proof.js";
import { hostNumber, inInt64, isHostIntNumber } from "./rules-int.js";
import { listElementsEqual, rulesValuesEqual } from "./value-equality.js";
import { RulesFloat } from "./wrappers/float.js";
import { Path } from "./wrappers/path.js";
import { Timestamp } from "./wrappers/timestamp.js";

export type Scalar = string | number | boolean | null;
export type RulesScalar = string | number | bigint | boolean | null | RulesFloat;

export const isScalar = (value: unknown): value is Scalar =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

function literalRaw(value: Scalar): string {
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

const literal = (value: Scalar): Expression => ({
  type: "literal",
  value,
  raw: literalRaw(value),
});

function memberStep(
  expr: Expression,
): { object: Expression; property: string } | null {
  if (expr.type === "memberAccess") {
    return { object: expr.object, property: expr.property };
  }
  if (
    expr.type === "bracketAccess" &&
    expr.index.type === "literal" &&
    typeof expr.index.value === "string"
  ) {
    return { object: expr.object, property: expr.index.value };
  }
  return null;
}

export function isResourceData(expr: Expression): boolean {
  const step = memberStep(expr);
  if (!step || step.property !== "data") return false;
  return step.object.type === "identifier" && step.object.name === "resource";
}

/**
 * If `expr` is a single-segment `resource.data.<field>` or `resource.data['<field>']`
 * access (including `resource['data']`), return `<field>`; otherwise null.
 */
export function dataFieldPath(expr: Expression): string | null {
  const step = memberStep(expr);
  if (!step || step.property.length === 0 || step.property.includes(".")) {
    return null;
  }
  if (!isResourceData(step.object)) return null;
  return step.property;
}

/** True for `request.auth.uid` (dot or bracket access). */
export function isRequestAuthUid(expr: Expression): boolean {
  const uidStep = memberStep(expr);
  if (!uidStep || uidStep.property !== "uid") return false;
  const authStep = memberStep(uidStep.object);
  if (!authStep || authStep.property !== "auth") return false;
  return authStep.object.type === "identifier" && authStep.object.name === "request";
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
    if (filter.op === "==" && isScalar(filter.value)) {
      filterValues = filter.value === 0 ? [0, -0] : [filter.value];
    } else if (
      filter.op === "in" &&
      Array.isArray(filter.value) &&
      filter.value.length > 0 &&
      filter.value.length <= 30 &&
      filter.value.every(isScalar)
    ) {
      const deduped: Scalar[] = [];
      for (const item of filter.value) {
        if (!deduped.some((existing) => Object.is(existing, item))) {
          deduped.push(item);
        }
      }
      filterValues = deduped;
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
        next.some((candidate) => Object.is(candidate, v)),
      );
    }
    domains.set(field, intersected);
  }
  return domains;
}

export function inlineFunctionsInExpr(
  expr: Expression,
  functions: Map<string, FunctionDef>,
  visiting: ReadonlySet<string> = new Set(),
): Expression | null {
  let budget = 500;
  const inline = (
    e: Expression,
    currentFunctions: Map<string, FunctionDef>,
    seen: ReadonlySet<string>,
  ): Expression | null => {
    if (--budget < 0) return null;
    if (e.type === "functionCall" && currentFunctions.has(e.name)) {
      if (seen.has(e.name)) return null;
      const fn = currentFunctions.get(e.name)!;
      if (fn.parameters.length !== e.args.length) return null;
      const nextFunctions = getValidFunctionLexicalScope(fn, currentFunctions);
      if (!nextFunctions) return null;
      const bindings = new Map<string, Expression>();
      for (let i = 0; i < fn.parameters.length; i++) {
        const inlinedArg = inline(e.args[i]!, currentFunctions, seen);
        if (!inlinedArg) return null;
        bindings.set(fn.parameters[i]!, inlinedArg);
      }
      const nextSeen = new Set(seen).add(e.name);
      for (const b of fn.lets) {
        const inlinedLet = inline(substituteIdentifiers(b.value, bindings), nextFunctions, nextSeen);
        if (!inlinedLet) return null;
        bindings.set(b.name, inlinedLet);
      }
      return inline(substituteIdentifiers(fn.body, bindings), nextFunctions, nextSeen);
    }
    switch (e.type) {
      case "literal":
      case "identifier":
        return e;
      case "memberAccess": {
        const object = inline(e.object, currentFunctions, seen);
        if (!object) return null;
        return { ...e, object };
      }
      case "bracketAccess": {
        const object = inline(e.object, currentFunctions, seen);
        const index = inline(e.index, currentFunctions, seen);
        if (!object || !index) return null;
        return { ...e, object, index };
      }
      case "binaryOp": {
        const left = inline(e.left, currentFunctions, seen);
        const right = inline(e.right, currentFunctions, seen);
        if (!left || !right) return null;
        return { ...e, left, right };
      }
      case "unaryOp": {
        const operand = inline(e.operand, currentFunctions, seen);
        if (!operand) return null;
        return { ...e, operand };
      }
      case "sliceAccess": {
        const object = inline(e.object, currentFunctions, seen);
        const start = inline(e.start, currentFunctions, seen);
        const end = inline(e.end, currentFunctions, seen);
        if (!object || !start || !end) return null;
        return { ...e, object, start, end };
      }
      case "ternary": {
        const condition = inline(e.condition, currentFunctions, seen);
        const consequent = inline(e.consequent, currentFunctions, seen);
        const alternate = inline(e.alternate, currentFunctions, seen);
        if (!condition || !consequent || !alternate) return null;
        return { ...e, condition, consequent, alternate };
      }
      case "inExpr": {
        const element = inline(e.element, currentFunctions, seen);
        const collection = inline(e.collection, currentFunctions, seen);
        if (!element || !collection) return null;
        return { ...e, element, collection };
      }
      case "isExpr": {
        const value = inline(e.value, currentFunctions, seen);
        if (!value) return null;
        return { ...e, value };
      }
      case "listLiteral": {
        const elements: Expression[] = [];
        for (const el of e.elements) {
          const inlined = inline(el, currentFunctions, seen);
          if (!inlined) return null;
          elements.push(inlined);
        }
        return { ...e, elements };
      }
      case "mapLiteral": {
        const entries: { key: Expression; value: Expression }[] = [];
        for (const entry of e.entries) {
          const key = inline(entry.key, currentFunctions, seen);
          const value = inline(entry.value, currentFunctions, seen);
          if (!key || !value) return null;
          entries.push({ key, value });
        }
        return { ...e, entries };
      }
      case "pathLiteral": {
        const segments: (string | Expression)[] = [];
        for (const seg of e.segments) {
          if (typeof seg === "string") {
            segments.push(seg);
          } else {
            const inlined = inline(seg, currentFunctions, seen);
            if (!inlined) return null;
            segments.push(inlined);
          }
        }
        return { ...e, segments };
      }
      case "methodCall": {
        const object = inline(e.object, currentFunctions, seen);
        if (!object) return null;
        const args: Expression[] = [];
        for (const arg of e.args) {
          const inlined = inline(arg, currentFunctions, seen);
          if (!inlined) return null;
          args.push(inlined);
        }
        return { ...e, object, args };
      }
      case "functionCall": {
        const args: Expression[] = [];
        for (const arg of e.args) {
          const inlined = inline(arg, currentFunctions, seen);
          if (!inlined) return null;
          args.push(inlined);
        }
        return { ...e, args };
      }
    }
  };
  return inline(expr, functions, visiting);
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
    (value instanceof RulesFloat && Number.isFinite(value.value))
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

export function resolveStaticRulesOperand(
  expr: Expression,
  userFunctions: ReadonlyMap<string, FunctionDef>,
  authUid?: string,
): RulesScalar | undefined {
  if (isClosedConstantExpr(expr, userFunctions)) {
    const value = evalConstValue(expr, userFunctions);
    return isRulesScalar(value) ? value : undefined;
  }
  if (isRequestAuthUid(expr)) {
    return authUid;
  }
  return undefined;
}

function isGuaranteedByArrayContains(
  arrayField: string,
  element: Expression,
  constraints: QueryConstraints,
  userFunctions: ReadonlyMap<string, FunctionDef>,
  authUid?: string,
): boolean {
  const ruleVal = resolveStaticRulesOperand(element, userFunctions, authUid);
  if (ruleVal === undefined) return false;
  return (constraints.where ?? []).some(
    (filter) =>
      filter.field === arrayField &&
      filter.op === "array-contains" &&
      isScalar(filter.value) &&
      listElementsEqual(ruleVal, toRulesQueryScalar(filter.value)),
  );
}

function isEqualityImpliedByFilterSet(
  left: Expression,
  right: Expression,
  filterSetsByField: ReadonlyMap<string, Scalar[][]>,
  userFunctions: ReadonlyMap<string, FunctionDef>,
  authUid?: string,
): boolean {
  const checkSide = (dataExpr: Expression, valueExpr: Expression): boolean => {
    const field = dataFieldPath(dataExpr);
    if (field === null) return false;
    const sets = filterSetsByField.get(field);
    if (!sets) return false;
    const target = resolveStaticRulesOperand(valueExpr, userFunctions, authUid);
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
): boolean {
  const field = dataFieldPath(element);
  if (field === null || collection.type !== "listLiteral") return false;
  const sets = filterSetsByField.get(field);
  if (!sets) return false;
  const allowedValues: RulesScalar[] = [];
  for (const el of collection.elements) {
    const resolved = resolveStaticRulesOperand(el, userFunctions, authUid);
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
  if (!isClosedConstantExpr(expr, userFunctions)) return undefined;
  try {
    const val = evaluate(expr, CLOSED_CONST_CTX);
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
  if (!isClosedConstantExpr(expr, userFunctions)) return false;
  try {
    const val = evaluate(expr, CLOSED_CONST_CTX);
    return !requireBoolean(val, expr);
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

function pinCandidateExpressions(value: Scalar): Expression[] {
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

export function queryResidual(
  condition: Expression,
  constraints: QueryConstraints,
  functions: Map<string, FunctionDef>,
  authUid?: string,
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
  for (const pins of variants) {
    let budget = 2000;
    function rewrite(
      expr: Expression,
      currentFunctions: Map<string, FunctionDef> = functions,
      visiting = new Set<string>(),
    ): Expression {
      if (--budget < 0) throw new Error("proof expansion budget");
      const directKey = dataFieldPath(expr);
      if (directKey !== null && pins.has(directKey)) {
        return pins.get(directKey)!;
      }
      if (expr.type === "functionCall" && currentFunctions.has(expr.name)) {
        // Leave already-independent helpers intact to preserve evaluator scoping/budgets.
        if (isProvablyDocIndependent(expr, currentFunctions)) return expr;
        if (visiting.has(expr.name)) throw new Error("recursive proof helper");
        const fn = currentFunctions.get(expr.name)!;
        if (fn.parameters.length !== expr.args.length)
          throw new Error("proof arity");
        const nextFunctions = getValidFunctionLexicalScope(fn, currentFunctions);
        if (!nextFunctions) throw new Error("lexically invalid proof helper");
        const rewrittenArgs = expr.args.map((arg) =>
          rewrite(arg, currentFunctions, visiting),
        );
        const bindings = new Map(
          fn.parameters.map((name, i) => [name, rewrittenArgs[i]!]),
        );
        const nextVisiting = new Set([...visiting, expr.name]);
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
            if (
              expr.method === "hasAny" &&
              elements.some((el) =>
                isGuaranteedByArrayContains(
                  arrayField,
                  el,
                  constraints,
                  currentFunctions,
                  authUid,
                ),
              )
            ) {
              return literal(true);
            }
            if (
              expr.method === "hasAll" &&
              elements.length > 0 &&
              elements.every((el) =>
                isGuaranteedByArrayContains(
                  arrayField,
                  el,
                  constraints,
                  currentFunctions,
                  authUid,
                ),
              )
            ) {
              return literal(true);
            }
          }
          return {
            ...expr,
            object,
            args,
          };
        }
        case "functionCall":
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
          partial = true;
          return left ?? right;
        }
        return undefined;
      }
      if (isProvablyDocIndependent(expr, functions)) {
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
  return {
    condition: residuals.reduce((left, right) => join(left, right, "&&")),
    partial,
  };
}
