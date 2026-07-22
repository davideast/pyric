import type { Expression, FunctionDef } from '../grammar/FirestoreAST.js';

function assertNever(value: never): never {
  throw new Error(`Unhandled Rules expression: ${JSON.stringify(value)}`);
}

export function sanitizeModuleName(name: string): string {
  return name.replace(/^\.\.\//, '_').replace(/^\.\//, '').replace(/[.\/-]/g, '_');
}

export function rewriteCalls(expr: Expression, renames: Map<string, string>): Expression {
  switch (expr.type) {
    case 'functionCall': {
      const newName = renames.get(expr.name) ?? expr.name;
      const newArgs = expr.args.map(a => rewriteCalls(a, renames));
      return newName === expr.name && newArgs.every((a, i) => a === expr.args[i])
        ? expr : { ...expr, name: newName, args: newArgs };
    }
    case 'binaryOp': {
      const left = rewriteCalls(expr.left, renames);
      const right = rewriteCalls(expr.right, renames);
      return left === expr.left && right === expr.right ? expr : { ...expr, left, right };
    }
    case 'unaryOp': {
      const operand = rewriteCalls(expr.operand, renames);
      return operand === expr.operand ? expr : { ...expr, operand };
    }
    case 'methodCall': {
      const object = rewriteCalls(expr.object, renames);
      const args = expr.args.map(a => rewriteCalls(a, renames));
      return object === expr.object && args.every((a, i) => a === expr.args[i])
        ? expr : { ...expr, object, args };
    }
    case 'memberAccess': {
      const object = rewriteCalls(expr.object, renames);
      return object === expr.object ? expr : { ...expr, object };
    }
    case 'bracketAccess': {
      const object = rewriteCalls(expr.object, renames);
      const index = rewriteCalls(expr.index, renames);
      return object === expr.object && index === expr.index ? expr : { ...expr, object, index };
    }
    case 'sliceAccess': {
      const object = rewriteCalls(expr.object, renames);
      const start = rewriteCalls(expr.start, renames);
      const end = rewriteCalls(expr.end, renames);
      return object === expr.object && start === expr.start && end === expr.end
        ? expr : { ...expr, object, start, end };
    }
    case 'ternary': {
      const condition = rewriteCalls(expr.condition, renames);
      const consequent = rewriteCalls(expr.consequent, renames);
      const alternate = rewriteCalls(expr.alternate, renames);
      return condition === expr.condition && consequent === expr.consequent && alternate === expr.alternate
        ? expr : { ...expr, condition, consequent, alternate };
    }
    case 'inExpr': {
      const element = rewriteCalls(expr.element, renames);
      const collection = rewriteCalls(expr.collection, renames);
      return element === expr.element && collection === expr.collection ? expr : { ...expr, element, collection };
    }
    case 'isExpr': {
      const value = rewriteCalls(expr.value, renames);
      return value === expr.value ? expr : { ...expr, value };
    }
    case 'listLiteral': {
      const elements = expr.elements.map(e => rewriteCalls(e, renames));
      return elements.every((e, i) => e === expr.elements[i]) ? expr : { ...expr, elements };
    }
    case 'mapLiteral': {
      const entries = expr.entries.map(en => {
        const key = rewriteCalls(en.key, renames);
        const value = rewriteCalls(en.value, renames);
        return key === en.key && value === en.value ? en : { key, value };
      });
      return entries.every((e, i) => e === expr.entries[i]) ? expr : { ...expr, entries };
    }
    case 'pathLiteral': {
      const segments = expr.segments.map(segment =>
        typeof segment === 'string' ? segment : rewriteCalls(segment, renames));
      return segments.every((segment, i) => segment === expr.segments[i])
        ? expr : { ...expr, segments };
    }
    case 'literal':
    case 'identifier': return expr;
    default: return assertNever(expr);
  }
}

export function prefixPrivateFunctions(functions: FunctionDef[], moduleName: string): FunctionDef[] {
  const prefix = sanitizeModuleName(moduleName);
  const renames = new Map<string, string>();

  for (const fn of functions) {
    if (!fn.exported) {
      renames.set(fn.name, `${prefix}__${fn.name}`);
    }
  }

  if (renames.size === 0) return functions;

  return functions.map(fn => {
    const newBody = rewriteCalls(fn.body, renames);
    const newLets = fn.lets.map(binding => {
      const newValue = rewriteCalls(binding.value, renames);
      return newValue === binding.value ? binding : { ...binding, value: newValue };
    });
    const newName = fn.exported ? fn.name : (renames.get(fn.name) ?? fn.name);
    return newBody === fn.body && newLets === fn.lets && newName === fn.name
      ? fn
      : { ...fn, name: newName, body: newBody, lets: newLets };
  });
}
