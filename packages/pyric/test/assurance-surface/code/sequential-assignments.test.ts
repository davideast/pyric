import { describe, expect, test } from 'bun:test';
import { alternatives, literalText, type AVal } from '../../../src/assurance-surface/code/values.js';
import { harness } from './harness.js';

const strings = (v: AVal): (string | null)[] => alternatives(v).map(literalText);

describe('sequential-assignments', () => {
  test('tracks sequential self-referential overwrites, mutually exclusive if/else, and read-position states', () => {
    const h = harness({
      'flow.ts': `
        declare function consume(v: string): void;

        export function buildSequential() {
          let path = 'orgs';
          path = path + '/acme';
          path = path + '/items';
          return path;
        }

        export function buildExclusive(flag: boolean) {
          let sort: string;
          if (flag) {
            sort = 'price';
          } else {
            sort = 'createdAt';
          }
          return sort;
        }

        export function buildReused() {
          let target = 'users';
          consume(target);
          target = 'profiles';
          consume(target);
          return target;
        }
      `,
    });

    const seqFn = h.ev.force(h.ev.eval(h.ident('flow.ts', 'buildSequential', 0)));
    expect(seqFn.k).toBe('fn');
    if (seqFn.k === 'fn') {
      expect(strings(h.ev.force(h.ev.callFunction(seqFn, [])))).toEqual(['orgs/acme/items']);
    }

    const exclFn = h.ev.force(h.ev.eval(h.ident('flow.ts', 'buildExclusive', 0)));
    expect(exclFn.k).toBe('fn');
    if (exclFn.k === 'fn') {
      expect(strings(h.ev.force(h.ev.callFunction(exclFn, [{ k: 'bool' }])))).toEqual(['price', 'createdAt']);
    }

    expect(strings(h.ev.force(h.ev.eval(h.ident('flow.ts', 'target', 0))))).toEqual(['users', 'profiles']);
    expect(strings(h.ev.force(h.ev.eval(h.ident('flow.ts', 'target', 1))))).toEqual(['users']);
    expect(strings(h.ev.force(h.ev.eval(h.ident('flow.ts', 'target', 3))))).toEqual(['profiles']);
  });

  test('prunes terminated branches and isolates post-early-return overwrites from earlier reads', () => {
    const h = harness({
      'early.ts': `
        declare function send(v: string): string;

        export function route(onlyDirect: boolean) {
          let channel = 'shared';
          if (onlyDirect) {
            return send(channel);
          }
          channel = 'public';
          return send(channel);
        }
      `,
    });

    expect(strings(h.ev.force(h.ev.eval(h.ident('early.ts', 'channel', 0))))).toEqual(['shared', 'public']);
    expect(strings(h.ev.force(h.ev.eval(h.ident('early.ts', 'channel', 1))))).toEqual(['shared']);
    expect(strings(h.ev.force(h.ev.eval(h.ident('early.ts', 'channel', 3))))).toEqual(['public']);
  });
});
