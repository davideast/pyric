import { describe, expect, test } from 'bun:test';
import {
  alternatives,
  authMarksOf,
  concatParts,
  constraintKey,
  literalText,
  MAX_UNION,
  ownRecordValue,
  union,
  unknown,
  type AVal,
} from '../../../src/assurance-surface/code/values.js';

const str = (text: string): AVal => ({ k: 'str', parts: [{ kind: 'lit', text }] });
const uid = (exact = true): AVal => ({ k: 'str', parts: [{ kind: 'hole', name: 'uid', auth: [{ source: 'auth.uid', exact }] }] });

describe('union', () => {
  test('flattens, drops never, dedupes equal leaves', () => {
    const v = union([str('a'), { k: 'never' }, union([str('a'), str('b')])]);
    expect(alternatives(v).map(literalText)).toEqual(['a', 'b']);
  });

  test('a single alternative is returned as itself; none is never', () => {
    expect(union([str('a')])).toEqual(str('a'));
    expect(union([])).toEqual({ k: 'never' });
  });

  test('too many alternatives collapse to unknown with a reason', () => {
    const v = union(Array.from({ length: MAX_UNION + 1 }, (_, i) => str(`s${i}`)));
    expect(v).toEqual(unknown(`more than ${MAX_UNION} possible values`));
  });
});

describe('alternatives', () => {
  test('flattens a nested union built by hand', () => {
    const nested: AVal = { k: 'union', alts: [str('a'), { k: 'union', alts: [str('b'), str('c')] }] };
    expect(alternatives(nested).map(literalText)).toEqual(['a', 'b', 'c']);
  });
});

describe('concatParts', () => {
  test('merges adjacent literals and drops empty ones', () => {
    expect(concatParts([{ kind: 'lit', text: 'a/' }], [{ kind: 'lit', text: '' }, { kind: 'lit', text: 'b' }])).toEqual([{ kind: 'lit', text: 'a/b' }]);
  });
});

describe('authMarksOf', () => {
  test('the uid alone is exact', () => {
    expect(authMarksOf(uid())).toEqual([{ source: 'auth.uid', exact: true }]);
  });

  test('uid or a literal fallback is partial', () => {
    expect(authMarksOf(union([uid(), str('')]))).toEqual([{ source: 'auth.uid', exact: false }]);
  });

  test('a uid inside a larger string is partial', () => {
    const v: AVal = { k: 'str', parts: [...(uid() as { parts: never[] }).parts, { kind: 'lit', text: ':tab' }] };
    expect(authMarksOf(v)).toEqual([{ source: 'auth.uid', exact: false }]);
  });

  test('displayName or email is partly each', () => {
    const name: AVal = { k: 'str', parts: [{ kind: 'hole', name: 'displayName', auth: [{ source: 'auth.displayName', exact: true }] }] };
    const email: AVal = { k: 'str', parts: [{ kind: 'hole', name: 'email', auth: [{ source: 'auth.email', exact: true }] }] };
    expect(authMarksOf(union([name, email]))).toEqual([
      { source: 'auth.displayName', exact: false },
      { source: 'auth.email', exact: false },
    ]);
  });
});

describe('ownRecordValue', () => {
  test('returns own keys and ignores Object.prototype properties', () => {
    const table: Readonly<Record<string, string>> = { doc: 'docSpec' };
    expect(ownRecordValue(table, 'doc')).toBe('docSpec');
    expect(ownRecordValue(table, 'toString')).toBeUndefined();
    expect(ownRecordValue(table, 'constructor')).toBeUndefined();
    expect(ownRecordValue(undefined, 'doc')).toBeUndefined();
  });
});

describe('constraintKey', () => {
  test('distinguishes runtime literal types across null, number, boolean, and string operands', () => {
    const keys = [
      constraintKey({ kind: 'where', field: 'v', op: '==', operand: { kind: 'literal', literal: null } }),
      constraintKey({ kind: 'where', field: 'v', op: '==', operand: { kind: 'literal', literal: 'null' } }),
      constraintKey({ kind: 'where', field: 'v', op: '==', operand: { kind: 'literal', literal: 5 } }),
      constraintKey({ kind: 'where', field: 'v', op: '==', operand: { kind: 'literal', literal: '5' } }),
      constraintKey({ kind: 'where', field: 'v', op: '==', operand: { kind: 'literal', literal: true } }),
      constraintKey({ kind: 'where', field: 'v', op: '==', operand: { kind: 'literal', literal: 'true' } }),
    ];
    expect(new Set(keys).size).toBe(6);
  });
});
