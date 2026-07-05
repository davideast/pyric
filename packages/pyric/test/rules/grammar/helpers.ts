/**
 * Test helpers for building minimal Firestore ASTs programmatically.
 * Used by validator tests to create specific AST shapes without parsing.
 */
import type {
  FirestoreRules, MatchBlock, AllowRule, FunctionDef, Expression,
  Operation, PathPattern, PathSegment,
} from '../../../src/rules/grammar/FirestoreAST.js';

export function makeRules(children: MatchBlock[], functions: FunctionDef[] = []): FirestoreRules {
  return {
    version: '2',
    imports: [],
    service: {
      name: 'cloud.firestore',
      match: {
        path: makePath('/databases/{database}/documents'),
        functions,
        allows: [],
        children,
      },
    },
  };
}

export function makeMatch(
  pathStr: string,
  opts: {
    allows?: AllowRule[];
    functions?: FunctionDef[];
    children?: MatchBlock[];
  } = {},
): MatchBlock {
  return {
    path: makePath(pathStr),
    allows: opts.allows || [],
    functions: opts.functions || [],
    children: opts.children || [],
  };
}

export function makeAllow(ops: Operation[], condition: Expression): AllowRule {
  return { operations: ops, condition };
}

export function makeFunction(name: string, params: string[], body: Expression, exported = false): FunctionDef {
  return { name, parameters: params, exported, lets: [], body };
}

export function makePath(raw: string): PathPattern {
  const segments: PathSegment[] = raw.split('/').filter(Boolean).map(seg => {
    if (seg.startsWith('{') && seg.endsWith('}')) {
      const inner = seg.slice(1, -1);
      if (inner.endsWith('=**')) return { type: 'recursive' as const, name: inner.slice(0, -3) };
      return { type: 'wildcard' as const, name: inner };
    }
    return { type: 'literal' as const, value: seg };
  });
  return { raw, segments };
}

// --- Expression builders ---

export const TRUE: Expression = { type: 'literal', value: true, raw: 'true' };
export const FALSE: Expression = { type: 'literal', value: false, raw: 'false' };
export const NULL: Expression = { type: 'literal', value: null, raw: 'null' };

export function ident(name: string): Expression {
  return { type: 'identifier', name };
}

export function member(obj: Expression, prop: string): Expression {
  return { type: 'memberAccess', object: obj, property: prop };
}

export function method(obj: Expression, name: string, args: Expression[] = []): Expression {
  return { type: 'methodCall', object: obj, method: name, args };
}

export function call(name: string, args: Expression[] = []): Expression {
  return { type: 'functionCall', name, args };
}

export function binOp(op: string, left: Expression, right: Expression): Expression {
  return { type: 'binaryOp', op, left, right };
}

export function unaryOp(op: string, operand: Expression): Expression {
  return { type: 'unaryOp', op, operand };
}

/** request.auth */
export const AUTH = member(ident('request'), 'auth');

/** request.auth != null */
export const AUTH_CHECK = binOp('!=', AUTH, NULL);

/** request.auth.uid */
export const AUTH_UID = member(AUTH, 'uid');

/** request.auth.uid == <expr> */
export function authUidEquals(expr: Expression): Expression {
  return binOp('==', AUTH_UID, expr);
}

/** request.resource.data */
export const REQ_DATA = member(member(ident('request'), 'resource'), 'data');

/** resource.data */
export const RES_DATA = member(ident('resource'), 'data');

/** request.auth != null && <expr> */
export function withAuthCheck(expr: Expression): Expression {
  return binOp('&&', AUTH_CHECK, expr);
}
