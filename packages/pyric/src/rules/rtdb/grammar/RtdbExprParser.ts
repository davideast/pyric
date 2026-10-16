import type { Semantics } from 'ohm-js';
import {
  CHAINED_TERMS_MESSAGE,
  createRtdbExpressionSemantics,
  matchRtdbExpression,
} from '../expression-engine.js';
import type { ParsedExpression } from '../types.js';
import {
  UNTERMINATED_STRING_LITERAL,
  containsRawNewlineInRtdbString,
} from './string-literal.js';

let identifierSemantics: Semantics | undefined;

function getIdentifierSemantics(): Semantics {
  if (identifierSemantics) return identifierSemantics;
  const semantics = createRtdbExpressionSemantics();
  semantics.addOperation<string[]>('identifiers', {
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
  identifierSemantics = semantics;
  return semantics;
}

/** Production's text for a rule that contains `=` outside `==`, `===`, `!=`, `<=` and `>=`. */
export const ASSIGNMENT_MESSAGE = 'Rule expressions may not contain assignments.';

/** Whether expression text holds a single `=` outside a string or regular expression literal. */
function containsAssignment(raw: string): boolean {
  const withoutLiterals = raw.replace(
    /'(?:\\.|[^'\\])*'?|"(?:\\.|[^"\\])*"?|\/(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[a-zA-Z]*/g,
    '""',
  );
  return /(^|[^=!<>])=(?!=)/.test(withoutLiterals);
}

export function parseExpression(raw: string): ParsedExpression {
  if (containsRawNewlineInRtdbString(raw)) {
    return {
      raw,
      valid: false,
      errors: [{ code: 'PARSE_ERROR', message: UNTERMINATED_STRING_LITERAL }],
      warnings: [],
      referencedIdentifiers: [],
    };
  }

  const matched = matchRtdbExpression(raw);

  if (!matched.ok) {
    return {
      raw,
      valid: false,
      errors: [{ code: 'PARSE_ERROR', message: containsAssignment(raw) ? ASSIGNMENT_MESSAGE : matched.message }],
      warnings: [],
      referencedIdentifiers: [],
    };
  }

  let referencedIdentifiers: string[];
  try {
    referencedIdentifiers = (getIdentifierSemantics()(matched.match) as any).identifiers() as string[];
  } catch (error) {
    if (error instanceof RangeError) {
      return {
        raw,
        valid: false,
        errors: [{ code: 'PARSE_ERROR', message: CHAINED_TERMS_MESSAGE }],
        warnings: [],
        referencedIdentifiers: [],
      };
    }
    throw error;
  }
  const unique = [...new Set(referencedIdentifiers)];

  return {
    raw,
    valid: true,
    errors: [],
    warnings: [],
    referencedIdentifiers: unique,
  };
}
