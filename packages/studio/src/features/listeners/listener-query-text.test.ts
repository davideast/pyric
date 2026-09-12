import { describe, expect, it } from 'bun:test';
import { listenerQueryText, MAX_VALUE } from './listener-query-text.js';

const firestore = (collection: string, query?: unknown) =>
  listenerQueryText({ service: 'firestore', target: { collection, query }, query });

const database = (path: string, query?: unknown) =>
  listenerQueryText({ service: 'database', target: path, query });

describe('listenerQueryText, Firestore', () => {
  it('prints a bare collection listen as the collection alone', () => {
    expect(firestore('conversations', {
      scope: { kind: 'collection' },
      filters: [],
      orderBy: [],
      limit: null,
      limitFromEnd: false,
      start: null,
      end: null,
    })?.text).toBe("collection(db, 'conversations')");
  });

  it('prints one constraint per line in call order', () => {
    expect(firestore('conversations', {
      scope: { kind: 'collection' },
      filters: [{
        kind: 'where',
        field: 'members',
        op: 'array-contains',
        display: { type: 'string', value: 'u_8f2a' },
      }],
      orderBy: [{ field: 'updatedAt', direction: 'desc' }],
      limit: 50,
      limitFromEnd: false,
    })?.text).toBe([
      "query(collection(db, 'conversations'),",
      "  where('members', 'array-contains', 'u_8f2a'),",
      "  orderBy('updatedAt', 'desc'),",
      '  limit(50))',
    ].join('\n'));
  });

  it('prints a collection group as its own source call', () => {
    expect(firestore('messages', {
      scope: { kind: 'collection-group' },
      filters: [],
      orderBy: [],
    })?.text).toBe("collectionGroup(db, 'messages')");
  });

  it('prints ascending ordering without a direction, and a tail window as limitToLast', () => {
    expect(firestore('messages', {
      scope: { kind: 'collection' },
      filters: [],
      orderBy: [{ field: 'createdAt', direction: 'asc' }],
      limit: 20,
      limitFromEnd: true,
    })?.text).toBe([
      "query(collection(db, 'messages'),",
      "  orderBy('createdAt'),",
      '  limitToLast(20))',
    ].join('\n'));
  });

  it('prints every operand kind the attach can carry', () => {
    const text = firestore('items', {
      scope: { kind: 'collection' },
      filters: [
        { kind: 'where', field: 'count', op: '>', display: { type: 'number', value: 3 } },
        { kind: 'where', field: 'done', op: '==', display: { type: 'boolean', value: false } },
        { kind: 'where', field: 'archived', op: '==', display: { type: 'null' } },
        {
          kind: 'where',
          field: 'parent',
          op: '==',
          display: { type: 'reference', path: 'conversations/c1' },
        },
        {
          kind: 'where',
          field: 'at',
          op: '<',
          display: { type: 'timestamp', iso: '2026-09-12T18:04:00.000Z' },
        },
        {
          kind: 'where',
          field: 'status',
          op: 'in',
          display: {
            type: 'array',
            values: [{ type: 'string', value: 'open' }, { type: 'string', value: 'idle' }],
          },
        },
        {
          kind: 'where',
          field: 'spot',
          op: '==',
          display: { type: 'geoPoint', latitude: 37.4, longitude: -122.1 },
        },
        { kind: 'where', field: 'blob', op: '==', display: { type: 'bytes', length: 12 } },
      ],
      orderBy: [],
    })!.text;
    expect(text).toContain("where('count', '>', 3)");
    expect(text).toContain("where('done', '==', false)");
    expect(text).toContain("where('archived', '==', null)");
    expect(text).toContain("where('parent', '==', doc(db, 'conversations/c1'))");
    expect(text).toContain("where('at', '<', '2026-09-12T18:04:00.000Z')");
    expect(text).toContain("where('status', 'in', ['open', 'idle'])");
    expect(text).toContain("where('spot', '==', GeoPoint(37.4, -122.1))");
    expect(text).toContain("where('blob', '==', Bytes(12))");
  });

  it('nests a composite filter two spaces deeper per level', () => {
    expect(firestore('items', {
      scope: { kind: 'collection' },
      filters: [{
        kind: 'or',
        filters: [
          { kind: 'where', field: 'a', op: '==', display: { type: 'number', value: 1 } },
          {
            kind: 'and',
            filters: [
              { kind: 'where', field: 'b', op: '==', display: { type: 'number', value: 2 } },
              { kind: 'where', field: 'c', op: '==', display: { type: 'number', value: 3 } },
            ],
          },
        ],
      }],
      orderBy: [],
      limit: 5,
    })?.text).toBe([
      "query(collection(db, 'items'),",
      '  or(',
      "    where('a', '==', 1),",
      '    and(',
      "      where('b', '==', 2),",
      "      where('c', '==', 3))),",
      '  limit(5))',
    ].join('\n'));
  });

  it('names the cursor call each bound stands for', () => {
    const text = firestore('items', {
      scope: { kind: 'collection' },
      filters: [],
      orderBy: [{ field: 'createdAt', direction: 'asc' }],
      start: { display: [{ type: 'number', value: 10 }], inclusive: false, fromSnapshot: false },
      end: { display: [{ type: 'number', value: 20 }], inclusive: true, fromSnapshot: false },
    })!.text;
    expect(text).toContain('  startAfter(10)');
    expect(text).toContain('  endAt(20)');
  });

  it('cuts a long operand short and keeps it whole in the copy text', () => {
    const long = 'u'.repeat(120);
    const printed = firestore('items', {
      scope: { kind: 'collection' },
      filters: [{
        kind: 'where',
        field: 'token',
        op: '==',
        display: { type: 'string', value: long },
      }],
      orderBy: [],
    })!;
    const line = printed.text.split('\n')[1]!;
    const operand = /'==', (.*)\)\)$/.exec(line)![1]!;
    expect(operand.length).toBe(MAX_VALUE);
    expect(operand.endsWith("…'")).toBe(true);
    expect(printed.full).toContain(long);
  });

  it('prints nothing for a document listener', () => {
    expect(listenerQueryText({ service: 'firestore', target: 'conversations/c1' }))
      .toBeUndefined();
  });

  it('prints the collection when the attach recorded no query at all', () => {
    expect(firestore('conversations')?.text).toBe("collection(db, 'conversations')");
  });
});

