import { grammar } from './RtdbExprParser.js';
import type { RuleError } from '../types.js';

const ALLOWED_IDENTIFIERS: Record<string, Set<string>> = {
  read: new Set(['auth', 'data', 'root', 'now']),
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

let _errors: RuleError[] = [];
let _context: 'read' | 'write' | 'validate' = 'read';
let _pathVars: Set<string> = new Set();
// Track whether we're inside a CallExpr_methodCall (to skip method name ident validation)
let _skipNextIdent = false;

const validatorSemantics = grammar.createSemantics();
validatorSemantics.addOperation('validate', {
  _nonterminal(...children) {
    children.forEach(c => (c as any).validate());
  },
  _iter(...children) {
    children.forEach(c => (c as any).validate());
  },
  _terminal() {},

  CallExpr_methodCall(receiver, _dot, methodName, _open, args, _close) {
    (receiver as any).validate();
    // Validate method name
    const method = methodName.sourceString;
    if (!ALL_KNOWN_METHODS.has(method)) {
      _errors.push({
        code: 'UNKNOWN_METHOD',
        message: `Unknown method '${method}'`,
      });
    }
    // Recurse into args but NOT methodName (it's not an identifier in this context)
    args.asIteration().children.forEach((a: any) => (a as any).validate());
  },

  CallExpr_memberAccess(receiver, _dot, _member) {
    (receiver as any).validate();
    // Skip validation of member name - it's a property, not a root identifier
  },

  CallExpr_indexAccess(receiver, _open, index, _close) {
    (receiver as any).validate();
    (index as any).validate();
  },

  ident(_dollar, _start, _rest) {
    const name = this.sourceString;
    const dollar = _dollar.sourceString;

    // Path variables (starting with $) are always valid
    if (dollar === '$') return;

    const allowed = ALLOWED_IDENTIFIERS[_context];
    if (!allowed) return;

    if (!allowed.has(name) && !_pathVars.has(name)) {
      _errors.push({
        code: 'UNKNOWN_IDENTIFIER',
        message: `Identifier '${name}' is not allowed in '${_context}' context`,
      });
    }

    if (name === 'newData' && _context === 'read') {
      _errors.push({
        code: 'NEWDATA_IN_READ',
        message: `'newData' is not available in 'read' context`,
      });
    }
  },
});

export function validateExpression(
  raw: string,
  context: 'read' | 'write' | 'validate',
  pathVariables: string[] = [],
): RuleError[] {
  const match = grammar.match(raw.trim());
  if (match.failed()) return [];

  _errors = [];
  _context = context;
  _pathVars = new Set(pathVariables.map(v => v.startsWith('$') ? v.slice(1) : v));

  (validatorSemantics(match) as any).validate();
  return [..._errors];
}
