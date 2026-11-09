import { describe, expect, test } from 'bun:test';
import { extractSdkUsage } from '../../../src/assurance-surface/code/usage-index.js';
import { coverageMatrixPass } from '../../../src/assurance-surface/passes/coverage-matrix.js';
import { firestoreIndexPass } from '../../../src/assurance-surface/passes/firestore-indexes.js';
import { rtdbIndexPass } from '../../../src/assurance-surface/passes/rtdb-indexes.js';
import { storageContractPass } from '../../../src/assurance-surface/passes/storage-contract.js';
import { extractIndexes } from '../../../src/indexes/extract/extractor.js';

describe('literal path segments containing wildcard metacharacters', () => {
  test('preserves literal $, {...}, and $(...) segments across refs, queries, coverage, storage contracts, and RTDB indexes', () => {
    const firestoreRules = `
      rules_version = '2';
      service cloud.firestore {
        match /databases/{db}/documents {
          match /users/u1 {
            allow read: if true;
          }
          match /docs/d1 {
            allow read: if true;
          }
        }
      }
    `;
    const storageRules = `
      rules_version = '2';
      service firebase.storage {
        match /b/{bucket}/o {
          match /items/i1.json {
            allow write: if request.resource.size <= 2 && request.resource.contentType == 'application/json';
          }
        }
      }
    `;
    const rtdbRules = JSON.stringify({
      rules: {
        items: {
          '{meta}': {
            '.read': true,
            '.indexOn': ['rank'],
          },
        },
      },
    });

    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/client.ts': `
          import { getFirestore, doc, getDoc } from 'firebase/firestore';
          import { getStorage, ref as stRef, uploadBytes } from 'firebase/storage';
          import { getDatabase, ref as dbRef, query, orderByChild, get } from 'firebase/database';

          export async function run() {
            const db = getFirestore();
            await getDoc(doc(db, 'users', '$uid'));
            await getDoc(doc(db, 'users', '{id}'));
            await getDoc(doc(db, 'docs', '$(meta)'));

            const st = getStorage();
            await uploadBytes(stRef(st, 'items/$id.json'), new Uint8Array([1, 2, 3, 4]), {
              contentType: 'text/plain',
            });

            const rtdb = getDatabase();
            await get(query(dbRef(rtdb, 'items/{meta}'), orderByChild('rank')));
          }
        `,
      },
    });

    for (const refRec of usage.refs) {
      expect(refRec.pattern.segments.every((seg) => seg.kind === 'lit')).toBe(true);
    }

    const coverageDiags = coverageMatrixPass(usage, {
      firestore: firestoreRules,
      storage: storageRules,
      rtdb: rtdbRules,
    });
    const uncovered = coverageDiags.filter(
      (d) => d.code === 'uncovered-client-operation' && d.certainty === 'static-proof',
    );
    expect(uncovered).toHaveLength(4);

    const storageDiags = storageContractPass(usage, storageRules);
    expect(storageDiags).toEqual([]);

    const rtdbIdx = rtdbIndexPass(usage);
    expect(rtdbIdx.requirements).toHaveLength(1);
    expect(rtdbIdx.requirements[0]!.path).toBe('items/{meta}');
    expect(rtdbIdx.requirements[0]!.pattern.segments).toEqual([
      { kind: 'lit', text: 'items' },
      { kind: 'lit', text: '{meta}' },
    ]);
  });
});

describe('multi-resource, cross-service, and admin site deduplication', () => {
  test('retains distinct sites across named databases, storage buckets, same-line services, and admin vs client planes', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/client.ts': `
          import { getFirestore, doc, getDoc } from 'firebase/firestore';
          import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';
          import { getDatabase, ref as dbRef, get } from 'firebase/database';
          import { getStorage, ref as stRef, uploadBytes } from 'firebase/storage';

          export async function run(useDefault: boolean) {
            const db = useDefault ? getFirestore() : getFirestore('secondary-db');
            await getDoc(doc(db, 'items', 'i1'));

            const st = useDefault ? getStorage() : getStorage(undefined, 'gs://secondary-bucket');
            await uploadBytes(stRef(st, 'items/i1'), new Uint8Array([1]));

            await Promise.all([get(dbRef(getDatabase(), 'users/u1')), getDoc(doc(getFirestore(), 'users', 'u1'))]);
            await Promise.all([
              getDoc(doc(getFirestore(), 'docs', 'd1')),
              getDoc(doc(getAdminFirestore(), 'docs', 'd1')),
            ]);
          }
        `,
      },
    });

    const itemReads = usage.operations.filter((s) => s.service === 'firestore' && s.path === 'items/i1');
    expect(itemReads.map((s) => s.resourceId ?? '(default)')).toEqual(['(default)', 'secondary-db']);

    const bucketUploads = usage.operations.filter((s) => s.service === 'storage' && s.path === 'items/i1');
    expect(bucketUploads.map((s) => s.resourceId ?? '(default)')).toEqual(['(default)', 'secondary-bucket']);

    const sameLineUsers = usage.operations.filter((s) => s.path === 'users/u1');
    expect(sameLineUsers.map((s) => s.service)).toEqual(['firestore', 'rtdb']);

    const sameLineDocs = usage.operations.filter((s) => s.path === 'docs/d1');
    expect(sameLineDocs.map((s) => Boolean(s.admin))).toEqual([false, true]);
  });
});

describe('array spread splicing and open-length propagation for binary uploads', () => {
  test('computes exact TypedArray and Blob byte sizes for static spreads and marks identifier-carried unknown spreads indeterminate', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/uploads.ts': `
          import { getStorage, ref, uploadBytes } from 'firebase/storage';

          export async function run(unknownBytes: number[], unknownParts: BlobPart[], flag: boolean) {
            const st = getStorage();
            const emptyTail: number[] = [];
            await uploadBytes(ref(st, 'items/one.bin'), new Uint8Array([1, ...emptyTail]));

            const tenBytes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
            await uploadBytes(ref(st, 'items/ten.bin'), new Uint8Array([...tenBytes]));

            const parts = ['abc', new Uint8Array(4)];
            await uploadBytes(ref(st, 'items/blob-static.bin'), new Blob([...parts], { type: 'text/plain' }));

            const copiedBytes = [...unknownBytes];
            await uploadBytes(ref(st, 'items/unknown-typed.bin'), new Uint8Array(copiedBytes));

            const copiedParts = [...unknownParts];
            await uploadBytes(ref(st, 'items/unknown-blob.bin'), new Blob(copiedParts, { type: 'text/plain' }));

            const varied = [0, ...(flag ? [1, 2] : [3])];
            await uploadBytes(ref(st, 'items/varied.bin'), new Uint8Array(varied));
          }
        `,
      },
    });

    const byPath = new Map(usage.operations.map((op) => [op.path, op.storageUpload]));
    expect(byPath.get('items/one.bin')).toEqual({ sizeBytes: 1 });
    expect(byPath.get('items/ten.bin')).toEqual({ sizeBytes: 10 });
    expect(byPath.get('items/blob-static.bin')).toEqual({ contentType: 'text/plain', sizeBytes: 7 });
    expect(byPath.get('items/unknown-typed.bin')).toBeUndefined();
    expect(byPath.get('items/unknown-blob.bin')).toEqual({ contentType: 'text/plain' });
    expect(byPath.get('items/varied.bin')).toBeUndefined();
  });
});

describe('storage upload contentType precedence, empty-string normalization, and data_url parameters', () => {
  test('matches runtime contentType across union/dynamic overrides, empty upload hints, updateMetadata, and parameterized data URLs', () => {
    const storageRules = `
      rules_version = '2';
      service firebase.storage {
        match /b/{bucket}/o {
          match /items/override-union.bin {
            allow write: if request.resource.contentType.matches('image/.*');
          }
          match /items/override-dyn.bin {
            allow write: if request.resource.contentType.matches('image/.*');
          }
          match /items/empty-blob.bin {
            allow write: if request.resource.contentType == 'image/png';
          }
          match /items/empty-bytes.bin {
            allow write: if request.resource.contentType.matches('application/octet-stream');
          }
          match /items/charset.txt {
            allow write: if request.resource.contentType == 'text/plain;charset=utf-8';
          }
          match /items/meta-empty.bin {
            allow write: if request.resource.contentType.matches('image/.*');
          }
        }
      }
    `;

    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/uploads.ts': `
          import { getStorage, ref, uploadBytes, uploadString, updateMetadata } from 'firebase/storage';

          export async function run(isPng: boolean, dynMime: string) {
            const st = getStorage();
            await uploadBytes(
              ref(st, 'items/override-union.bin'),
              new Blob(['x'], { type: 'text/plain' }),
              { contentType: isPng ? 'image/png' : 'image/jpeg' },
            );
            await uploadBytes(
              ref(st, 'items/override-dyn.bin'),
              new Blob(['x'], { type: 'text/plain' }),
              { contentType: dynMime },
            );
            await uploadBytes(
              ref(st, 'items/empty-blob.bin'),
              new Blob(['x'], { type: 'image/png' }),
              { contentType: '' },
            );
            await uploadBytes(
              ref(st, 'items/empty-bytes.bin'),
              new Uint8Array(8),
              { contentType: '' },
            );
            await uploadString(
              ref(st, 'items/charset.txt'),
              'data:text/plain;charset=utf-8;base64,aGVsbG8=',
              'data_url',
            );
            await updateMetadata(ref(st, 'items/meta-empty.bin'), { contentType: '' });
          }
        `,
      },
    });

    const byPath = new Map(usage.operations.map((op) => [op.path, op.storageUpload]));
    expect(byPath.get('items/override-union.bin')).toEqual({ sizeBytes: 1 });
    expect(byPath.get('items/override-dyn.bin')).toEqual({ sizeBytes: 1 });
    expect(byPath.get('items/empty-blob.bin')).toEqual({ contentType: 'image/png', sizeBytes: 1 });
    expect(byPath.get('items/empty-bytes.bin')).toEqual({
      contentType: 'application/octet-stream',
      sizeBytes: 8,
    });
    expect(byPath.get('items/charset.txt')).toEqual({
      contentType: 'text/plain;charset=utf-8',
      sizeBytes: 5,
    });
    expect(byPath.get('items/meta-empty.bin')).toEqual({ contentType: '' });

    const diags = storageContractPass(usage, storageRules);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.code).toBe('storage-content-type-mismatch');
    expect(diags[0]!.resource?.segments.map((s) => (s.kind === 'lit' ? s.text : '')).join('/')).toBe(
      'items/meta-empty.bin',
    );
  });
});

describe('parameter and destructuring default initializers', () => {
  test('applies default initializers only when an argument, property, or element can be undefined', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/defaults.ts': `
          import { getFirestore, collection, doc, query, where, getDocs, getDoc, setDoc } from 'firebase/firestore';

          function fetchByVisibility(visibility = 'private') {
            return getDocs(query(collection(getFirestore(), 'items'), where('visibility', '==', visibility)));
          }

          function buildRef(segment = 'private-docs') {
            return doc(getFirestore(), segment, 'd1');
          }

          export async function run(flag: boolean) {
            await fetchByVisibility('public');
            await getDoc(buildRef('public-docs'));

            const { visibility = 'private' } = { visibility: 'public' };
            await getDocs(query(collection(getFirestore(), 'docs'), where('visibility', '==', visibility)));

            const [tier = 'private'] = ['public'];
            await getDocs(query(collection(getFirestore(), 'users'), where('tier', '==', tier)));

            const { tag = 'fallback' } = { tag: null as string | null };
            await getDocs(query(collection(getFirestore(), 'null-check'), where('tag', '==', tag)));

            const maybeObj = flag ? { kind: 'active' } : {};
            const { kind = 'archived' } = { ...maybeObj };
            await setDoc(doc(getFirestore(), 'optional-check', 'o1'), { kind });
          }
        `,
      },
    });

    const queryAt = (seg: string) =>
      usage.queries.find(
        (q) => q.baseRef.pattern.segments[0]?.kind === 'lit' && q.baseRef.pattern.segments[0].text === seg,
      )!;

    expect(queryAt('items').constraints).toEqual([
      { kind: 'where', field: 'visibility', op: '==', operand: { kind: 'literal', literal: 'public' } },
    ]);
    expect(queryAt('items').branches).toBeUndefined();

    const docReadPaths = usage.operations
      .filter((op) => op.op === 'get')
      .map((op) => op.path);
    expect(docReadPaths).toEqual(['public-docs/d1']);

    expect(queryAt('docs').constraints).toEqual([
      { kind: 'where', field: 'visibility', op: '==', operand: { kind: 'literal', literal: 'public' } },
    ]);
    expect(queryAt('docs').branches).toBeUndefined();

    expect(queryAt('users').constraints).toEqual([
      { kind: 'where', field: 'tier', op: '==', operand: { kind: 'literal', literal: 'public' } },
    ]);
    expect(queryAt('users').branches).toBeUndefined();

    expect(queryAt('null-check').constraints).toEqual([
      { kind: 'where', field: 'tag', op: '==', operand: { kind: 'literal', literal: null } },
    ]);
    expect(queryAt('null-check').branches).toBeUndefined();

    const optionalWrite = usage.operations.find((op) => op.path === 'optional-check/o1')!;
    const kindField = optionalWrite.payload?.fields.find((f) => f.name === 'kind');
    expect(kindField).toEqual({ name: 'kind', kind: 'string' });
  });
});

describe('index-aware Array.prototype.at evaluation', () => {
  test('resolves positive, negative, omitted, out-of-bounds, union, and unknown indices on arrays', () => {
    const firestoreRules = `
      rules_version = '2';
      service cloud.firestore {
        match /databases/{db}/documents {
          match /items/{id} {
            allow get: if true;
            allow list: if resource.data.visibility == 'public';
          }
        }
      }
    `;

    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/at.ts': `
          import { getFirestore, collection, doc, query, where, getDoc, getDocs, setDoc } from 'firebase/firestore';

          export async function run(flag: boolean, dynIdx: number) {
            const db = getFirestore();
            const tiers = ['public', 'mid', 'private'] as const;
            await getDocs(query(collection(db, 'items'), where('visibility', '==', tiers.at(0))));

            const cols = ['docs', 'items'] as const;
            await getDoc(doc(db, cols.at(0)!, 'd1'));
            await getDoc(doc(db, cols.at()!, 'd2'));
            await getDoc(doc(db, tiers.at(-2)!, 'm1'));
            await getDocs(query(collection(db, 'union-idx'), where('col', '==', cols.at(flag ? 0 : -1))));

            const oob = cols.at(9);
            const negOob = cols.at(-9);
            const dyn = cols.at(dynIdx);
            await setDoc(doc(db, 'items', 'meta'), { oob, negOob, dyn });
          }
        `,
      },
    });

    const itemsQuery = usage.queries.find(
      (q) => q.baseRef.pattern.segments[0]?.kind === 'lit' && q.baseRef.pattern.segments[0].text === 'items',
    )!;
    expect(itemsQuery.constraints).toEqual([
      { kind: 'where', field: 'visibility', op: '==', operand: { kind: 'literal', literal: 'public' } },
    ]);
    expect(itemsQuery.branches).toBeUndefined();

    const unionQuery = usage.queries.find(
      (q) => q.baseRef.pattern.segments[0]?.kind === 'lit' && q.baseRef.pattern.segments[0].text === 'union-idx',
    )!;
    expect(unionQuery.branches?.map((b) => b[0]?.operand?.literal).sort()).toEqual(['docs', 'items']);

    const getPaths = usage.operations
      .filter((op) => op.op === 'get')
      .map((op) => op.path)
      .sort();
    expect(getPaths).toEqual(['docs/d1', 'docs/d2', 'mid/m1']);

    const metaWrite = usage.operations.find((op) => op.path === 'items/meta')!;
    const fieldMap = new Map(metaWrite.payload?.fields.map((f) => [f.name, f]));
    expect(fieldMap.get('oob')).toEqual({ name: 'oob', kind: 'unknown' });
    expect(fieldMap.get('negOob')).toEqual({ name: 'negOob', kind: 'unknown' });
    expect(fieldMap.get('dyn')).toEqual({ name: 'dyn', kind: 'string' });

    const diags = coverageMatrixPass(usage, { firestore: firestoreRules });
    const uncoveredStatic = diags
      .filter((d) => d.code === 'uncovered-client-operation' && d.certainty === 'static-proof')
      .map((d) => d.resource?.segments.map((s) => (s.kind === 'lit' ? s.text : '')).join('/'))
      .sort();
    expect(uncoveredStatic).toEqual(['docs/d1', 'docs/d2', 'items/meta', 'mid/m1', 'union-idx']);
  });
});

describe('finite single-segment path union and collectionGroup union expansion', () => {
  test('expands single-segment literal unions across doc, template paths, RTDB ref, and collectionGroup per branch', () => {
    const firestoreRules = `
      rules_version = '2';
      service cloud.firestore {
        match /databases/{db}/documents {
          match /users/{uid} {
            allow read: if true;
          }
          match /{path=**}/users/{uid} {
            allow read: if true;
          }
        }
      }
    `;
    const rtdbRules = JSON.stringify({
      rules: {
        users: { '.read': true },
      },
    });

    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/unions.ts': `
          import { getFirestore, doc, collectionGroup, getDoc, getDocs } from 'firebase/firestore';
          import { getDatabase, ref, get } from 'firebase/database';

          export async function run(useUsers: boolean) {
            const db = getFirestore();
            await getDoc(doc(db, useUsers ? 'users' : 'items', 'i1'));
            await getDoc(doc(db, \`\${useUsers ? 'users' : 'items'}/i2\`));
            await getDocs(collectionGroup(db, useUsers ? 'users' : 'items'));

            const rtdb = getDatabase();
            await get(ref(rtdb, useUsers ? 'users' : 'items'));
          }
        `,
      },
    });

    const fsPaths = usage.operations
      .filter((op) => op.service === 'firestore')
      .map((op) => `${op.op}:${op.path}:${op.resolution}`)
      .sort();
    expect(fsPaths).toEqual([
      'get:items/i1:resolved',
      'get:items/i2:resolved',
      'get:users/i1:resolved',
      'get:users/i2:resolved',
      'query:{path=**}/items:resolved',
      'query:{path=**}/users:resolved',
    ]);

    const rtdbPaths = usage.operations
      .filter((op) => op.service === 'rtdb')
      .map((op) => `${op.op}:${op.path}:${op.resolution}`)
      .sort();
    expect(rtdbPaths).toEqual(['get:items:resolved', 'get:users:resolved']);

    const diags = coverageMatrixPass(usage, { firestore: firestoreRules, rtdb: rtdbRules });
    const uncovered = diags
      .filter((d) => d.code === 'uncovered-client-operation' && d.certainty === 'static-proof')
      .map((d) => `${d.service}:${d.message}`)
      .sort();
    expect(uncovered).toHaveLength(4);
    expect(uncovered.some((m) => m.includes('firestore') && m.includes('items/i1'))).toBe(true);
    expect(uncovered.some((m) => m.includes('firestore') && m.includes('items/i2'))).toBe(true);
    expect(uncovered.some((m) => m.includes('firestore') && m.includes('{path=**}/items'))).toBe(true);
    expect(uncovered.some((m) => m.includes('rtdb') && m.includes('items'))).toBe(true);
  });
});

