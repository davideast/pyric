import { describe, expect, test } from 'bun:test';
import { partsToSegmentAlternatives, renderPath } from '../../../src/assurance-surface/code/paths.js';
import { payloadShape } from '../../../src/assurance-surface/code/payload.js';
import { alternatives } from '../../../src/assurance-surface/code/values.js';
import { harness } from './harness.js';

describe('CallInliner', () => {
  test('narrows typeof and nullish early-return guards so subsequent statements see only surviving types', () => {
    const h = harness({
      'guard.ts': `
        function wrap(val: { tag: string } | null | undefined | string) {
          if (val === null || val === undefined) return { tag: 'empty' };
          if (typeof val !== 'object') return { tag: val };
          return val;
        }
        export const fromObj = wrap({ tag: 'ready' });
        export const fromNull = wrap(null);
      `,
    });
    const objShape = payloadShape(h.ev.eval(h.ident('guard.ts', 'fromObj', 0)), (x) => h.ev.force(x), '.');
    expect(objShape.fields).toEqual([{ name: 'tag', kind: 'string', literal: 'ready' }]);
    const nullShape = payloadShape(h.ev.eval(h.ident('guard.ts', 'fromNull', 0)), (x) => h.ev.force(x), '.');
    expect(nullShape.fields).toEqual([{ name: 'tag', kind: 'string', literal: 'empty' }]);
  });

  test('supports bounded recursion across nested object payloads and class constructors', () => {
    const h = harness({
      'rec.ts': `
        class PathBuilder {
          private prefix = 'notes';
          doc(id: string) {
            return \`\${this.prefix}/\${id}\`;
          }
        }
        function cloneTree(input: unknown): unknown {
          if (input === null || typeof input !== 'object') return input;
          if (Array.isArray(input)) return input.map((item) => cloneTree(item));
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
            out[k] = cloneTree(v);
          }
          return out;
        }
        const builder = new PathBuilder();
        export const docPath = builder.doc('n1');
        export const nested = cloneTree({ title: 'hi', meta: { pinned: true } });
      `,
    });
    expect(h.ev.eval(h.expr('rec.ts', 'new PathBuilder()')).k).toBe('instance');
    const force = (x: import('../../../src/assurance-surface/code/values.js').AVal) => h.ev.force(x);
    const pathAlts = alternatives(force(h.ev.eval(h.ident('rec.ts', 'docPath', 0)))).flatMap((a) => {
      if (a.k !== 'str') return [];
      return partsToSegmentAlternatives(a.parts, force).map((segs) => renderPath('firestore', segs, force).path);
    });
    expect(pathAlts).toEqual(['notes/n1']);
    const nestedShape = payloadShape(h.ev.eval(h.ident('rec.ts', 'nested', 0)), (x) => h.ev.force(x), '.');
    expect(nestedShape.fields).toEqual([
      { name: 'title', kind: 'string', literal: 'hi' },
      { name: 'meta', kind: 'object' },
      { name: 'meta.pinned', kind: 'boolean', literal: true },
    ]);
  });
});
