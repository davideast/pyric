import { describe, expect, test } from 'bun:test';
import { harness } from './harness.js';
import { alternatives, renderParts, type AVal } from '../../../src/assurance-surface/code/values.js';

const text = (v: AVal): string[] => alternatives(v).map((a) => (a.k === 'str' ? renderParts(a.parts) : a.k));

describe('CallerTracer', () => {
  test('a component prop is what its JSX callers pass', () => {
    const h = harness({
      'a.tsx': `
        function Room({ roomId }: { roomId: string }) { return roomId; }
        export const App = () => <><Room roomId="r1" /><Room roomId={'r2'} /></>;
      `,
    });
    expect(text(h.ev.force(h.ev.eval(h.ident('a.tsx', 'roomId', 2))))).toEqual(['r1', 'r2']);
  });

  test('an SDK callback parameter: onAuthStateChanged passes the signed-in user', () => {
    const h = harness({
      'a.ts': `
        import { getAuth, onAuthStateChanged } from 'firebase/auth';
        onAuthStateChanged(getAuth(), (user) => { user; });
      `,
    });
    expect(h.ev.force(h.ev.eval(h.ident('a.ts', 'user', 1)))).toEqual({ k: 'authUser', exact: true });
  });

  test('a callback handed through an in-project wrapper', () => {
    const h = harness({
      'a.ts': `
        import { getAuth, onAuthStateChanged } from 'firebase/auth';
        function watch(cb: (u: any) => void) { onAuthStateChanged(getAuth(), cb); }
        watch((who) => { who; });
      `,
    });
    expect(h.ev.force(h.ev.eval(h.ident('a.ts', 'who', 1)))).toEqual({ k: 'authUser', exact: true });
  });

  test('a callback the wrapper calls itself receives the wrapper arguments', () => {
    const h = harness({
      'a.ts': `
        function each(cb: (s: string) => void) { cb('a'); cb('b'); }
        each((s) => { s; });
      `,
    });
    expect(text(h.ev.force(h.ev.eval(h.ident('a.ts', 's', 2))))).toEqual(['a', 'b']);
  });

  test('a parameter with no callers explains why', () => {
    const h = harness({ 'a.ts': `export function lonely(p: string) { return p; }` });
    const v = h.ev.force(h.ev.eval(h.ident('a.ts', 'p', 1)));
    expect(v).toEqual({ k: 'unknown', reason: "no in-project caller of 'lonely' supplies parameter 'p'" });
  });

  test('a React context value comes from its providers and default', () => {
    const h = harness({
      'a.tsx': `
        import { createContext, useContext } from 'react';
        const Ctx = createContext('default');
        export const P = () => <Ctx.Provider value={'provided'}>{null}</Ctx.Provider>;
        export const use = () => useContext(Ctx);
      `,
    });
    expect(text(h.ev.eval(h.expr('a.tsx', 'useContext(Ctx)')))).toEqual(['default', 'provided']);
  });
});
