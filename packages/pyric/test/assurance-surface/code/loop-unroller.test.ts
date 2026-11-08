import { describe, expect, test } from 'bun:test';
import { payloadShape } from '../../../src/assurance-surface/code/payload.js';
import { harness } from './harness.js';

describe('loop-unroller', () => {
  test('unrolls Object.entries and Object.keys loops while preserving required vs optional fields', () => {
    const h = harness({
      'sanitize.ts': `
        import { getAuth } from 'firebase/auth';
        function cleanRecord(input: Record<string, unknown>) {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(input)) {
            if (v === undefined) continue;
            out[k] = v;
          }
          return out;
        }
        declare const flag: boolean;
        export function build(body: string) {
          const uid = getAuth().currentUser!.uid;
          const extra = flag ? 'note' : undefined;
          return cleanRecord({ authorUid: uid, body, omitted: undefined, extra });
        }
      `,
    });
    const callVal = h.ev.eval(h.expr('sanitize.ts', 'cleanRecord({ authorUid: uid, body, omitted: undefined, extra })'));
    const shape = payloadShape(callVal, (x) => h.ev.force(x), '.');
    expect(shape.open).toBe(false);
    expect(shape.fields).toEqual([
      { name: 'authorUid', kind: 'string', auth: [{ source: 'auth.uid', certainty: 'exact' }] },
      { name: 'body', kind: 'unknown' },
      { name: 'extra', kind: 'string', optional: true },
    ]);
  });

  test('unrolls for..in key copy loops and marks conditional writes without continue as optional', () => {
    const h = harness({
      'copy.ts': `
        function pickDefined(src: { title: string; draft: boolean }, keepDraft: boolean) {
          const target: Record<string, unknown> = {};
          for (const key in src) {
            if (key === 'draft' && !keepDraft) {
              // skipped on one branch
            } else {
              target[key] = src[key as keyof typeof src];
            }
          }
          return target;
        }
        declare const flag: boolean;
        export const copied = pickDefined({ title: 'hello', draft: true }, flag);
      `,
    });
    const shape = payloadShape(h.ev.eval(h.ident('copy.ts', 'copied', 0)), (x) => h.ev.force(x), '.');
    expect(shape.fields).toEqual([
      { name: 'title', kind: 'string', literal: 'hello' },
      { name: 'draft', kind: 'boolean', literal: true, optional: true },
    ]);
  });
});
