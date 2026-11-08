import { describe, expect, test } from 'bun:test';
import { evalBinary, evalPrefixUnary, evalTypeOf, unwrapExpr } from '../../../src/assurance-surface/code/operators.js';
import { literalText } from '../../../src/assurance-surface/code/values.js';
import ts from 'typescript';
import { harness } from './harness.js';

describe('operators', () => {
  test('evalTypeOf maps abstract kinds to JavaScript typeof literals and preserves unknown holes', () => {
    const h = harness({
      'a.ts': `
        declare const dyn: unknown;
        const s = typeof 'abc';
        const n = typeof 42;
        const b = typeof false;
        const u = typeof undefined;
        const o = typeof { a: 1 };
        const fn = typeof (() => 1);
        const unk = typeof dyn;
      `,
    });
    const toOperand = (src: string) => (h.expr('a.ts', src) as ts.TypeOfExpression).expression;
    expect(literalText(evalTypeOf(h.ev, toOperand("typeof 'abc'"), undefined))).toBe('string');
    expect(literalText(evalTypeOf(h.ev, toOperand('typeof 42'), undefined))).toBe('number');
    expect(literalText(evalTypeOf(h.ev, toOperand('typeof false'), undefined))).toBe('boolean');
    expect(literalText(evalTypeOf(h.ev, toOperand('typeof undefined'), undefined))).toBe('undefined');
    expect(literalText(evalTypeOf(h.ev, toOperand('typeof { a: 1 }'), undefined))).toBe('object');
    expect(literalText(evalTypeOf(h.ev, toOperand('typeof (() => 1)'), undefined))).toBe('function');
    expect(literalText(evalTypeOf(h.ev, toOperand('typeof dyn'), undefined))).toBeNull();
  });

  test('evalPrefixUnary folds logical negation, unary minus, and unary plus', () => {
    const h = harness({
      'a.ts': `
        const negTrue = !true;
        const negEmpty = !'';
        const minusFive = -5;
        const plusThree = +3;
      `,
    });
    const toUnary = (src: string) => h.expr('a.ts', src) as ts.PrefixUnaryExpression;
    expect(evalPrefixUnary(h.ev, toUnary('!true'), undefined)).toEqual({ k: 'bool', value: false });
    expect(evalPrefixUnary(h.ev, toUnary("!''"), undefined)).toEqual({ k: 'bool', value: true });
    expect(evalPrefixUnary(h.ev, toUnary('-5'), undefined)).toEqual({ k: 'num', value: -5 });
    expect(evalPrefixUnary(h.ev, toUnary('+3'), undefined)).toEqual({ k: 'num', value: 3 });
  });

  test('evalBinary folds strict/loose equality, short-circuit && / || / ??, and in checks', () => {
    const h = harness({
      'a.ts': `
        const rec = { tag: 'live', count: 0 };
        const eqNull = null == undefined;
        const strictNeq = null === undefined;
        const andFalsy = '' && 'fallback';
        const orTruthy = 'primary' || 'secondary';
        const nullishZero = rec.count ?? 99;
        const hasTag = 'tag' in rec;
        const missingKey = 'absent' in rec;
      `,
    });
    const toBin = (src: string) => h.expr('a.ts', src) as ts.BinaryExpression;
    expect(evalBinary(h.ev, toBin('null == undefined'), undefined)).toEqual({ k: 'bool', value: true });
    expect(evalBinary(h.ev, toBin('null === undefined'), undefined)).toEqual({ k: 'bool', value: false });
    expect(literalText(evalBinary(h.ev, toBin("'' && 'fallback'"), undefined))).toBe('');
    expect(literalText(evalBinary(h.ev, toBin("'primary' || 'secondary'"), undefined))).toBe('primary');
    expect(evalBinary(h.ev, toBin('rec.count ?? 99'), undefined)).toEqual({ k: 'num', value: 0 });
    expect(evalBinary(h.ev, toBin("'tag' in rec"), undefined)).toEqual({ k: 'bool', value: true });
    expect(evalBinary(h.ev, toBin("'absent' in rec"), undefined)).toEqual({ k: 'bool', value: false });
  });

  test('unwrapExpr strips parentheses, type assertions, and non-null assertions', () => {
    const h = harness({
      'a.ts': `const val = (('hello' as string))!;`,
    });
    const outer = h.expr('a.ts', "(('hello' as string))!");
    const inner = unwrapExpr(outer);
    expect(ts.isStringLiteral(inner)).toBe(true);
  });
});
