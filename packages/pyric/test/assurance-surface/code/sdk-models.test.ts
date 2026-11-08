import { describe, expect, test } from 'bun:test';
import { harness } from './harness.js';
import { renderPath } from '../../../src/assurance-surface/code/paths.js';
import { alternatives, type AVal } from '../../../src/assurance-surface/code/values.js';

const paths = (v: AVal): string[] =>
  alternatives(v).map((a) => (a.k === 'ref' ? `${a.service}:${a.refKind}:${renderPath(a.service, a.segments).path}` : a.k));

describe('SDK models', () => {
  const h = harness({
    'a.ts': `
      import { getFirestore, doc, collection, collectionGroup, query, where, orderBy } from 'firebase/firestore';
      import { getDatabase, ref, child, push, query as rq, orderByChild } from 'firebase/database';
      const db = getFirestore();
      const rt = getDatabase();
      const rooms = collection(db, 'rooms');
      doc(rooms, 'r1');
      doc(rooms);
      doc(db, 'rooms/r1/messages', 'm1');
      collectionGroup(db, 'messages');
      query(rooms, where('owner', '==', 'u'), orderBy('at', 'desc'));
      child(ref(rt, 'a'), 'b/c');
      push(ref(rt, 'list'));
      rq(ref(rt, 'list'), orderByChild('score'));
      ref(rt);
    `,
  });
  const at = (t: string): AVal => h.ev.eval(h.expr('a.ts', t));

  test('Firestore refs', () => {
    expect(paths(at("doc(rooms, 'r1')"))).toEqual(['firestore:doc:rooms/r1']);
    expect(paths(at('doc(rooms)'))).toEqual(['firestore:doc:rooms/{autoId}']);
    expect(paths(at("doc(db, 'rooms/r1/messages', 'm1')"))).toEqual(['firestore:doc:rooms/r1/messages/m1']);
    expect(paths(at("collectionGroup(db, 'messages')"))).toEqual(['firestore:collectionGroup:{path=**}/messages']);
  });

  test('Firestore query constraints', () => {
    const q = at("query(rooms, where('owner', '==', 'u'), orderBy('at', 'desc'))");
    expect(q.k === 'ref' && q.constraints).toEqual([
      { kind: 'where', field: 'owner', op: '==', operand: { kind: 'literal', literal: 'u' } },
      { kind: 'orderBy', field: 'at', direction: 'desc' },
    ]);
  });

  test('preserves literal, negative-number, auth.uid, auth.token.*, array, param, and unknown operands plus and/or children', () => {
    const h3 = harness({
      'c.ts': `
        import {
          getFirestore,
          collection,
          query,
          where,
          orderBy,
          and,
          or,
          FieldPath,
          documentId,
        } from 'pyric/firestore';
        import {
          getDatabase,
          ref,
          query as rtdbQuery,
          orderByValue,
          equalTo,
          limitToFirst,
        } from 'pyric/database';
        import { getAuth, getIdTokenResult } from 'pyric/auth';
        declare function opaqueValue(): string;

        const db = getFirestore();
        const rtdb = getDatabase();
        const items = collection(db, 'items');

        export async function buildComposite(cat: string, filters: { tag: string }, dir: 'asc' | 'desc') {
          const user = getAuth().currentUser!;
          const token = await getIdTokenResult(user);
          const methodToken = await user.getIdTokenResult();
          const composite = query(
            items,
            or(
              where('ownerId', '==', user.uid),
              and(
                where('orgId', '==', token.claims.orgId),
                where('role', '==', methodToken.claims['role']),
              ),
            ),
            where('delta', 'not-in', [-5, 0]),
            where('archived', '==', false),
            where('deletedAt', '==', null),
            where('category', '==', cat),
            where('tag', '==', filters.tag),
            where('external', '==', opaqueValue()),
            where(new FieldPath('meta', 'slug'), '==', 'alpha'),
            where(documentId(), 'in', [user.uid, 'public']),
            where(FieldPath.documentId(), '==', 'item-1'),
          );
          const dynamicOrder = query(items, orderBy('score', dir));
          const rtdbFiltered = rtdbQuery(ref(rtdb, 'scores'), orderByValue(), equalTo('gold', 'tier'), limitToFirst(10));
          return { composite, dynamicOrder, rtdbFiltered };
        }
      `,
    });

    const compositeVal = h3.ev.force(h3.ev.eval(h3.ident('c.ts', 'composite', 0)));
    expect(compositeVal.k).toBe('ref');
    if (compositeVal.k === 'ref') {
      expect(compositeVal.constraints).toEqual([
        {
          kind: 'or',
          children: [
            {
              kind: 'where',
              field: 'ownerId',
              op: '==',
              operand: { kind: 'auth', auth: [{ source: 'auth.uid', certainty: 'exact' }] },
            },
            {
              kind: 'and',
              children: [
                {
                  kind: 'where',
                  field: 'orgId',
                  op: '==',
                  operand: { kind: 'auth', auth: [{ source: 'auth.token.orgId', certainty: 'exact' }] },
                },
                {
                  kind: 'where',
                  field: 'role',
                  op: '==',
                  operand: { kind: 'auth', auth: [{ source: 'auth.token.role', certainty: 'exact' }] },
                },
              ],
            },
          ],
        },
        {
          kind: 'where',
          field: 'delta',
          op: 'not-in',
          operand: {
            kind: 'array',
            items: [
              { kind: 'literal', literal: -5 },
              { kind: 'literal', literal: 0 },
            ],
          },
        },
        {
          kind: 'where',
          field: 'archived',
          op: '==',
          operand: { kind: 'literal', literal: false },
        },
        {
          kind: 'where',
          field: 'deletedAt',
          op: '==',
          operand: { kind: 'literal', literal: null },
        },
        {
          kind: 'where',
          field: 'category',
          op: '==',
          operand: { kind: 'param' },
        },
        {
          kind: 'where',
          field: 'tag',
          op: '==',
          operand: { kind: 'param' },
        },
        {
          kind: 'where',
          field: 'external',
          op: '==',
          operand: { kind: 'unknown' },
        },
        {
          kind: 'where',
          field: 'meta.slug',
          op: '==',
          operand: { kind: 'literal', literal: 'alpha' },
        },
        {
          kind: 'where',
          field: '__name__',
          op: 'in',
          operand: {
            kind: 'array',
            items: [
              { kind: 'auth', auth: [{ source: 'auth.uid', certainty: 'exact' }] },
              { kind: 'literal', literal: 'public' },
            ],
          },
        },
        {
          kind: 'where',
          field: '__name__',
          op: '==',
          operand: { kind: 'literal', literal: 'item-1' },
        },
      ]);
    }

    const dynamicOrderAlts = alternatives(h3.ev.force(h3.ev.eval(h3.ident('c.ts', 'dynamicOrder', 0))));
    expect(dynamicOrderAlts.map((a) => (a.k === 'ref' ? a.constraints : null))).toEqual([
      [{ kind: 'orderBy', field: 'score', direction: 'asc' }],
      [{ kind: 'orderBy', field: 'score', direction: 'desc' }],
    ]);

    const rtdbVal = h3.ev.force(h3.ev.eval(h3.ident('c.ts', 'rtdbFiltered', 0)));
    expect(rtdbVal.k === 'ref' && rtdbVal.constraints).toEqual([
      { kind: 'orderByValue' },
      { kind: 'equalTo', field: 'tier', operand: { kind: 'literal', literal: 'gold' } },
      { kind: 'limitToFirst', operand: { kind: 'literal', literal: 10 } },
    ]);
  });

  test('RTDB refs, push keys, and queries', () => {
    expect(paths(at("child(ref(rt, 'a'), 'b/c')"))).toEqual(['rtdb:node:a/b/c']);
    expect(paths(at("push(ref(rt, 'list'))"))).toEqual(['rtdb:node:list/$pushId']);
    expect(paths(at('ref(rt)'))).toEqual(['rtdb:node:']);
    const q = at("rq(ref(rt, 'list'), orderByChild('score'))");
    expect(q.k === 'ref' && q.constraints).toEqual([{ kind: 'orderByChild', field: 'score' }]);
  });

  test('an untraced database argument is assumed to be the root, with a note', () => {
    const h2 = harness({ 'b.ts': `import { ref, type Database } from 'firebase/database'; export const f = (d: Database) => ref(d, 'x');` });
    const v = h2.ev.eval(h2.expr('b.ts', "ref(d, 'x')"));
    expect(v.k === 'ref' && v.notes[0]).toContain('assumed to be the database');
  });

  test('ignores Object.prototype keys on namespace SDK calls', () => {
    const hProto = harness({
      'proto.ts': `
        import * as fs from 'firebase/firestore';
        export const asStr = fs.toString();
        export const asCtor = (fs as any).constructor();
      `,
    });
    expect(hProto.ev.force(hProto.ev.eval(hProto.ident('proto.ts', 'asStr', 0))).k).toBe('unknown');
    expect(hProto.ev.force(hProto.ev.eval(hProto.ident('proto.ts', 'asCtor', 0))).k).toBe('unknown');
  });

  test('preserves union resourceIds on handle factories and records notes for untraced resource arguments', () => {
    const hMulti = harness({
      'multi.ts': `
        import { getFirestore, doc } from 'firebase/firestore';
        import { getDatabase, ref } from 'firebase/database';
        declare const app: unknown;
        declare const useArchive: boolean;
        declare const tenantDb: string;
        declare const shardUrl: string;

        const unionDb = getFirestore(app as any, useArchive ? 'archive-db' : 'live-db');
        export const unionItem = doc(unionDb, 'items', '1');

        const dynamicFs = getFirestore(app as any, tenantDb);
        export const dynamicDoc = doc(dynamicFs, 'items', '1');

        const dynamicRtdb = getDatabase(app as any, shardUrl);
        export const dynamicNode = ref(dynamicRtdb, 'items/1');
      `,
    });

    const unionAlts = alternatives(hMulti.ev.force(hMulti.ev.eval(hMulti.ident('multi.ts', 'unionItem', 0))));
    expect(
      unionAlts.map((a) => (a.k === 'ref' ? { resourceId: a.resourceId, notes: a.notes } : null)),
    ).toEqual([
      { resourceId: 'archive-db', notes: [] },
      { resourceId: 'live-db', notes: [] },
    ]);

    const dynDoc = hMulti.ev.force(hMulti.ev.eval(hMulti.ident('multi.ts', 'dynamicDoc', 0)));
    expect(dynDoc.k).toBe('ref');
    if (dynDoc.k === 'ref') {
      expect(dynDoc.resourceId).toBe('(default)');
      expect(dynDoc.notes.some((n) => n.includes('getFirestore()'))).toBe(true);
    }

    const dynNode = hMulti.ev.force(hMulti.ev.eval(hMulti.ident('multi.ts', 'dynamicNode', 0)));
    expect(dynNode.k).toBe('ref');
    if (dynNode.k === 'ref') {
      expect(dynNode.resourceId).toBe('(default)');
      expect(dynNode.notes.some((n) => n.includes('getDatabase()'))).toBe(true);
    }
  });
});