describe('listenerQueryText, Realtime Database', () => {
  it('chains the ordering, the bound, and the window onto the ref', () => {
    expect(database('/presence', {
      orderBy: { kind: 'child', path: 'online' },
      bounds: [{ kind: 'equalTo', value: true }],
      limit: { kind: 'limitToLast', n: 20 },
    })?.text).toBe("ref(db, '/presence').orderByChild('online').equalTo(true).limitToLast(20)");
  });

  it('prints the ref alone when the listener carries no query', () => {
    expect(database('/presence')?.text).toBe("ref(db, '/presence')");
  });

  it('prints each ordering kind and a keyed bound', () => {
    expect(database('/rooms', {
      orderBy: { kind: 'key' },
      bounds: [{ kind: 'startAt', value: 'a', key: 'k1' }, { kind: 'endBefore', value: 'z' }],
      limit: { kind: 'limitToFirst', n: 5 },
    })?.text).toBe(
      "ref(db, '/rooms').orderByKey().startAt('a', 'k1').endBefore('z').limitToFirst(5)",
    );
    expect(database('/rooms', { orderBy: { kind: 'value' }, bounds: [], limit: null })?.text)
      .toBe("ref(db, '/rooms').orderByValue()");
    expect(database('/rooms', { orderBy: { kind: 'priority' }, bounds: [], limit: null })?.text)
      .toBe("ref(db, '/rooms').orderByPriority()");
  });
});
