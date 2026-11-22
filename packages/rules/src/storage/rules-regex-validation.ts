import { re2PatternProblem } from '../simulator/re2-pattern-check.js';
import type { Expr, MatchBlock } from './rules.js';

function validateExpressionRegexes(expression: Expr): void {
  if (
    expression.kind === 'methodcall' &&
    expression.method === 'matches' &&
    expression.args.length === 1
  ) {
    const arg = expression.args[0];
    let problem: string | null = null;
    if (arg?.kind === 'literal' && typeof arg.value === 'string') {
      problem = re2PatternProblem(arg.value);
    }
    if (problem !== null) {
      throw new SyntaxError(`Storage rules do not compile: ${problem}`);
    }
  }
  switch (expression.kind) {
    case 'member':
      validateExpressionRegexes(expression.target);
      return;
    case 'index':
      validateExpressionRegexes(expression.target);
      validateExpressionRegexes(expression.index);
      return;
    case 'slice':
      validateExpressionRegexes(expression.target);
      validateExpressionRegexes(expression.start);
      validateExpressionRegexes(expression.end);
      return;
    case 'unary':
      validateExpressionRegexes(expression.arg);
      return;
    case 'ternary':
      validateExpressionRegexes(expression.cond);
      validateExpressionRegexes(expression.then);
      validateExpressionRegexes(expression.else);
      return;
    case 'in':
      validateExpressionRegexes(expression.element);
      validateExpressionRegexes(expression.collection);
      return;
    case 'is':
      validateExpressionRegexes(expression.value);
      return;
    case 'list':
      for (const value of expression.elements) validateExpressionRegexes(value);
      return;
    case 'map':
      for (const { key, value } of expression.entries) {
        validateExpressionRegexes(key);
        validateExpressionRegexes(value);
      }
      return;
    case 'binary':
      validateExpressionRegexes(expression.left);
      validateExpressionRegexes(expression.right);
      return;
    case 'call':
      for (const value of expression.args) validateExpressionRegexes(value);
      return;
    case 'methodcall':
      validateExpressionRegexes(expression.target);
      for (const value of expression.args) validateExpressionRegexes(value);
      return;
    case 'path':
      for (const segment of expression.segments) {
        if (segment.kind === 'interp') validateExpressionRegexes(segment.expr);
      }
      return;
    case 'ident':
    case 'literal':
      return;
  }
}

export function validateMatchRegexes(match: MatchBlock): void {
  for (const { condition } of match.allows) {
    if (condition) validateExpressionRegexes(condition);
  }
  for (const fn of match.functions) {
    for (const binding of fn.lets) {
      validateExpressionRegexes(binding.value);
    }
    validateExpressionRegexes(fn.body);
  }
  for (const child of match.children) {
    validateMatchRegexes(child);
  }
}
