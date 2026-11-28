import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileBoundedModule } from '../src/policy/index.js';
import { parseToASTOrError } from '../src/grammar/FirestoreParser.js';

const tempDir = mkdtempSync(join(tmpdir(), 'pyric-bounded-module-'));
let modSeq = 0;
afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const prefix = 'use extension bounded;';
async function load(source: string) {
  const { moduleSource } = compileBoundedModule(prefix + source);
  const file = join(tempDir, `mod-${modSeq++}.mjs`);
  writeFileSync(file, moduleSource, 'utf8');
  return import(pathToFileURL(file).href);
}

test('emits portable pure functions with bounded lexical traversal and immutable updates', async () => {
  const source = `
    function twice(n) { return n * 2; }
    export function update(xs) {
      let changed = replaceAt(xs, 1, 7);
      return bounded.map(changed, n => twice(n), 2);
    }`;
  expect(parseToASTOrError(prefix + source).ok).toBe(false);
  const api = await load(source);
  const original = [1, 2];
  expect(api.update(original)).toEqual([2, 14]);
  expect(original).toEqual([1, 2]);
  expect(() => api.update([1, 2, 3])).toThrow(/bound/);
});

test('rejects unbound names, invalid arity, recursion and unsupported target input', () => {
  for (const source of [
    'export function f(x) { return true ? x : other; }',
    'export function f(x) { return size(); }',
    'export function f(x) { return f(x); }',
    'export function f(x) { return bounded.any(x, item => true, 99999); }',
  ])
    expect(() => compileBoundedModule(prefix + source)).toThrow();
  expect(() => compileBoundedModule('export function f(x){return x;}')).toThrow();
});

test('validates runtime types, checked indexing and literal map keys', async () => {
  const api = await load(
    'export function item(xs, i){return xs[i];} export function add(a,b){return a+b;} export function obj(x){return {"v":x};}',
  );
  expect(() => api.item([5], 1)).toThrow();
  expect(() => api.item({}, 'constructor')).toThrow();
  expect(() => api.add(3, '4')).toThrow();
  expect(api.obj(4)).toEqual({ v: 4 });
});

test('absorbs recoverable expression errors and preserves fatal budget errors', async () => {
  const api = await load(`
    export function or(x, control) { return x.missing || control; }
    export function and(x, control) { return x.missing && control; }
    export function tooLong(xs) { return bounded.any(xs, item => item, 1) || true; }
    export function skipped(xs) { return true || bounded.any(xs, item => item, 1); }
  `);
  expect(api.or({}, true)).toBe(true);
  expect(api.and({}, false)).toBe(false);
  expect(() => api.or({}, false)).toThrow(/own data/);
  expect(() => api.and({}, true)).toThrow(/own data/);
  expect(() => api.tooLong([false, false])).toThrow(/bound/);
  expect(api.skipped([false, false])).toBe(true);
});

test('accepts bounded plain input data and rejects cyclic or accessor inputs', async () => {
  const api = await load('export function echo(x) { return x; }');
  const cycle: unknown[] = [];
  cycle.push(cycle);
  expect(() => api.echo(cycle)).toThrow(/depth|cyclic/);
  let read = false;
  const item = {
    get value() {
      read = true;
      return 5;
    },
  };
  expect(() => api.echo(item)).toThrow(/data/);
  expect(read).toBe(false);
  expect(() => api.echo(Array(4097).fill(0))).toThrow(/bound/);
});

test('preserves error values in let bindings, arguments, containers and nested eager operands', async () => {
  const api = await load(`
    function choose(x,b){ return x || b; }
    export function local(x,b){ let bad=x.key; return choose(bad,b); }
    export function unused(x){let ignored=x.key; return true;}
    export function eager(x){return (x.key + size(range(999))) == 4 || true;}
    export function nested(x){return [x.key][0] || true;}
    export function exists(xs){return bounded.any(xs, x=>x.key, 3);}
  `);
  expect(api.local({},true)).toBe(true);
  expect(() => api.local({},false)).toThrow(/own data/);
  expect(api.unused({})).toBe(true);
  expect(() => api.eager({})).toThrow(/bound/);
  expect(api.nested({})).toBe(true);
  expect(api.exists([{}, {key:true}])).toBe(true);
  expect(() => api.exists([{}, {key:false}])).toThrow(/own data/);
});
