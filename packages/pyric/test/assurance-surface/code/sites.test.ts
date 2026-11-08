import { describe, expect, test } from 'bun:test';
import { SiteCollector } from '../../../src/assurance-surface/code/sites.js';
import { harness, ROOT } from './harness.js';

function collect(files: Record<string, string>, includeReads = true) {
  const h = harness(files);
  const c = new SiteCollector(h.ev, ROOT, includeReads);
  for (const name of Object.keys(files)) c.scanFile(h.file(name));
  c.finish();
  return c.sites;
}

describe('SiteCollector', () => {
  test('listeners are reads marked listen; a collection listener is a query', () => {
    const sites = collect({
      'a.ts': `
        import { getFirestore, doc, collection, onSnapshot } from 'firebase/firestore';
        const db = getFirestore();
        onSnapshot(doc(db, 'a/b'), () => {});
        onSnapshot(collection(db, 'a'), () => {});
      `,
    });
    expect(sites.map((s) => [s.op, s.path, s.listen])).toEqual([['get', 'a/b', true], ['query', 'a', true]]);
  });

  test('includeReads: false keeps only writes', () => {
    const sites = collect({
      'a.ts': `
        import { getDatabase, ref, get, set } from 'firebase/database';
        const db = getDatabase();
        get(ref(db, 'x')); set(ref(db, 'x'), 1);
      `,
    }, false);
    expect(sites.map((s) => s.op)).toEqual(['set']);
  });

  test('a write whose ref has an untraced alternative is partial and says why', () => {
    const sites = collect({
      'a.ts': `
        import { getDatabase, ref, set } from 'firebase/database';
        declare function external(): any;
        const target = Math.random() ? ref(getDatabase(), 'known') : external();
        set(target, 1);
      `,
    });
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ op: 'set', path: 'known', resolution: 'partial' });
    expect(sites[0].reason).toContain("other values of 'target' were not traced");
  });

  test('a ref stored but never used is reported unresolved with where it went', () => {
    const sites = collect({
      'a.ts': `
        import { getFirestore, doc } from 'firebase/firestore';
        export const profileRef = doc(getFirestore(), 'profiles', 'me');
      `,
    });
    expect(sites).toEqual([
      {
        path: 'profiles/me',
        service: 'firestore',
        op: 'ref',
        source: 'a.ts:3',
        resolution: 'unresolved',
        reason: "doc() result never reaches a recognised read or write in the project; it is stored in 'profileRef'",
      },
    ]);
  });

  test('push(ref) with no value only makes a key and is not a site', () => {
    const sites = collect({
      'a.ts': `import { getDatabase, ref, push } from 'firebase/database'; const k = push(ref(getDatabase(), 'x')).key;`,
    });
    expect(sites).toEqual([]);
  });

  test('specializes 1-hop inner helper functions called by factory-returned methods', () => {
    const sites = collect({
      'a.ts': `
        import { getDatabase, ref, get } from 'firebase/database';
        const db = getDatabase();
        function createCollection(path: string) {
          const normalized = path.replace(/^\\/+/, '');
          async function fetchEntries() {
            return await get(ref(db, normalized));
          }
          return {
            async list() {
              return await fetchEntries();
            },
          };
        }
        declare const roomId: string;
        createCollection('rooms/' + roomId + '/events').list();
      `,
    });
    expect(sites.some((s) => s.op === 'get' && s.path === 'rooms/$roomId/events' && s.resolution === 'resolved')).toBe(true);
  });

  test('parses variadic updateDoc when first or later field keys are dynamic and marks payload open', () => {
    const sites = collect({
      'a.ts': `
        import { getFirestore, doc, updateDoc } from 'firebase/firestore';
        declare const dynamicField: string;
        const db = getFirestore();
        updateDoc(doc(db, 'items/1'), dynamicField, 2, 'status', 'ready');
        updateDoc(doc(db, 'items/2'), 'status', 'ready', dynamicField, 2);
      `,
    });
    const first = sites.find((s) => s.path === 'items/1');
    const second = sites.find((s) => s.path === 'items/2');
    expect(first?.payload?.open).toBe(true);
    expect(first?.payload?.fields).toContainEqual({ name: 'status', kind: 'string', literal: 'ready' });
    expect(second?.payload?.open).toBe(true);
    expect(second?.payload?.fields).toContainEqual({ name: 'status', kind: 'string', literal: 'ready' });
  });

  test('marks setDoc merge for mergeFields and union option objects but not merge: false', () => {
    const sites = collect({
      'a.ts': `
        import { getFirestore, doc, setDoc } from 'firebase/firestore';
        const db = getFirestore();
        const unionOpts = Math.random() ? { mergeFields: ['title'] } : { merge: true };
        setDoc(doc(db, 'items/1'), { title: 'a' }, unionOpts);
        setDoc(doc(db, 'items/2'), { title: 'a' }, { merge: false });
      `,
    });
    expect(sites.find((s) => s.path === 'items/1')?.payload?.merge).toBe(true);
    expect(sites.find((s) => s.path === 'items/2')?.payload?.merge).toBeUndefined();
  });

  test('retains unresolved fallback for owned custom withTransaction writes and skips unowned ones', () => {
    const h = harness({
      'owned.ts': `
        declare function withTransaction(cb: (txn: any) => Promise<void>): Promise<void>;
        declare function unknownRef(): any;
        withTransaction(async (txn) => {
          txn.set(unknownRef(), { count: 1 });
        });
      `,
      'unowned.ts': `
        declare function withTransaction(cb: (txn: any) => Promise<void>): Promise<void>;
        declare function unknownRef(): any;
        withTransaction(async (txn) => {
          txn.delete(unknownRef());
        });
      `,
    });
    const collector = new SiteCollector(h.ev, ROOT, true);
    collector.scanFile(h.file('owned.ts'), true);
    collector.scanFile(h.file('unowned.ts'), false);
    collector.finish();
    expect(collector.sites).toHaveLength(1);
    expect(collector.sites[0]).toMatchObject({
      op: 'setDoc',
      via: 'transaction',
      resolution: 'unresolved',
      source: 'owned.ts:5',
    });
  });

  test('does not treat Object.prototype keys imported from SDK modules as operations or ref constructors', () => {
    const sites = collect({
      'proto.ts': `
        // @ts-nocheck
        import { constructor, toString } from 'firebase/firestore';
        import * as fs from 'firebase/firestore';
        constructor();
        toString();
        fs.toString();
        fs.constructor();
      `,
    });
    expect(sites).toEqual([]);
  });
});
