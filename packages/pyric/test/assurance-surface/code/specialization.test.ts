import { describe, expect, test } from 'bun:test';
import { extractAccessSites } from '../../../src/assurance-surface/code/extractor.js';
import {
  isInsideTransactionCallback,
  mergeResults,
  needsCallerContext,
  type CollectorResult,
} from '../../../src/assurance-surface/code/specialization.js';
import { harness } from './harness.js';

const ROOT = '/virtual/app';

describe('specialization', () => {
  test('specializes txn.set / txn.update / txn.delete / txn.get on raw refs when txn comes from a custom transaction runner', () => {
    const { accessSites } = extractAccessSites({
      root: ROOT,
      includeReads: true,
      files: {
        'tx.ts': `
          import { getFirestore, doc, DocumentReference } from 'firebase/firestore';
          import { getAuth } from 'firebase/auth';
          interface TxClient {
            get(ref: DocumentReference): Promise<void>;
            set(ref: DocumentReference, data: object): void;
            update(ref: DocumentReference, data: object): void;
            delete(ref: DocumentReference): void;
          }
          declare function withTransaction(fn: (txn: TxClient) => Promise<void>): Promise<void>;
          const db = getFirestore();
          export async function transfer(itemId: string, title: string) {
            const uid = getAuth().currentUser!.uid;
            await withTransaction(async (txn) => {
              await txn.get(doc(db, 'items', itemId));
              txn.set(doc(db, 'items', itemId), { owner: uid, title });
              txn.update(doc(db, 'stats', uid), { count: 1 });
              txn.delete(doc(db, 'drafts', itemId));
            });
          }
        `,
      },
    });
    expect(accessSites.map((s) => `${s.op}:${s.via ?? ''}:${s.path}:${s.resolution}`)).toEqual([
      'get:transaction:items/{itemId}:resolved',
      'setDoc:transaction:items/{itemId}:resolved',
      'updateDoc:transaction:stats/{uid}:resolved',
      'deleteDoc:transaction:drafts/{itemId}:resolved',
    ]);
    const setSite = accessSites.find((s) => s.op === 'setDoc')!;
    expect(setSite.payload?.fields).toEqual([
      { name: 'owner', kind: 'string', auth: [{ source: 'auth.uid', certainty: 'exact' }] },
      { name: 'title', kind: 'unknown' },
    ]);
  });

  test('specializes txn.set / txn.update / txn.delete on wrapper document objects', () => {
    const { accessSites } = extractAccessSites({
      root: ROOT,
      files: {
        'driver.ts': `
          import { getDatabase, ref, set, update, remove } from 'firebase/database';
          export interface WrappedDoc {
            set(data: unknown): Promise<void>;
            update(patch: object): Promise<void>;
            delete(): Promise<void>;
          }
          export interface RunnerTx {
            set(doc: WrappedDoc, data: unknown): void;
            update(doc: WrappedDoc, patch: object): void;
            delete(doc: WrappedDoc): void;
          }
          export function wrapDoc(path: string): WrappedDoc {
            const native = ref(getDatabase(), path);
            return {
              set(data: unknown) { return set(native, data); },
              update(patch: object) { return update(native, patch); },
              delete() { return remove(native); },
            };
          }
          export declare function runTransaction(cb: (txn: RunnerTx) => void): Promise<void>;
        `,
        'app.ts': `
          import { getAuth } from 'firebase/auth';
          import { wrapDoc, runTransaction } from './driver';
          export async function publish(docId: string, body: string) {
            const uid = getAuth().currentUser!.uid;
            const itemDoc = wrapDoc(\`docs/\${docId}\`);
            const lockDoc = wrapDoc(\`locks/\${uid}\`);
            await runTransaction((txn) => {
              txn.set(itemDoc, { author: uid, body });
              txn.update(itemDoc, { edited: true });
              txn.delete(lockDoc);
            });
          }
        `,
      },
    });
    const resolved = accessSites.filter((s) => s.resolution === 'resolved');
    expect(resolved.map((s) => `${s.op}:${s.via ?? ''}:${s.path}`)).toEqual([
      'set:transaction:docs/$docId',
      'update:transaction:docs/$docId',
      'remove:transaction:locks/$uid',
    ]);
    expect(resolved[0].payload?.fields).toEqual([
      { name: 'author', kind: 'string', auth: [{ source: 'auth.uid', certainty: 'exact' }] },
      { name: 'body', kind: 'unknown' },
    ]);
  });

  test('mergeResults replaces generic sites with caller-specialized sites and drops consumed refs across programs', () => {
    const r1: CollectorResult = {
      generic: new Map([['lib.ts:10:30', [{ service: 'firestore', op: 'setDoc', path: '{p}', source: 'lib.ts:2', resolution: 'partial' }]]]),
      specialized: new Map(),
      consumed: new Set(),
      unconsumed: [
        {
          key: 'app.ts:5:20',
          site: { service: 'firestore', op: 'ref', path: 'notes/n1', source: 'app.ts:1', resolution: 'unresolved' },
          covers: [],
          report: true,
        },
      ],
    };
    const r2: CollectorResult = {
      generic: new Map(),
      specialized: new Map([
        ['lib.ts:10:30', [{ service: 'firestore', op: 'setDoc', path: 'notes/n1', source: 'caller.ts:4', through: 'lib.ts:2', resolution: 'resolved' }]],
      ]),
      consumed: new Set(['app.ts:5:20']),
      unconsumed: [],
    };
    expect(mergeResults([r1, r2])).toEqual([
      { service: 'firestore', op: 'setDoc', path: 'notes/n1', source: 'caller.ts:4', through: 'lib.ts:2', resolution: 'resolved' },
    ]);
    expect(needsCallerContext([{ service: 'rtdb', op: 'set', path: 'a/b', source: 'x.ts:1', resolution: 'resolved' }])).toBe(false);
    expect(needsCallerContext([{ service: 'rtdb', op: 'set', path: '$p', source: 'x.ts:1', resolution: 'partial' }])).toBe(true);
  });

  test('isInsideTransactionCallback detects inline callbacks passed to transaction runners', () => {
    const h = harness({
      'a.ts': `
        declare function runTransaction(cb: () => void): void;
        declare function plainHelper(cb: () => void): void;
        declare function innerCall(): void;
        declare function outsideCall(): void;
        runTransaction(() => { innerCall(); });
        plainHelper(() => { outsideCall(); });
      `,
    });
    expect(isInsideTransactionCallback(h.expr('a.ts', 'innerCall()'))).toBe(true);
    expect(isInsideTransactionCallback(h.expr('a.ts', 'outsideCall()'))).toBe(false);
  });
});
