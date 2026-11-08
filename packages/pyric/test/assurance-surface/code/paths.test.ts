import { describe, expect, test } from 'bun:test';
import ts from 'typescript';
import { expressionName, functionName, hole, interpolate, mergeAuth, renderPath, segmentsOf } from '../../../src/assurance-surface/code/paths.js';
import { union, type AVal } from '../../../src/assurance-surface/code/values.js';

const parse = (text: string): ts.Expression => {
  const sf = ts.createSourceFile('x.ts', `(${text});`, ts.ScriptTarget.Latest, true);
  const stmt = sf.statements[0] as ts.ExpressionStatement;
  return (stmt.expression as ts.ParenthesizedExpression).expression;
};
const id = (v: AVal): AVal => v;
const str = (text: string): AVal => ({ k: 'str', parts: [{ kind: 'lit', text }] });

describe('expressionName', () => {
  test('names identifiers, members, calls and conditionals', () => {
    expect(expressionName(parse('roomId'))).toBe('roomId');
    expect(expressionName(parse('this.options.myId'))).toBe('myId');
    expect(expressionName(parse("data['owner']"))).toBe('owner');
    expect(expressionName(parse('user.uid.toString()'))).toBe('uid');
    expect(expressionName(parse("user ? user.uid : 'anon'"))).toBe('uid');
    expect(expressionName(parse('1 + 2'))).toBe('value');
  });
});

describe('functionName', () => {
  test('names declarations and the variable an arrow is assigned to', () => {
    const sf = ts.createSourceFile('x.ts', 'function f() {}\nconst g = () => 1;', ts.ScriptTarget.Latest, true);
    const f = sf.statements[0] as ts.FunctionDeclaration;
    const g = ((sf.statements[1] as ts.VariableStatement).declarationList.declarations[0].initializer) as ts.ArrowFunction;
    expect(functionName(f)).toBe("'f'");
    expect(functionName(g)).toBe("'g'");
  });
});

describe('segmentsOf', () => {
  test('splits literal text on slashes and keeps holes in place', () => {
    const v: AVal = { k: 'str', parts: [{ kind: 'lit', text: '/rooms/' }, hole('roomId'), { kind: 'lit', text: '/messages' }] };
    const [alt] = segmentsOf(v, parse('p'), true, id);
    expect(renderPath('firestore', alt.segments).path).toBe('rooms/{roomId}/messages');
  });

  test('an untraced whole path is one assumed segment, with a note', () => {
    const [alt] = segmentsOf({ k: 'unknown', reason: 'r' }, parse('path'), true, id);
    expect(renderPath('rtdb', alt.segments).path).toBe('$path');
    expect(alt.note).toContain("path argument 'path' was not traced");
  });

  test('a choice of one-segment values is one variable carrying their provenance', () => {
    const uid: AVal = { k: 'str', parts: [hole('uid', [{ source: 'auth.uid', exact: true }]), { kind: 'lit', text: ':tab' }] };
    const alts = segmentsOf(union([{ k: 'unknown', reason: 'r' }, uid]), parse('myId'), false, id);
    expect(alts).toHaveLength(1);
    expect(renderPath('rtdb', alts[0].segments)).toEqual({ path: '$myId', variables: [{ name: 'myId', auth: [{ source: 'auth.uid', certainty: 'partial' }] }] });
  });

  test('drops an absent alternative beside a real path', () => {
    const alts = segmentsOf(union([{ k: 'undefined' }, str('a/b')]), parse('p'), true, id);
    expect(alts.map((a) => renderPath('rtdb', a.segments).path)).toEqual(['a/b']);
  });

  test('a parameter whose callers pass whole paths expands to each path', () => {
    const sym: AVal = { k: 'sym', name: 'path', node: parse('p'), resolve: () => union([str('a/b'), str('c/d')]) };
    const force = (v: AVal): AVal => (v.k === 'sym' ? v.resolve() : v);
    const alts = segmentsOf(sym, parse('path'), true, force);
    expect(alts.map((a) => renderPath('rtdb', a.segments).path)).toEqual(['a/b', 'c/d']);
  });

  test('a parameter whose callers pass one segment stays a named variable', () => {
    const sym: AVal = { k: 'sym', name: 'roomId', node: parse('p'), resolve: () => union([str('r1'), str('r2')]) };
    const force = (v: AVal): AVal => (v.k === 'sym' ? v.resolve() : v);
    const [alt] = segmentsOf(sym, parse('roomId'), false, force);
    expect(renderPath('firestore', alt.segments).path).toBe('{roomId}');
  });
});

describe('interpolate', () => {
  test('splices multi-segment strings and names one-segment values after the expression', () => {
    expect(interpolate(str('a/b'), parse('x'), id)).toEqual([{ kind: 'lit', text: 'a/b' }]);
    const mixed: AVal = { k: 'str', parts: [{ kind: 'lit', text: 'evt_' }, hole('now')] };
    expect(interpolate(mixed, parse('eventId'), id)).toMatchObject([{ kind: 'hole', name: 'eventId' }]);
  });
});

describe('renderPath', () => {
  test('dedupes repeated variable names and renders the recursive wildcard', () => {
    const segs = [[hole('id')], [{ kind: 'lit' as const, text: 'x' }], [hole('id')]];
    expect(renderPath('rtdb', segs).path).toBe('$id/x/$id2');
    expect(renderPath('firestore', [[hole('path=**')], [{ kind: 'lit', text: 'projects' }]]).path).toBe('{path=**}/projects');
  });
});

describe('mergeAuth', () => {
  test('a hole that is only part of its segment is partial', () => {
    expect(mergeAuth([{ source: 'auth.uid', exact: true }], false)).toEqual([{ source: 'auth.uid', certainty: 'partial' }]);
    expect(mergeAuth([{ source: 'auth.uid', exact: true }], true)).toEqual([{ source: 'auth.uid', certainty: 'exact' }]);
  });
});
