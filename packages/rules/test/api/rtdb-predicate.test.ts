import { expect, test } from 'bun:test';
import { compileFunction } from '../../src/policy/index.js';
import { rtdbRules } from '../../src/api/rtdb.js';

test('RTDB predicate expands local arithmetic and reads typed numeric leaves on both snapshots', () => {
  const check = compileFunction('function within(a,b) { let dx = b.x - a.x; return dx * dx <= 4; }');
  const rule = check.rtdbNumericPredicate({a: {snapshot:'data'}, b: {snapshot:'newData'}});
  const rules = rtdbRules({rules:{item:{'.write':true,'.validate':rule}}});
  for (const [x, expected] of [[2, 'ALLOW'], [2.1, 'DENY'], ['2', 'DENY'], [null, 'DENY']] as const) {
    const [result] = rules.simulate([{path:'/item', operation:'write', expectation:expected,
      data:{item:{x:0}}, newData:{x, keep:true}}]).cases;
    expect(result?.decision).toBe(expected);
  }
});

test('RTDB predicate refuses unsupported code, unsafe bindings, and excessive expansion', () => {
  const input = {x:{snapshot:'data' as const}};
  const lower = (body: string) => compileFunction('function f(x) {' + body + '}').rtdbNumericPredicate(input);
  expect(() => lower('return x / 2 == 1;')).toThrow();
  expect(() => lower('return x + 1;')).toThrow();
  expect(() => lower('return x == true;')).toThrow();
  expect(() => lower('return false ? x.keys() : true;')).toThrow();
  expect(() => compileFunction('function f(x) {return x==1;}').rtdbNumericPredicate({})).toThrow();
  expect(() => compileFunction('function f(x) {return x==1;}')
    .rtdbNumericPredicate({x:{snapshot:'data',path:'x") || true'}})).toThrow();
  let body = 'let a0 = x;';
  for (let i = 1; i <= 16; i++) body += 'let a'+i+' = a'+(i-1)+' + a'+(i-1)+';';
  expect(() => lower(body+'return a16 == 1;')).toThrow(/limit/);
});
