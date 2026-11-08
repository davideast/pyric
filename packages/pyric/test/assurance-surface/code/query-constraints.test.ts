import { describe, expect, test } from 'bun:test';
import { operandOf } from '../../../src/assurance-surface/code/query-constraints.js';
import { alternatives } from '../../../src/assurance-surface/code/values.js';
import { harness } from './harness.js';

describe('query-constraints', () => {
  test('expands spread constraint arrays, default 1-arg orderBy, and ternary constraint branches via Cartesian product', () => {
    const h = harness({
      'q.ts': `
        import { getFirestore, collection, query, where, orderBy, limit } from 'pyric/firestore';
        const db = getFirestore();
        const col = collection(db, 'items');
        export function buildSpread(includeArchive: boolean) {
          const baseFilters = [where('status', '==', 'open'), orderBy('createdAt')];
          const extra = includeArchive ? where('archived', '==', true) : where('archived', '==', false);
          return query(col, ...baseFilters, extra, limit(25));
        }
      `,
    });

    const fnVal = h.ev.force(h.ev.eval(h.ident('q.ts', 'buildSpread', 0)));
    expect(fnVal.k).toBe('fn');
    if (fnVal.k === 'fn') {
      const alts = alternatives(h.ev.force(h.ev.callFunction(fnVal, [{ k: 'bool' }])));
      expect(alts).toHaveLength(2);
      expect(alts.map((a) => (a.k === 'ref' ? a.constraints : null))).toEqual([
        [
          { kind: 'where', field: 'status', op: '==', operand: { kind: 'literal', literal: 'open' } },
          { kind: 'orderBy', field: 'createdAt', direction: 'asc' },
          { kind: 'where', field: 'archived', op: '==', operand: { kind: 'literal', literal: true } },
          { kind: 'limit', operand: { kind: 'literal', literal: 25 } },
        ],
        [
          { kind: 'where', field: 'status', op: '==', operand: { kind: 'literal', literal: 'open' } },
          { kind: 'orderBy', field: 'createdAt', direction: 'asc' },
          { kind: 'where', field: 'archived', op: '==', operand: { kind: 'literal', literal: false } },
          { kind: 'limit', operand: { kind: 'literal', literal: 25 } },
        ],
      ]);
    }
  });

  test('operandOf classifies destructured parameter bindings as param', () => {
    const h = harness({
      'p.ts': `
        export function byOpts({ orgId }: { orgId: string }) {
          return orgId;
        }
      `,
    });
    const expr = h.ident('p.ts', 'orgId', 2);
    expect(operandOf(h.ev, h.ev.eval(expr), expr)).toEqual({ kind: 'param' });
  });

  test('branches union fieldArg, opArg, and concrete literal/array valueArg while keeping mixed auth provenance intact', () => {
    const h = harness({
      'branch.ts': `
        import { getFirestore, collection, query, where, orderBy } from 'pyric/firestore';
        import { getAuth } from 'pyric/auth';
        declare const byPrice: boolean;
        declare const inclusive: boolean;
        declare const showDrafts: boolean;
        declare const viewPeer: boolean;
        declare const peerId: string;

        const db = getFirestore();
        const items = collection(db, 'items');

        export const unionFieldQuery = query(items, orderBy(byPrice ? 'price' : 'createdAt', 'desc'));
        export const unionOpQuery = query(items, where('score', inclusive ? '>=' : '>', 10));
        export const unionValueQuery = query(items, where('status', '==', showDrafts ? 'draft' : 'published'));
        export function mixedAuthQuery() {
          const user = getAuth().currentUser!;
          return query(items, where('ownerId', '==', viewPeer ? peerId : user.uid));
        }
      `,
    });

    const fieldAlts = alternatives(h.ev.force(h.ev.eval(h.ident('branch.ts', 'unionFieldQuery', 0))));
    expect(fieldAlts.map((a) => (a.k === 'ref' ? a.constraints : null))).toEqual([
      [{ kind: 'orderBy', field: 'price', direction: 'desc' }],
      [{ kind: 'orderBy', field: 'createdAt', direction: 'desc' }],
    ]);

    const opAlts = alternatives(h.ev.force(h.ev.eval(h.ident('branch.ts', 'unionOpQuery', 0))));
    expect(opAlts.map((a) => (a.k === 'ref' ? a.constraints : null))).toEqual([
      [{ kind: 'where', field: 'score', op: '>=', operand: { kind: 'literal', literal: 10 } }],
      [{ kind: 'where', field: 'score', op: '>', operand: { kind: 'literal', literal: 10 } }],
    ]);

    const valAlts = alternatives(h.ev.force(h.ev.eval(h.ident('branch.ts', 'unionValueQuery', 0))));
    expect(valAlts.map((a) => (a.k === 'ref' ? a.constraints : null))).toEqual([
      [{ kind: 'where', field: 'status', op: '==', operand: { kind: 'literal', literal: 'draft' } }],
      [{ kind: 'where', field: 'status', op: '==', operand: { kind: 'literal', literal: 'published' } }],
    ]);

    const authFn = h.ev.force(h.ev.eval(h.ident('branch.ts', 'mixedAuthQuery', 0)));
    expect(authFn.k).toBe('fn');
    if (authFn.k === 'fn') {
      const authAlts = alternatives(h.ev.force(h.ev.callFunction(authFn, [])));
      expect(authAlts.map((a) => (a.k === 'ref' ? a.constraints : null))).toEqual([
        [
          {
            kind: 'where',
            field: 'ownerId',
            op: '==',
            operand: { kind: 'auth', auth: [{ source: 'auth.uid', certainty: 'partial' }] },
          },
        ],
      ]);
    }
  });
});
