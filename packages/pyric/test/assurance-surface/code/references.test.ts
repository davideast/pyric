import { describe, expect, test } from 'bun:test';
import ts from 'typescript';
import { harness } from './harness.js';

describe('ReferenceIndex', () => {
  const h = harness({
    'a.ts': `
      export function save(x: number) { return x; }
      let cur = 1;
      cur = 2;
      ({ v: cur } = { v: 3 });
      const map: Record<string, number> = {};
      map['k'] = 4;
      const obj: any = {};
      obj.extra = 5;
      save(1);
      [1].map(save);
      class C { field = 0; set() { this.field = 6; } }
    `,
    'b.ts': `import { save } from './a'; save(2);`,
  });
  const symOf = (name: string, nth = 0): ts.Symbol => h.checker.getSymbolAtLocation(h.ident('a.ts', name, nth))!;

  test('references include uses through imports in other files', () => {
    const refs = h.refs.referencesOf(symOf('save'));
    expect(refs.map((r) => r.getSourceFile().fileName.split('/').pop())).toEqual(['a.ts', 'a.ts', 'b.ts', 'b.ts']);
  });

  test('callable uses: calls and callbacks', () => {
    const kinds = h.refs.usesOfCallable(symOf('save')).map((u) => u.kind);
    expect(kinds).toEqual(['call', 'callback', 'call']);
  });

  test('assignments, including destructuring, with the property path', () => {
    const as = h.refs.assignmentsTo(symOf('cur'));
    expect(as.map((a) => [a.rhs.getText(), a.path])).toEqual([['2', []], ['{ v: 3 }', ['v']]]);
  });

  test('element and property assignments', () => {
    expect(h.refs.elementAssignments(symOf('map')).map((e) => e.getText())).toEqual(['4']);
    expect(h.refs.propertyAssignments(symOf('obj')).map((e) => [e.name, e.rhs.getText()])).toEqual([['extra', '5']]);
  });

  test('class field assignments through this', () => {
    expect(h.refs.assignmentsTo(symOf('field')).map((a) => a.rhs.getText())).toEqual(['6']);
  });
});
