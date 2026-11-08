import { describe, expect, test } from 'bun:test';
import { harness } from './harness.js';

describe('builtinCall', () => {
  const h = harness({
    'a.ts': `
      import { getAuth } from 'firebase/auth';
      const u = getAuth().currentUser!;
      declare const title: string;
      String(u.uid);
      u.uid.trim();
      title.trim();
      Date.now();
      crypto.randomUUID();
      [1].includes(1);
    `,
  });

  test('String(x) and x.trim() keep auth provenance', () => {
    expect(JSON.stringify(h.ev.eval(h.expr('a.ts', 'String(u.uid)')))).toContain('auth.uid');
    expect(JSON.stringify(h.ev.eval(h.expr('a.ts', 'u.uid.trim()')))).toContain('auth.uid');
  });

  test('results of common built-ins have a kind', () => {
    expect(h.ev.eval(h.expr('a.ts', 'title.trim()')).k).toBe('str');
    expect(h.ev.eval(h.expr('a.ts', 'Date.now()'))).toEqual({ k: 'num' });
    expect(h.ev.eval(h.expr('a.ts', 'crypto.randomUUID()'))).toMatchObject({ k: 'str', parts: [{ kind: 'hole', name: 'randomUUID' }] });
    expect(h.ev.eval(h.expr('a.ts', '[1].includes(1)'))).toEqual({ k: 'bool' });
  });
});

describe('builtinCall: path normalization folds over templates', () => {
  const h = harness({
    'n.ts': `
      declare const id: string;
      const p = \`/rooms/\${id}//msgs/\`;
      p.replace(/^\\/+|\\/+$/g, '');
      p.replace(/\\/+/g, '/');
      p.split('/').filter(Boolean).join('/');
      p.split('/').pop();
      '  a '.trim();
    `,
  });
  const text = (t: string): string => {
    const v = h.ev.eval(h.expr('n.ts', t));
    if (v.k !== 'str') return v.k;
    return v.parts.map((x) => (x.kind === 'lit' ? x.text : '{' + x.name + '}')).join('');
  };

  test('slash trimming, collapsing, and split/filter/join keep the holes', () => {
    expect(text("p.replace(/^\\/+|\\/+$/g, '')")).toBe('rooms/{id}//msgs');
    expect(text("p.replace(/\\/+/g, '/')")).toBe('/rooms/{id}/msgs/');
    expect(text("p.split('/').filter(Boolean).join('/')")).toBe('rooms/{id}/msgs');
    expect(text("p.split('/').pop()")).toBe('');
    expect(text("'  a '.trim()")).toBe('a');
  });

  test('a transform that depends on a hole is not folded', () => {
    const h2 = harness({ 'm.ts': `declare const id: string; const q = \`\${id}x\`; q.replace(/^.+x/, '');` });
    const v = h2.ev.eval(h2.expr('m.ts', "q.replace(/^.+x/, '')"));
    expect(v).toMatchObject({ k: 'str', parts: [{ kind: 'hole', name: 'replace' }] });
  });

  test('Map get returns the values stored with set', () => {
    const h3 = harness({ 'k.ts': `const m = new Map<string, string>(); m.set('a', 'one'); m.set('b', 'two'); m.get('a');` });
    const v = h3.ev.eval(h3.expr('k.ts', "m.get('a')"));
    expect(v.k === 'union' && v.alts.map((a) => (a.k === 'str' ? a.parts[0] : null))).toEqual([{ kind: 'lit', text: 'one' }, { kind: 'lit', text: 'two' }]);
  });

  test('Array.isArray and Object.{keys,values,entries,fromEntries} fold bounded objects', () => {
    const h4 = harness({
      'o.ts': `
        const item = { title: 'hello', count: 2 };
        const checkArr = Array.isArray([1, 2]);
        const checkObj = Array.isArray(item);
        const keys = Object.keys(item);
        const vals = Object.values(item);
        const rebuilt = Object.fromEntries(Object.entries(item));
      `,
    });
    expect(h4.ev.eval(h4.ident('o.ts', 'checkArr', 0))).toEqual({ k: 'bool', value: true });
    expect(h4.ev.eval(h4.ident('o.ts', 'checkObj', 0))).toEqual({ k: 'bool', value: false });
    const keys = h4.ev.eval(h4.ident('o.ts', 'keys', 0));
    expect(keys.k === 'arr' && keys.items.length).toBe(2);
    const vals = h4.ev.eval(h4.ident('o.ts', 'vals', 0));
    expect(vals.k === 'arr' && vals.items.length).toBe(2);
    const rebuilt = h4.ev.eval(h4.ident('o.ts', 'rebuilt', 0));
    expect(rebuilt.k).toBe('obj');
    if (rebuilt.k === 'obj') {
      expect([...rebuilt.props.keys()]).toEqual(['title', 'count']);
    }
  });
});

