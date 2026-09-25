import type { Semantics } from 'ohm-js';
import {
  createRtdbExpressionSemantics,
  matchRtdbExpression,
} from '../expression-engine.js';
import type { RuleError } from '../types.js';

const ALLOWED_IDENTIFIERS: Record<string, Set<string>> = {
  read: new Set(['auth', 'data', 'root', 'now', 'query']),
  write: new Set(['auth', 'data', 'newData', 'root', 'now']),
  validate: new Set(['auth', 'data', 'newData', 'root', 'now']),
};

const DATASNAPSHOT_METHODS = new Set([
  'val', 'exists', 'hasChild', 'hasChildren', 'isString', 'isNumber',
  'isBoolean', 'child', 'parent', 'getPriority',
]);

const STRING_METHODS = new Set([
  'matches', 'contains', 'beginsWith', 'endsWith', 'replace', 'toLowerCase',
  'toUpperCase', 'length',
]);

const ALL_KNOWN_METHODS = new Set([...DATASNAPSHOT_METHODS, ...STRING_METHODS]);

interface ValidateContext {
  errors: RuleError[];
  context: 'read' | 'write' | 'validate';
  pathVars: Set<string>;
}

let validatorSemantics: Semantics | undefined;

function getValidatorSemantics(): Semantics {
  if (validatorSemantics) return validatorSemantics;
  const semantics = createRtdbExpressionSemantics();
  semantics.addOperation('validate(ctx)', {
    _nonterminal(...children) {
      children.forEach(c => (c as any).validate(this.args.ctx));
    },
    _iter(...children) {
      children.forEach(c => (c as any).validate(this.args.ctx));
    },
    _terminal() {},

    CallExpr_methodCall(receiver, _dot, methodName, _open, args, _close) {
      const ctx = this.args.ctx as ValidateContext;
      (receiver as any).validate(ctx);
      // Validate method name
      const method = methodName.sourceString;
      if (!ALL_KNOWN_METHODS.has(method)) {
        ctx.errors.push({
          code: 'UNKNOWN_METHOD',
          message: `Unknown method '${method}'`,
        });
      }
      // Recurse into args but NOT methodName (it's not an identifier in this context)
      args.asIteration().children.forEach((a: any) => (a as any).validate(ctx));
    },

    CallExpr_memberAccess(receiver, _dot, _member) {
      (receiver as any).validate(this.args.ctx);
      // Skip validation of member name - it's a property, not a root identifier
    },

    CallExpr_indexAccess(receiver, _open, index, _close) {
      (receiver as any).validate(this.args.ctx);
      (index as any).validate(this.args.ctx);
    },

    ident(_dollar, _start, _rest) {
      const ctx = this.args.ctx as ValidateContext;
      const name = this.sourceString;
      const dollar = _dollar.sourceString;

      // Path variables (starting with $) are always valid
      if (dollar === '$') return;

      const allowed = ALLOWED_IDENTIFIERS[ctx.context];
      if (!allowed) return;

      if (!allowed.has(name) && !ctx.pathVars.has(name)) {
        ctx.errors.push({
          code: 'UNKNOWN_IDENTIFIER',
          message: `Identifier '${name}' is not allowed in '${ctx.context}' context`,
        });
      }

      if (name === 'newData' && ctx.context === 'read') {
        ctx.errors.push({
          code: 'NEWDATA_IN_READ',
          message: `'newData' is not available in 'read' context`,
        });
      }
    },
  });
  validatorSemantics = semantics;
  return semantics;
}

export function validateExpression(
  raw: string,
  context: 'read' | 'write' | 'validate',
  pathVariables: string[] = [],
): RuleError[] {
  const match = matchRtdbExpression(raw);
  if (match.failed()) return [];

  const ctx: ValidateContext = {
    errors: [],
    context,
    pathVars: new Set(pathVariables.map(v => v.startsWith('$') ? v.slice(1) : v)),
  };

  (getValidatorSemantics()(match) as any).validate(ctx);
  return ctx.errors;
}
