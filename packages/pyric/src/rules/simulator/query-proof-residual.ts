/** Reduce query-guaranteed facts to a candidate-independent residual condition.
 * Every finite alternative must pass. Unknown predicates are never evaluated
 * against a fabricated partial document; only positive OR branches can omit them.
 */
import type { Expression, FunctionDef } from "../grammar/FirestoreAST.js";
import {
  isProvablyDocIndependent,
  substituteIdentifiers,
  type QueryConstraints,
} from "./query-proof.js";

export type Scalar = string | number | boolean | null;

export const isScalar = (value: unknown): value is Scalar =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

const literal = (value: Scalar): Expression => ({
  type: "literal",
  value,
  raw: JSON.stringify(value),
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
 * Compute the effective scalar domain for each constrained field by intersecting
 * all `==` and finite `in` filters on the same field (order-independent).
 * An empty array `[]` indicates contradictory equality/`in` filters on that field.
 */
export function computeWhereDomains(
  constraints: QueryConstraints,
): Map<string, Scalar[]> {
  const domains = new Map<string, Scalar[]>();
  for (const filter of constraints.where ?? []) {
    let filterValues: Scalar[] | undefined;
    if (filter.op === "==" && isScalar(filter.value)) {
      filterValues = [filter.value];
    } else if (
      filter.op === "in" &&
      Array.isArray(filter.value) &&
      filter.value.length > 0 &&
      filter.value.length <= 30 &&
      filter.value.every(isScalar)
    ) {
      filterValues = Array.from(new Set(filter.value));
    }
    if (filterValues === undefined) continue;
    const existing = domains.get(filter.field);
    if (existing === undefined) {
      domains.set(filter.field, filterValues);
    } else {
      domains.set(
        filter.field,
        existing.filter((v) => filterValues.includes(v)),
      );
    }
  }
  return domains;
}

export function inlineFunctionsInExpr(
  expr: Expression,
  functions: Map<string, FunctionDef>,
  visiting: ReadonlySet<string> = new Set(),
): Expression | null {
  let budget = 500;
  const inline = (e: Expression, seen: ReadonlySet<string>): Expression | null => {
    if (--budget < 0) return null;
    if (e.type === "functionCall" && functions.has(e.name)) {
      if (seen.has(e.name)) return null;
      const fn = functions.get(e.name)!;
      if (fn.parameters.length !== e.args.length) return null;
      const bindings = new Map<string, Expression>();
      for (let i = 0; i < fn.parameters.length; i++) {
        const inlinedArg = inline(e.args[i]!, seen);
        if (!inlinedArg) return null;
        bindings.set(fn.parameters[i]!, inlinedArg);
      }
      const nextSeen = new Set(seen).add(e.name);
      for (const b of fn.lets) {
        const inlinedLet = inline(substituteIdentifiers(b.value, bindings), nextSeen);
        if (!inlinedLet) return null;
        bindings.set(b.name, inlinedLet);
      }
      return inline(substituteIdentifiers(fn.body, bindings), nextSeen);
    }
    switch (e.type) {
      case "literal":
      case "identifier":
        return e;
      case "memberAccess": {
        const object = inline(e.object, seen);
        if (!object) return null;
        return { ...e, object };
      }
      case "bracketAccess": {
        const object = inline(e.object, seen);
        const index = inline(e.index, seen);
        if (!object || !index) return null;
        return { ...e, object, index };
      }
      case "binaryOp": {
        const left = inline(e.left, seen);
        const right = inline(e.right, seen);
        if (!left || !right) return null;
        return { ...e, left, right };
      }
      default:
        return e;
    }
  };
  return inline(expr, visiting);
}

function join(left: Expression, right: Expression, op: string): Expression {
  return { type: "binaryOp", op, left, right };
}

function not(operand: Expression): Expression {
  return { type: "unaryOp", op: "!", operand };
}

function resolveArrayContainsValue(
  element: Expression,
  authUid?: string,
): Scalar | undefined {
  if (element.type === "literal" && isScalar(element.value)) {
    return element.value;
  }
  if (isRequestAuthUid(element)) {
    return authUid;
  }
  return undefined;
}

function isGuaranteedByArrayContains(
  arrayField: string,
  element: Expression,
  constraints: QueryConstraints,
  authUid?: string,
): boolean {
  const value = resolveArrayContainsValue(element, authUid);
  if (value === undefined) return false;
  return (constraints.where ?? []).some(
    (filter) =>
      filter.field === arrayField &&
      filter.op === "array-contains" &&
      filter.value === value,
  );
}

function replaceEmptyDomainFields(
  expr: Expression,
  emptyFields: ReadonlySet<string>,
): Expression {
  const key = dataFieldPath(expr);
  if (key !== null && emptyFields.has(key)) return literal(null);
  const sub = (v: Expression) => replaceEmptyDomainFields(v, emptyFields);
  switch (expr.type) {
    case "literal":
    case "identifier":
      return expr;
    case "memberAccess":
      return { ...expr, object: sub(expr.object) };
    case "bracketAccess":
      return { ...expr, object: sub(expr.object), index: sub(expr.index) };
    case "sliceAccess":
      return { ...expr, object: sub(expr.object), start: sub(expr.start), end: sub(expr.end) };
    case "binaryOp":
      return { ...expr, left: sub(expr.left), right: sub(expr.right) };
    case "unaryOp":
      return { ...expr, operand: sub(expr.operand) };
    case "ternary":
      return { ...expr, condition: sub(expr.condition), consequent: sub(expr.consequent), alternate: sub(expr.alternate) };
    case "inExpr":
      return { ...expr, element: sub(expr.element), collection: sub(expr.collection) };
    case "isExpr":
      return { ...expr, value: sub(expr.value) };
    case "methodCall":
      return { ...expr, object: sub(expr.object), args: expr.args.map(sub) };
    case "functionCall":
      return { ...expr, args: expr.args.map(sub) };
    case "listLiteral":
      return { ...expr, elements: expr.elements.map(sub) };
    case "mapLiteral":
      return { ...expr, entries: expr.entries.map((entry) => ({ key: sub(entry.key), value: sub(entry.value) })) };
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

export function queryResidual(
  condition: Expression,
  constraints: QueryConstraints,
  functions: Map<string, FunctionDef>,
  authUid?: string,
): { condition: Expression; partial: boolean } | undefined {
  let partial = false;
  const domains = computeWhereDomains(constraints);
  const emptyFields = new Set<string>();
  const nonEmptyDomains = new Map<string, Scalar[]>();
  for (const [name, values] of domains) {
    if (values.length === 0) {
      emptyFields.add(name);
    } else {
      nonEmptyDomains.set(name, values);
    }
  }
  let variants: Map<string, Scalar>[] = [new Map()];
  for (const [name, values] of nonEmptyDomains) {
    if (variants.length * values.length > 30) return undefined;
    variants = variants.flatMap((variant) =>
      values.map((value) => new Map([...variant, [name, value]])),
    );
  }
  const residuals: Expression[] = [];
  for (const pins of variants) {
    let budget = 2000;
    function rewrite(
      expr: Expression,
      visiting = new Set<string>(),
    ): Expression {
      if (--budget < 0) throw new Error("proof expansion budget");
      const directKey = dataFieldPath(expr);
      if (directKey !== null && pins.has(directKey)) {
        return literal(pins.get(directKey)!);
      }
      if (expr.type === "functionCall" && functions.has(expr.name)) {
        // Leave already-independent helpers intact to preserve evaluator scoping/budgets.
        if (isProvablyDocIndependent(expr, functions)) return expr;
        if (visiting.has(expr.name)) throw new Error("recursive proof helper");
        const fn = functions.get(expr.name)!;
        if (fn.parameters.length !== expr.args.length)
          throw new Error("proof arity");
        const bindings = new Map(
          fn.parameters.map((name, i) => [name, expr.args[i]!]),
        );
        for (const binding of fn.lets)
          bindings.set(
            binding.name,
            substituteIdentifiers(binding.value, bindings),
          );
        return rewrite(
          substituteIdentifiers(fn.body, bindings),
          new Set([...visiting, expr.name]),
        );
      }
      if (expr.type === "inExpr") {
        const element = rewrite(expr.element, visiting);
        const collection = rewrite(expr.collection, visiting);
        const arrayField = dataFieldPath(collection);
        if (
          arrayField !== null &&
          isGuaranteedByArrayContains(arrayField, element, constraints, authUid)
        ) {
          return literal(true);
        }
        return {
          ...expr,
          element,
          collection,
        };
      }
      const sub = (value: Expression) => rewrite(value, visiting);
      switch (expr.type) {
        case "literal":
        case "identifier":
          return expr;
        case "memberAccess": {
          const rewritten: Expression = { ...expr, object: sub(expr.object) };
          const key = dataFieldPath(rewritten);
          if (key !== null && pins.has(key)) return literal(pins.get(key)!);
          return rewritten;
        }
        case "bracketAccess": {
          const rewritten: Expression = {
            ...expr,
            object: sub(expr.object),
            index: sub(expr.index),
          };
          const key = dataFieldPath(rewritten);
          if (key !== null && pins.has(key)) return literal(pins.get(key)!);
          return rewritten;
        }
        case "sliceAccess":
          return {
            ...expr,
            object: sub(expr.object),
            start: sub(expr.start),
            end: sub(expr.end),
          };
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
            args[0]!.elements.every((el) => isProvablyDocIndependent(el, functions))
          ) {
            const elements = args[0]!.elements;
            if (
              expr.method === "hasAny" &&
              elements.some((el) =>
                isGuaranteedByArrayContains(arrayField, el, constraints, authUid),
              )
            ) {
              return literal(true);
            }
            if (
              expr.method === "hasAll" &&
              elements.length > 0 &&
              elements.every((el) =>
                isGuaranteedByArrayContains(arrayField, el, constraints, authUid),
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
            segments: expr.segments.map((segment) =>
              typeof segment === "string" ? segment : sub(segment),
            ),
          };
      }
    }
    // A sufficient condition, never a guessed representative. Unknown branches
    // may be discarded only in monotone positive OR (including De Morgan duals),
    // never under an unpushed NOT or ternary.
    function sufficient(expr: Expression): Expression | undefined {
      if (isProvablyDocIndependent(expr, functions)) return expr;
      if (
        emptyFields.size > 0 &&
        isProvablyDocIndependent(
          replaceEmptyDomainFields(expr, emptyFields),
          functions,
        )
      ) {
        return literal(true);
      }
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
        return undefined;
      }
      if (expr.type !== "binaryOp" || (expr.op !== "&&" && expr.op !== "||"))
        return undefined;
      const left = sufficient(expr.left),
        right = sufficient(expr.right);
      if (left && right) return join(left, right, expr.op);
      if (expr.op === "||") {
        partial = true;
        return left ?? right;
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
