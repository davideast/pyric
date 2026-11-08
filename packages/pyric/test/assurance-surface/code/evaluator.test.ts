import { describe, expect, test } from 'bun:test';
import { harness } from './harness.js';
import { alternatives, literalText, renderParts, type AVal } from '../../../src/assurance-surface/code/values.js';

const text = (v: AVal): string[] => alternatives(v).map((a) => (a.k === 'str' ? renderParts(a.parts) : a.k));

describe('Evaluator', () => {
  test('constants, templates and concatenation across modules', () => {
    const h = harness({
      'config.ts': `export const ROOT = 'app'; export const ROOMS = \`\${ROOT}/rooms\`;`,
      'use.ts': `import { ROOMS } from './config'; export const f = (id: string) => ROOMS + '/' + id + \`/x\`;`,
    });
    const v = h.ev.eval(h.expr('use.ts', "ROOMS + '/' + id + `/x`"));
    expect(text(v)).toEqual(['app/rooms/{id}/x']);
  });

  test('let with several assignments, and const enums', () => {
    const h = harness({
      'a.ts': `
        enum Kind { A = 'a', B = 'b' }
        let p = 'x';
        if (Math.random()) p = 'y';
        const k = Kind.B;
        p; k;
      `,
    });
    expect(text(h.ev.eval(h.ident('a.ts', 'p', 2)))).toEqual(['x', 'y']);
    expect(text(h.ev.eval(h.ident('a.ts', 'k', 1)))).toEqual(['b']);
  });

  test('inlines an in-project function, binding parameters to the call arguments', () => {
    const h = harness({
      'a.ts': `
        function path(kind: string, id: string) { const base = \`items/\${kind}\`; return \`\${base}/\${id}\`; }
        export const p = (itemId: string) => path('todo', itemId);
      `,
    });
    expect(text(h.ev.eval(h.expr('a.ts', "path('todo', itemId)")))).toEqual(['items/todo/{itemId}']);
  });

  test('an unbound parameter is deferred and resolves to what its callers pass', () => {
    const h = harness({
      'a.ts': `
        export function f(x: string) { return x; }
        f('one'); f('two');
      `,
    });
    const v = h.ev.eval(h.ident('a.ts', 'x', 1));
    expect(v.k).toBe('sym');
    expect(text(h.ev.force(v))).toEqual(['one', 'two']);
  });

  test('parameters that hand each other along terminate', () => {
    const h = harness({
      'a.ts': `
        export function a(x: string): string { return b(x); }
        export function b(y: string): string { return a(y); }
        a('seed');
      `,
    });
    const v = h.ev.force(h.ev.eval(h.ident('a.ts', 'y', 1)));
    expect(text(v)).toContain('seed');
  });

  test('a step budget stops a trace with a reason instead of running on', () => {
    const h = harness({ 'a.ts': `const a = 'x'; const b = a; const c = b; c;` });
    h.ev.startBudget(2);
    const v = h.ev.eval(h.ident('a.ts', 'c', 1));
    expect(JSON.stringify(v)).toContain('trace budget exhausted');
  });

  test('React useState: the state is the initial value or anything passed to its setter', () => {
    const h = harness({
      'a.tsx': `
        import { useState } from 'react';
        export function C() {
          const [mode, setMode] = useState('a');
          const go = () => setMode('b');
          return mode;
        }
      `,
    });
    expect(text(h.ev.eval(h.ident('a.tsx', 'mode', 1)))).toEqual(['a', 'b']);
  });

  test('calling something that is not a function is infeasible, not unknown', () => {
    const h = harness({ 'a.ts': `const r = { x: 1 }; const v = (r as any)(); v;` });
    expect(h.ev.eval(h.ident('a.ts', 'v', 1))).toEqual({ k: 'never' });
  });

  test('returnsOf folds definite if-branches and unions indeterminate branches', () => {
    const h = harness({
      'a.ts': `
        declare const coin: boolean;
        function f(b: boolean) { if (b) return 'x'; return 'y'; }
        f(true);
        f(false);
        f(coin);
      `,
    });
    expect(alternatives(h.ev.eval(h.expr('a.ts', 'f(true)'))).map(literalText)).toEqual(['x']);
    expect(alternatives(h.ev.eval(h.expr('a.ts', 'f(false)'))).map(literalText)).toEqual(['y']);
    expect(alternatives(h.ev.eval(h.expr('a.ts', 'f(coin)'))).map(literalText)).toEqual(['x', 'y']);
  });

  test('constant-folds typeof, equality, boolean logic, and conditionals', () => {
    const h = harness({
      'a.ts': `
        const obj = { a: 1 };
        const tObj = typeof obj;
        const tBool = typeof true;
        const tNull = typeof null;
        const eq1 = typeof obj === 'object' && obj !== null && !('missing' in obj);
        const eq2 = typeof 'hi' !== 'object';
        const pick = eq1 ? 'yes' : 'no';
        const nullish = (null as string | null) ?? 'fallback';
        const nonNullish = 'kept' ?? 'fallback';
      `,
    });
    expect(literalText(h.ev.eval(h.ident('a.ts', 'tObj', 0)))).toBe('object');
    expect(literalText(h.ev.eval(h.ident('a.ts', 'tBool', 0)))).toBe('boolean');
    expect(literalText(h.ev.eval(h.ident('a.ts', 'tNull', 0)))).toBe('object');
    expect(h.ev.eval(h.ident('a.ts', 'eq1', 0))).toEqual({ k: 'bool', value: true });
    expect(h.ev.eval(h.ident('a.ts', 'eq2', 0))).toEqual({ k: 'bool', value: true });
    expect(literalText(h.ev.eval(h.ident('a.ts', 'pick', 0)))).toBe('yes');
    expect(literalText(h.ev.eval(h.ident('a.ts', 'nullish', 0)))).toBe('fallback');
    expect(literalText(h.ev.eval(h.ident('a.ts', 'nonNullish', 0)))).toBe('kept');
  });

  test('unrolls Object.entries / Object.keys sanitizer loops without losing field types or auth provenance', () => {
    const h = harness({
      'a.ts': `
        import { serverTimestamp } from 'firebase/database';
        import { getAuth } from 'firebase/auth';
        const makeTs = () => ({ _brand: 'sentinel', type: 'serverTimestamp' } as const);
        function isSentinel(x: any): boolean {
          return typeof x === 'object' && x !== null && '_brand' in x;
        }
        function processSentinels(val: any): any {
          if (val === undefined || val === null) return val;
          if (typeof val !== 'object') return val;
          if (isSentinel(val)) {
            if (val.type === 'serverTimestamp') return serverTimestamp();
          }
          if (Array.isArray(val)) return val.map(processSentinels);
          const result: Record<string, any> = {};
          for (const [k, v] of Object.entries(val)) {
            if (v !== undefined) {
              result[k] = processSentinels(v);
            }
          }
          return result;
        }
        const uid = getAuth().currentUser!.uid;
        declare const body: string;
        const boolOut = processSentinels(true);
        const objOut = processSentinels({ author: uid, body, createdAt: makeTs(), nested: { by: uid }, dropped: undefined });
      `,
    });
    expect(h.ev.eval(h.ident('a.ts', 'boolOut', 0))).toEqual({ k: 'bool', value: true });
    const objVal = h.ev.force(h.ev.eval(h.ident('a.ts', 'objOut', 0)));
    expect(objVal.k).toBe('obj');
    if (objVal.k === 'obj') {
      expect([...objVal.props.keys()]).toEqual(['author', 'body', 'createdAt', 'nested']);
      expect(objVal.optional.size).toBe(0);
      expect(JSON.stringify(objVal.props.get('author'))).toContain('auth.uid');
      expect(objVal.props.get('createdAt')).toEqual({ k: 'fieldValue', name: 'serverTimestamp' });
      const nested = objVal.props.get('nested')!;
      expect(nested.k).toBe('obj');
      if (nested.k === 'obj') {
        expect(JSON.stringify(nested.props.get('by'))).toContain('auth.uid');
      }
    }
  });

  test('ignores nested function returns in factory bodies and traces ||= parameter defaults', () => {
    const h = harness({
      'a.ts': `
        function makeDriver(prefix: string) {
          function helperA() { return 'wrong-a'; }
          function helperB() { return 'wrong-b'; }
          return {
            path(id: string) {
              return prefix + '/' + id;
            },
          };
        }
        function makeRefs(driver: ReturnType<typeof makeDriver>) {
          const fn = (groupId: string) => driver.path(groupId);
          fn.item = ({ groupId, itemId }: { groupId: string; itemId: string }) =>
            driver.path(groupId + '/items/' + itemId);
          return fn;
        }
        const refs = makeRefs(makeDriver('orgs'));
        function useItem({ groupId, itemId }: { groupId: string; itemId?: string }) {
          itemId ||= 'default-item';
          return refs.item({ groupId, itemId });
        }
        const out = useItem({ groupId: 'g1' });
      `,
    });
    expect(alternatives(h.ev.eval(h.ident('a.ts', 'out', 0))).map(literalText)).toEqual(['orgs/g1/items/default-item']);
  });
});
