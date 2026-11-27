import { expect, test } from 'bun:test';
import { compileFunction } from '../../src/policy/index.js';
import { firestoreRules } from '../../src/index.js';

const search = `use extension loops;
function firstStop(rows) {
  for (const key of ['a', 'b']) {
    if (rows[key]) return true;
  }
  return false;
}`;

test('ordered guards skip later errors and propagate earlier errors', () => {
  const first = compileFunction(search);
  expect(first({ a: true })).toBe(true);
  expect(first({ a: false, b: false })).toBe(false);
  expect(() => first({ b: true })).toThrow();
  expect(() => first({ a: false })).toThrow();
  expect(() => first({ a: 1, b: true })).toThrow();
  const fn = first.firestoreModule().split('export function')[1];
  const rules = firestoreRules(`rules_version = '2'; service cloud.firestore {
    match /databases/{db}/documents { function${fn}
      match /items/{id} { allow create: if firstStop(request.resource.data); }
    }
  }`);
  const cases = [{a:true}, {a:false}, {b:true}, {a:false,b:true}, {a:false,b:false}, {a:1,b:true}];
  const decisions = rules.simulate(cases.map(data => ({
    description: JSON.stringify(data), method:'create' as const, path:'items/one', data, expectation:'ALLOW' as const,
  }))).cases.map(c => c.decision);
  expect(decisions).toEqual(['ALLOW','DENY','DENY','ALLOW','DENY','DENY']);
});

test('each item checks its guards in source order until the first taken return', () => {
  const classify = compileFunction(`use extension loops; function classify(items) {
    for (const key of ['a', 'b']) {
      if (items[key].stop) return 'stop';
      if (items[key].reject) return 'reject';
      if (items[key].accept) return 'accept';
    }
    return 'other';
  }`);
  const next = Object.freeze({stop: false, reject: false, accept: false});
  for (const [items, expected] of [
    [{a: {stop: true, reject: true}}, 'stop'],
    [{a: {stop: false, reject: true, accept: true}, b: {stop: true}}, 'reject'],
    [{a: {stop: false, reject: false, accept: true}}, 'accept'],
    [{a: next, b: {stop: true}}, 'stop'],
    [{a: next, b: next}, 'other'],
  ] as const) {
    expect(classify(Object.freeze(items))).toBe(expected);
  }
  expect(() => classify({a: {stop: false}, b: {stop: true}})).toThrow('reject');
  expect(() => classify({a: {stop: false, reject: 1, accept: true}})).toThrow();
  const rules = firestoreRules(`rules_version = '2'; service cloud.firestore {
    match /databases/{db}/documents {
      function${classify.firestoreModule().split('export function')[1]}
      match /items/{id} { allow create: if classify(request.resource.data.items) == request.resource.data.claim; }
    }
  }`);
  const items = {a: {stop: false, reject: true, accept: true}, b: {stop: true}};
  const claims = ['stop', 'reject', 'accept'];
  expect(rules.simulate(claims.map(claim => ({ description: claim, method: 'create' as const,
    path: 'items/one', data: {items, claim}, expectation: 'ALLOW' as const }))).cases.map(c => c.decision))
    .toEqual(['DENY', 'ALLOW', 'DENY']);
});

