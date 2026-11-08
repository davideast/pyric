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
      { kind: 'where', field: 'owner', op: '==' },
      { kind: 'orderBy', field: 'at', direction: 'desc' },
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
    const h2 = harness({ 'b.ts': `import { ref } from 'firebase/database'; export const f = (d: any) => ref(d, 'x');` });
    const v = h2.ev.eval(h2.expr('b.ts', "ref(d, 'x')"));
    expect(v.k === 'ref' && v.notes[0]).toContain('assumed to be the database');
  });
});
