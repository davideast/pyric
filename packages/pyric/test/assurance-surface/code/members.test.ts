import { describe, expect, test } from 'bun:test';
import { harness } from './harness.js';
import { alternatives, renderParts, type AVal } from '../../../src/assurance-surface/code/values.js';

const text = (v: AVal): string[] => alternatives(v).map((a) => (a.k === 'str' ? renderParts(a.parts) : a.k));

describe('MemberResolver', () => {
  test('object literal fields and missing fields', () => {
    const h = harness({ 'a.ts': `const o = { a: 'x' }; o.a; (o as any).b;` });
    expect(text(h.ev.eval(h.expr('a.ts', 'o.a')))).toEqual(['x']);
    expect(h.ev.eval(h.expr('a.ts', '(o as any).b'))).toEqual({ k: 'undefined' });
  });

  test('the signed-in user fields carry auth provenance', () => {
    const h = harness({ 'a.ts': `import { getAuth } from 'firebase/auth'; const u = getAuth().currentUser; u?.uid; u?.email;` });
    const uid = h.ev.eval(h.expr('a.ts', 'u?.uid'));
    expect(uid).toEqual({ k: 'str', parts: [{ kind: 'hole', name: 'uid', auth: [{ source: 'auth.uid', exact: true }] }] });
    expect(JSON.stringify(h.ev.eval(h.expr('a.ts', 'u?.email')))).toContain('auth.email');
  });

  test('class fields: initializer, constructor parameter property, and assignments', () => {
    const h = harness({
      'a.ts': `
        class S {
          name = 'init';
          constructor(private opts: { path: string }) {}
          rename() { this.name = 'later'; }
          read() { return [this.name, this.opts.path]; }
        }
        new S({ path: 'p/q' });
      `,
    });
    expect(text(h.ev.eval(h.expr('a.ts', 'this.name', 1)))).toEqual(['init', 'later']);
    expect(text(h.ev.eval(h.expr('a.ts', 'this.opts.path')))).toEqual(['p/q']);
  });

  test('a computed-key read sees every value stored with a computed key', () => {
    const h = harness({
      'a.ts': `
        class R {
          private m: Record<string, { p: string }> = {};
          put(k: string) { this.m[k] = { p: 'stored' }; }
          get(k: string) { return this.m[k].p; }
        }
      `,
    });
    expect(text(h.ev.eval(h.expr('a.ts', 'this.m[k].p')))).toEqual(['stored']);
  });

  test('member of null or undefined is infeasible (optional chaining)', () => {
    const h = harness({ 'a.ts': `const n: any = null; n?.x;` });
    expect(h.ev.eval(h.expr('a.ts', 'n?.x'))).toEqual({ k: 'never' });
  });
});
