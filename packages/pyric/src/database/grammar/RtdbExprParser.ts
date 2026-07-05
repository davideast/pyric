import * as ohm from 'ohm-js';
import { RTDB_EXPR_OHM_SOURCE } from './RtdbExpr.ohm.generated.js';
import type { ParsedExpression } from '../types.js';

// Grammar inlined at SDK build time — see scripts/inline-grammar.ts.
export const grammar = ohm.grammar(RTDB_EXPR_OHM_SOURCE);

const identifierSemantics = grammar.createSemantics();
identifierSemantics.addOperation<string[]>('identifiers', {
  _nonterminal(...children) {
    return children.flatMap(c => (c as any).identifiers());
  },
  _iter(...children) {
    return children.flatMap(c => (c as any).identifiers());
  },
  _terminal() {
    return [];
  },
  CallExpr_methodCall(receiver, _dot, _methodName, _open, args, _close) {
    // Skip _methodName — it's a method, not a root identifier
    return [
      ...(receiver as any).identifiers(),
      ...args.asIteration().children.flatMap((a: any) => (a as any).identifiers()),
    ];
  },
  CallExpr_memberAccess(receiver, _dot, _memberName) {
    // Skip _memberName — it's a property, not a root identifier
    return (receiver as any).identifiers();
  },
  ident(_dollar, _start, _rest) {
    return [this.sourceString];
  },
});

export function parseExpression(raw: string): ParsedExpression {
  const trimmed = raw.trim();
  const match = grammar.match(trimmed);

  if (match.failed()) {
    return {
      raw,
      valid: false,
      errors: [{ code: 'PARSE_ERROR', message: match.message ?? 'Parse failed' }],
      warnings: [],
      referencedIdentifiers: [],
    };
  }

  const referencedIdentifiers = (identifierSemantics(match) as any).identifiers() as string[];
  const unique = [...new Set(referencedIdentifiers)];

  return {
    raw,
    valid: true,
    errors: [],
    warnings: [],
    referencedIdentifiers: unique,
  };
}