test('a later guard participates in scope checks, value semantics and both budget proofs', () => {
  const source = `use extension loops; function check(data) {
    for (const v of [0]) { if (false) return false; if (data == {"n": [-0.0]}) return true; }
    return false;
  }`;
  expect(compileFunction(source)({n: [-0]})).toBe(true);
  expect(compileFunction(source)({n: [0]})).toBe(false);
  expect(() => compileFunction(source.replace('if (data ==', 'if (unknown =='))).toThrow('Undeclared binding');
  expect(() => compileFunction(source.replace('return true;', 'return 9223372036854775808;')))
    .toThrow('Invalid number literal');
  const small = 'use extension loops; function check(){for(const v of [false]){if(v)return false;if(v)return true;}return false;}';
  expect(() => compileFunction(small, {expressionLimit: 5})()).toThrow('expression units');
  expect(() => compileFunction(small, {expressionLimit: 5}).firestoreModule()).toThrow('source expression budget');
  expect(compileFunction(small, {expressionLimit: 6}).firestoreModule()).toContain('export function');
  const large = small.replace('[false]', '[' + Array(160).fill('false').join(',') + ']');
  expect(compileFunction(large)()).toBe(false);
  expect(() => compileFunction(large).firestoreModule()).toThrow('1000-expression budget');
  const oneGuard = small.replace('if(v)return true;', '').replace('[false]', '[' + Array(180).fill('false').join(',') + ']');
  expect(() => compileFunction(oneGuard).firestoreModule()).toThrow('1000-expression budget');
  const guarded = source.replace('[0]', 'bounded(data.values, 2)');
  const over = [0, 0, 0];
  Object.defineProperty(over, 0, {get() { throw Error('element visited'); }});
  expect(() => compileFunction(guarded)({values: over})).toThrow('exceeds declared bound 2');
  for (const invalid of [small.replace('if(v)return true;', 'v = true;'), small.replace('if(v)return false;', 'v = false;')]) {
    expect(() => compileFunction(invalid)).toThrow();
  }
});

test('ordered accumulators accept empty input and enforce a checked bound before iterating', () => {
  const fold = compileFunction(`use extension loops; function join(items) {
    let acc = '';
    for (const item of bounded(items, 3)) { acc = acc + item; }
    return acc;
  }`);
  expect(fold([])).toBe('');
  expect(fold(['a','b','c'])).toBe('abc');
  expect(() => fold(['a','b','c','d'])).toThrow('exceeds declared bound 3');
  const first = compileFunction(search.replace("['a', 'b']", 'bounded(keys, 2)').replace('(rows)', '(rows, keys)'));
  expect(() => first({a:true}, ['a','b','c'])).toThrow('exceeds declared bound 2');
  expect(() => first({}, 'abc')).toThrow('requires a list');
  expect(() => fold.firestoreModule()).toThrow('ordered accumulator');
  const helper = first.firestoreModule().split('export function')[1];
  const rules = firestoreRules(`rules_version = '2'; service cloud.firestore {
    match /databases/{db}/documents { function${helper}
      match /items/{id} { allow create: if firstStop(request.resource.data.rows, request.resource.data.keys); }
    }
  }`);
  const keys = [['a'], ['a','missing'], ['missing','a'], [], ['a','b','c'], 'a'];
  expect(rules.simulate(keys.map(keys => ({description:JSON.stringify(keys),method:'create' as const,
    path:'items/test',data:{keys,rows:{a:true}},expectation:'ALLOW' as const}))).cases.map(c=>c.decision))
    .toEqual(['ALLOW','ALLOW','DENY','DENY','DENY','DENY']);
});

test('loop syntax, scope, and finite bounds are checked before invocation', () => {
  expect(() => compileFunction(search.replace('use extension loops;', ''))).toThrow('use extension loops');
  expect(() => compileFunction(search.replace("['a', 'b']", 'rows'))).toThrow('cannot prove');
  expect(() => compileFunction(search.replace("['a', 'b']", 'bounded(rows, 401)'))).toThrow('1..400');
  expect(() => compileFunction(search.replace('key of', 'rows of'))).toThrow('Duplicate binding');
  expect(() => compileFunction(search.replace('if (rows[key]) return true;', 'rows = key;'))).toThrow('local accumulator');
  expect(() => compileFunction(search.replace('return false;', 'return key;'))).toThrow('Undeclared binding');
  expect(() => compileFunction(search.replace('rows[key]', 'missing'))).toThrow('Undeclared binding');
});

test('new keywords have token boundaries and do not reserve existing Rules identifiers', () => {
  expect(() => compileFunction(search.replace('const key', 'constkey'))).toThrow();
  expect(() => compileFunction(search.replace('use extension loops;', 'useextensionloops;'))).toThrow();
  expect(compileFunction('function of(loops) { return loops; }')('ok')).toBe('ok');
});