describe('Firestore withConverter lineage and .parent refKind transitions', () => {
  test('preserves ref and query lineage across .withConverter and free withConverter, and transitions .parent refKind accurately', () => {
    const firestoreRules = `
      rules_version = '2';
      service cloud.firestore {
        match /databases/{db}/documents {
          match /users/{uid} {
            allow get: if true;
            allow list: if resource.data.visibility == 'public';
          }
          match /meta/{id} {
            allow write: if true;
          }
        }
      }
    `;

    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/converters.ts': `
          import {
            getFirestore,
            doc,
            collection,
            collectionGroup,
            query,
            where,
            orderBy,
            getDoc,
            getDocs,
            setDoc,
            withConverter,
          } from 'pyric/firestore';

          const conv = {
            toFirestore: (d: Record<string, unknown>) => d,
            fromFirestore: (s: { data(): Record<string, unknown> }) => s.data(),
          };

          export async function run() {
            const db = getFirestore();
            await getDoc(doc(db, 'items', 'i1').withConverter(conv));
            await getDoc(withConverter(doc(db, 'items', 'i2'), conv));
            await getDocs(
              query(
                collection(db, 'users').withConverter(conv),
                where('visibility', '==', 'private'),
                orderBy('rank', 'desc'),
              ),
            );
            const usersCol = collection(db, 'users');
            await getDocs(
              query(
                usersCol,
                where('visibility', '==', 'private'),
                orderBy('rank', 'desc'),
              ).withConverter(conv),
            );
            await getDocs(
              query(collectionGroup(db, 'posts').withConverter(conv), where('published', '==', true)),
            );

            await getDocs(
              query(
                doc(db, 'users', 'u1').parent,
                where('visibility', '==', 'private'),
                orderBy('rank', 'desc'),
              ),
            );
            await getDoc(collection(db, 'users', 'u1', 'docs').parent!);
            const rootParent = usersCol.parent;
            await setDoc(doc(db, 'meta', 'm1'), { rootParent });
          }
        `,
      },
    });

    const ops = usage.operations.map((op) => `${op.op}:${op.path}:${op.resolution}`).sort();
    expect(ops).toEqual([
      'get:items/i1:resolved',
      'get:items/i2:resolved',
      'get:users/u1:resolved',
      'query:users:resolved',
      'query:users:resolved',
      'query:users:resolved',
      'query:{path=**}/posts:resolved',
      'setDoc:meta/m1:resolved',
    ]);

    const parentCollectionRef = usage.refs.find(
      (r) => r.refKind === 'collection' && r.pattern.segments.length === 1 && r.pattern.segments[0]?.kind === 'lit' && r.pattern.segments[0].text === 'users',
    );
    expect(parentCollectionRef).toBeDefined();

    const parentDocRef = usage.refs.find(
      (r) => r.refKind === 'doc' && r.pattern.segments.length === 2 && r.pattern.segments[0]?.kind === 'lit' && r.pattern.segments[0].text === 'users',
    );
    expect(parentDocRef).toBeDefined();

    const metaWrite = usage.operations.find((op) => op.path === 'meta/m1')!;
    expect(metaWrite.payload?.fields).toEqual([
      { name: 'rootParent', kind: 'null', literal: null },
    ]);

    const indexResult = firestoreIndexPass(usage);
    expect(indexResult.warnings).toEqual([]);
    expect(indexResult.config.indexes).toEqual([
      {
        collectionGroup: 'users',
        queryScope: 'COLLECTION',
        fields: [
          { fieldPath: 'visibility', order: 'ASCENDING' },
          { fieldPath: 'rank', order: 'DESCENDING' },
        ],
      },
    ]);

    const covDiags = coverageMatrixPass(usage, { firestore: firestoreRules });
    const uncovered = covDiags
      .filter((d) => d.code === 'uncovered-client-operation' && d.certainty === 'static-proof')
      .map((d) => d.message)
      .sort();
    expect(uncovered).toHaveLength(3);
    expect(uncovered.some((m) => m.includes('items/i1'))).toBe(true);
    expect(uncovered.some((m) => m.includes('items/i2'))).toBe(true);
    expect(uncovered.some((m) => m.includes('{path=**}/posts'))).toBe(true);
  });
});

describe('SDK aliases, namespace destructuring, barrel re-exports, and chained Admin handles', () => {
  test('traces local const aliases, destructured namespaces, export * as ns, multi-hop export *, and chained Admin Firestore/RTDB operations and queries', () => {
    const firestoreRules = `
      rules_version = '2';
      service cloud.firestore {
        match /databases/{db}/documents {
          match /users/{uid} {
            allow read: if true;
          }
        }
      }
    `;

    const adminSource = `
      import { getFirestore, Filter } from 'firebase-admin/firestore';
      import { getAdminFirestore } from 'pyric-admin/firestore';
      import { getDatabase } from 'firebase-admin/database';
      import { getAdminDatabase } from 'pyric-admin/database';

      export async function runAdmin() {
        const db = getFirestore();
        await db.collection('items').where('visibility', '==', 'public').orderBy('rank', 'desc').limit(10).get();
        await db.collectionGroup('posts').where(Filter.and(Filter.where('published', '==', true))).orderBy('createdAt', 'desc').offset(5).get();
        await db.collection('items').doc('i5').set({ status: 'draft' }, { merge: true });
        await db.collection('items').doc().create({ status: 'new' });
        await db.doc('items/i6').update('status', 'active', 'count', 2);
        await db.collection('items').add({ status: 'queued' });
        await getAdminFirestore().batch().set(db.doc('items/i7'), { status: 'batched' }).delete(db.doc('items/i8')).commit();
        await db.runTransaction(async (tx) => {
          tx.set(db.doc('items/i10'), { status: 'tx' });
        });

        const rtdb = getDatabase();
        await rtdb.ref('items').orderByChild('rank').equalTo(1).get();
        await rtdb.ref('items').child('i9').set({ active: true });
        await getAdminDatabase().ref('items').push({ active: false });
        await rtdb.ref('items/i9').update({ 'meta/tag': 'v1', active: true });
        await rtdb.ref('presence/u1').onDisconnect().set({ online: false });
      }
    `;

    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/cycle-a.ts': `
          export * from './cycle-b';
          export * from 'firebase/firestore';
        `,
        'src/cycle-b.ts': `
          export * from './cycle-a';
        `,
        'src/barrel.ts': `
          export * from './cycle-b';
          export * as fsNs from 'firebase/firestore';
        `,
        'src/client.ts': `
          import * as rawFs from 'firebase/firestore';
          import { getFirestore as directDb, doc as directDoc, setDoc as directSet } from 'firebase/firestore';
          import { getFirestore as barrelDb, doc as barrelDoc, setDoc as barrelSet, fsNs } from './barrel';

          const saveAlias = directSet;
          const docAlias = directDoc;
          const { getFirestore: nsDb, doc: nsDoc, setDoc: nsSet } = rawFs;

          export async function runClient() {
            await saveAlias(docAlias(directDb(), 'items', 'i1'), { v: 1 });
            await nsSet(nsDoc(nsDb(), 'items', 'i2'), { v: 2 });
            await fsNs.setDoc(fsNs.doc(fsNs.getFirestore(), 'items', 'i3'), { v: 3 });
            await barrelSet(barrelDoc(barrelDb(), 'items', 'i4'), { v: 4 });
          }
        `,
        'src/admin.ts': adminSource,
      },
    });

    const clientOps = usage.operations
      .filter((op) => !op.admin)
      .map((op) => `${op.service}:${op.op}:${op.path}:${op.resolution}`)
      .sort();
    expect(clientOps).toEqual([
      'firestore:setDoc:items/i1:resolved',
      'firestore:setDoc:items/i2:resolved',
      'firestore:setDoc:items/i3:resolved',
      'firestore:setDoc:items/i4:resolved',
    ]);

    const adminOps = usage.operations
      .filter((op) => op.admin)
      .map((op) => `${op.service}:${op.op}:${op.path}:${op.via ?? 'direct'}`)
      .sort();
    expect(adminOps).toEqual([
      'firestore:addDoc:items/{autoId}:direct',
      'firestore:deleteDoc:items/i8:batch',
      'firestore:query:items:direct',
      'firestore:query:{path=**}/posts:direct',
      'firestore:setDoc:items/i10:transaction',
      'firestore:setDoc:items/i5:direct',
      'firestore:setDoc:items/i7:batch',
      'firestore:setDoc:items/{autoId}:direct',
      'firestore:updateDoc:items/i6:direct',
      'rtdb:onDisconnect.set:presence/u1:direct',
      'rtdb:push:items/$pushId:direct',
      'rtdb:query:items:direct',
      'rtdb:set:items/i9:direct',
      'rtdb:update:items/i9/meta/tag:direct',
      'rtdb:update:items/i9:direct',
    ]);

    const i5Write = usage.operations.find((op) => op.path === 'items/i5')!;
    expect(i5Write.payload?.merge).toBe(true);

    const i6Write = usage.operations.find((op) => op.path === 'items/i6')!;
    expect(i6Write.payload?.fields).toEqual([
      { name: 'status', kind: 'string', literal: 'active' },
      { name: 'count', kind: 'number', literal: 2 },
    ]);

    const covDiags = coverageMatrixPass(usage, { firestore: firestoreRules });
    const uncovered = covDiags
      .filter((d) => d.code === 'uncovered-client-operation' && d.certainty === 'static-proof')
      .map((d) => d.message);
    expect(uncovered).toHaveLength(4);
    for (const p of ['items/i1', 'items/i2', 'items/i3', 'items/i4']) {
      expect(uncovered.some((m) => m.includes(p))).toBe(true);
    }

    const fsIdx = firestoreIndexPass(usage);
    expect(fsIdx.warnings).toEqual([]);
    expect(fsIdx.config.indexes).toEqual([
      {
        collectionGroup: 'items',
        queryScope: 'COLLECTION',
        fields: [
          { fieldPath: 'visibility', order: 'ASCENDING' },
          { fieldPath: 'rank', order: 'DESCENDING' },
        ],
      },
      {
        collectionGroup: 'posts',
        queryScope: 'COLLECTION_GROUP',
        fields: [
          { fieldPath: 'published', order: 'ASCENDING' },
          { fieldPath: 'createdAt', order: 'DESCENDING' },
        ],
      },
    ]);

    const standaloneExtract = extractIndexes({
      files: [{ name: 'src/admin.ts', source: adminSource }],
    });
    expect(standaloneExtract.success).toBe(true);
    if (standaloneExtract.success) {
      expect(standaloneExtract.data.config.indexes.map((i) => `${i.collectionGroup}:${i.queryScope}`).sort()).toEqual([
        'items:COLLECTION',
        'posts:COLLECTION_GROUP',
      ]);
    }

    const rtdbIdx = rtdbIndexPass(usage);
    expect(rtdbIdx.warnings).toEqual([]);
    expect(rtdbIdx.requirements.map((r) => ({ path: r.path, indexOn: r.indexOn }))).toEqual([
      { path: 'items', indexOn: ['rank'] },
    ]);
  });
});








