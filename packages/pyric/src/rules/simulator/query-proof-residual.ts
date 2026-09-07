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
type Scalar = string | number | boolean | null;
const scalar = (value: unknown): value is Scalar =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));
const literal = (value: Scalar): Expression => ({
  type: "literal",
  value,
  raw: JSON.stringify(value),
});
function field(expr: Expression): string | undefined {
  if (
    expr.type === "memberAccess" &&
    expr.object.type === "memberAccess" &&
    expr.object.property === "data" &&
    expr.object.object.type === "identifier" &&
    expr.object.object.name === "resource"
  )
    return expr.property;
  return undefined;
}
function join(left: Expression, right: Expression, op: string): Expression {
  return { type: "binaryOp", op, left, right };
}

export function queryResidual(
  condition: Expression,
  constraints: QueryConstraints,
  functions: Map<string, FunctionDef>,
  authUid?: string,
): { condition: Expression; partial: boolean } | undefined {
  let partial = false;
  const domains = new Map<string, Scalar[]>();
  for (const filter of constraints.where ?? []) {
    if (domains.has(filter.field)) continue;
    if (filter.op === "==" && scalar(filter.value))
      domains.set(filter.field, [filter.value]);
    if (
      filter.op === "in" &&
      Array.isArray(filter.value) &&
      filter.value.length > 0 &&
      filter.value.length <= 30 &&
      filter.value.every(scalar)
    )
      domains.set(filter.field, filter.value);
  }
  let variants: Map<string, Scalar>[] = [new Map()];
  for (const [name, values] of domains) {
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
      const key = field(expr);
      if (key !== undefined && pins.has(key)) return literal(pins.get(key)!);
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
        const arrayField = field(expr.collection);
        const element = rewrite(expr.element, visiting);
        let value: Scalar | undefined;
        if (element.type === "literal") value = element.value;
        if (
          element.type === "memberAccess" &&
          element.property === "uid" &&
          element.object.type === "memberAccess" &&
          element.object.property === "auth" &&
          element.object.object.type === "identifier" &&
          element.object.object.name === "request"
        )
          value = authUid;
        if (
          arrayField !== undefined &&
          value !== undefined &&
          (constraints.where ?? []).some(
            (filter) =>
              filter.field === arrayField &&
              filter.op === "array-contains" &&
              filter.value === value,
          )
        )
          return literal(true);
        return {
          ...expr,
          element,
          collection: rewrite(expr.collection, visiting),
        };
      }
      const sub = (value: Expression) => rewrite(value, visiting);
      switch (expr.type) {
        case "literal":
        case "identifier":
          return expr;
        case "memberAccess":
          return { ...expr, object: sub(expr.object) };
        case "bracketAccess":
          return { ...expr, object: sub(expr.object), index: sub(expr.index) };
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
        case "methodCall":
          return {
            ...expr,
            object: sub(expr.object),
            args: expr.args.map(sub),
          };
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
    // may be discarded only in monotone positive OR, never under NOT/ternary.
    function sufficient(expr: Expression): Expression | undefined {
      if (isProvablyDocIndependent(expr, functions)) return expr;
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