test('an unused source expression cannot hide a collection error during emission', () => {
  const computed = compileFunction(`use extension loops; function check(rows) {
    for (const key of ['a', rows.missing]) { if (true) return true; }
    return false;
  }`);
  expect(() => computed({})).toThrow();
  expect(() => computed.firestoreModule()).toThrow('computed list elements');
  const big = compileFunction(`use extension loops; function check(value) {
    for (const k of [9223372036854775807]) { if (value == k) return true; }
    return false;
  }`);
  expect(big(9223372036854775807n)).toBe(true);
  expect(big.firestoreModule()).toContain('9223372036854775807');
  expect(() => compileFunction(`use extension loops; function check() {
    for (const k of [9223372036854775808]) { if (true) return true; }
    return false;
  }`)).toThrow('9223372036854775808');
});

test('a constant list can be empty, and a large expansion keeps its standalone verdict', () => {
  const empty = compileFunction(search.replace("['a', 'b']", '[]'));
  expect(empty({})).toBe(false);
  expect(empty.firestoreModule()).toContain('return false;');
  const large = compileFunction(search.replace("['a', 'b']", '[' + Array(400).fill("'a'").join(',') + ']'));
  expect(large({a:false})).toBe(false);
  expect(() => large.firestoreModule()).toThrow('1000-expression budget');
});

test('emission proves the source budget including eager locals, the list, and each visit', () => {
  const source = 'use extension loops; function demo(){for(const x of [true]){if(x)return true;}return false;}';
  for (const expressionLimit of [1, 4]) {
    const check = compileFunction(source, { expressionLimit });
    expect(() => check()).toThrow('expression units');
    expect(() => check.firestoreModule()).toThrow('source expression budget');
  }
  expect(compileFunction(source, { expressionLimit: 5 }).firestoreModule()).toContain('export function');
  const longer = source.replace('[true]', '[false, false]').replace('for(', 'let cost = 1 + 2; for(');
  const short = compileFunction(longer, { expressionLimit: 10 });
  expect(() => short()).toThrow('expression units');
  expect(() => short.firestoreModule()).toThrow('source expression budget');
  expect(compileFunction(longer, { expressionLimit: 11 }).firestoreModule()).toContain('export function');
});

test('substituting a loop item preserves nested unary groups without sharing parentheses between references', () => {
  const fn = compileFunction(`use extension loops; function grouped() {
    for (const x of [1]) { if (-(-x) == (x)) return -(-(-x)) == -1; }
    return false;
  }`);
  expect(fn()).toBe(true);
  const module = fn.firestoreModule();
  expect(module).toContain('-(-1) == (1) ? -(-(-1)) == -1');
  expect(fn.firestoreModule()).toEqual(module);
  const closed = compileFunction('use extension loops; function closed(){for(const x of [1]){if(-(-1)==1)return true;}return false;}');
  expect(closed.firestoreModule()).toContain('-(-1) == 1');
});

test('opted-in host inputs use Firestore numeric tags through maps and arrays', () => {
  const fn = compileFunction(`use extension loops; function typed(data) {
    for (const k of [0]) { if (data.values[k] is int) return true; }
    return false;
  }`);
  const rules = firestoreRules(`rules_version = '2'; service cloud.firestore {
    match /databases/{db}/documents { function${fn.firestoreModule().split('export function')[1]}
      match /items/{id} { allow create: if typed(request.resource.data); }
    }
  }`);
  for (const [value, expected] of [[-0, false], [0, true], [2 ** 53, false], [1.5, false]] as const) {
    const data = {values: [value]};
    expect(fn(data)).toBe(expected);
    expect(rules.simulate([{description:'typed input', method:'create', path:'items/one', data, expectation:'ALLOW'}])
      .cases[0].decision).toEqual(expected ? 'ALLOW' : 'DENY');
  }
  expect(compileFunction('function plain(v) { return v is int; }')(-0)).toBe(true);
});

test('the int64 minimum exception requires direct unparenthesized negation even in an empty loop', () => {
  const source = 'use extension loops; function min(){for(const x of []){if(true)return -(9223372036854775808);}return true;}';
  expect(() => compileFunction(source)).toThrow('Invalid number literal 9223372036854775808');
  const legal = compileFunction(source.replace('-(9223372036854775808)', '-9223372036854775808'));
  expect(legal()).toBe(true);
  expect(legal.firestoreModule()).toContain('return true;');
});

test('a checked bound reads no rejected elements and a successful first guard skips the tail', () => {
  const first = compileFunction(`use extension loops; function first(data) {
    for (const v of bounded(data.values, 2)) { if (v is float) return true; }
    return false;
  }`);
  const reads: string[] = [];
  function tracked(values: number[]) {
    return new Proxy(values, { get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads.push(key);
      return Reflect.get(target, key, receiver);
    }});
  }
  expect(() => first({values: tracked([-0, 1, 2])})).toThrow('exceeds declared bound 2');
  expect(reads).toEqual([]);
  expect(first({values: tracked([-0, 1])})).toBe(true);
  expect(reads).toEqual(['0']);
});

test('consumed collection comparisons and methods keep nested SDK numeric tags', () => {
  for (const predicate of ['!(0 in data.list)', 'data == {"list": [-0.0]}', 'data.list.removeAll([0]).size() == 1']) {
    const fn = compileFunction(`use extension loops; function check(data) {
      for (const key of [0]) { if (${predicate}) return true; }
      return false;
    }`);
    expect(fn({list:[-0]})).toBe(true);
    expect(fn({list:[0]})).toBe(false);
  }
});

test('an expanded helper is checked against the Firestore UTF-8 byte limit before parsing', () => {
  const source = `use extension loops; function repeated() {
    for (const x of ['${'界'.repeat(3500)}']) { if ([${Array(26).fill('x').join(',')}].size() == 26) return true; }
    return false;
  }`;
  const fn = compileFunction(source);
  expect(fn()).toBe(true);
  expect(() => fn.firestoreModule()).toThrow('Total size of sources must be smaller than 262144');
});

test('a short checked fold preserves order, length and the previous accumulator', () => {
  const source = `use extension loops; function calc(foldSize, items) {
    let foldStep1 = foldSize;
    for (const foldInBounds of bounded(items, 2)) { foldStep1 = foldStep1 * 10 + foldInBounds; }
    return foldStep1;
  }`;
  const fold = compileFunction(source);
  const fn = fold.firestoreModule().split('export function')[1];
  const rules = firestoreRules(`rules_version = '2'; service cloud.firestore {
    match /databases/{db}/documents { function${fn}
      match /items/{id} { allow create: if calc(0, request.resource.data.list) == request.resource.data.claim; }
    }
  }`);
  const inputs = [
    {list:[], claim:0}, {list:[7], claim:7}, {list:[1,2], claim:12},
    {list:[2,1], claim:12}, {list:[1,2,0], claim:12}, {list:[1,2,0], claim:null},
    {list:'', claim:null},
  ];
  expect(inputs.map(({list,claim}) => {
    try { return Number(fold(0,list)) === claim; } catch { return false; }
  })).toEqual([true,true,true,false,false,false,false]);
  expect(rules.simulate(inputs.map(data => ({description:JSON.stringify(data), method:'create' as const,
    path:'items/test', data, expectation:'ALLOW' as const}))).cases.map(c => c.decision))
    .toEqual(['ALLOW','ALLOW','ALLOW','DENY','DENY','DENY','DENY']);
  expect(() => compileFunction(source,{expressionLimit:1}).firestoreModule()).toThrow('budget');
  expect(() => compileFunction(source.replace('foldStep1 * 10 + foldInBounds', 'foldInBounds')).firestoreModule())
    .toThrow('observes the previous accumulator');
});
