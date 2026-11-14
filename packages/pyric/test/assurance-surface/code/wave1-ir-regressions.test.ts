import { describe, expect, test } from 'bun:test';
import { extractSdkUsage } from '../../../src/assurance-surface/code/usage-index.js';
import { coverageMatrixPass } from '../../../src/assurance-surface/passes/coverage-matrix.js';
import { rtdbIndexPass } from '../../../src/assurance-surface/passes/rtdb-indexes.js';
import { storageContractPass } from '../../../src/assurance-surface/passes/storage-contract.js';

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

    const itemReads = usage.operations.filter(
      (s) => s.service === 'firestore' && s.path === 'items/i1',
    );
    expect(itemReads.map((s) => s.resourceId ?? '(default)')).toEqual([
      '(default)',
      'secondary-db',
    ]);

    const bucketUploads = usage.operations.filter(
      (s) => s.service === 'storage' && s.path === 'items/i1',
    );
    expect(bucketUploads.map((s) => s.resourceId ?? '(default)')).toEqual([
      '(default)',
      'secondary-bucket',
    ]);

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
    expect(byPath.get('items/one.bin')).toEqual({
      contentType: 'application/octet-stream',
      sizeBytes: 1,
    });
    expect(byPath.get('items/ten.bin')).toEqual({
      contentType: 'application/octet-stream',
      sizeBytes: 10,
    });
    expect(byPath.get('items/blob-static.bin')).toEqual({
      contentType: 'text/plain',
      sizeBytes: 7,
    });
    expect(byPath.get('items/unknown-typed.bin')).toEqual({
      contentType: 'application/octet-stream',
    });
    expect(byPath.get('items/unknown-blob.bin')).toEqual({ contentType: 'text/plain' });
    expect(byPath.get('items/varied.bin')).toEqual({
      contentType: 'application/octet-stream',
    });
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
    expect(byPath.get('items/empty-blob.bin')).toEqual({
      contentType: 'image/png',
      sizeBytes: 1,
    });
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
    const matchedSegments: string[] = [];
    for (const seg of diags[0]!.resource?.segments ?? []) {
      if (seg.kind === 'lit') matchedSegments.push(seg.text);
      else matchedSegments.push('');
    }
    expect(matchedSegments.join('/')).toBe('items/meta-empty.bin');
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
        (q) =>
          q.baseRef.pattern.segments[0]?.kind === 'lit' &&
          q.baseRef.pattern.segments[0].text === seg,
      )!;

    expect(queryAt('items').constraints).toEqual([
      {
        kind: 'where',
        field: 'visibility',
        op: '==',
        operand: { kind: 'literal', literal: 'public' },
      },
    ]);
    expect(queryAt('items').branches).toBeUndefined();

    const docReadPaths = usage.operations
      .filter((op) => op.op === 'get')
      .map((op) => op.path);
    expect(docReadPaths).toEqual(['public-docs/d1']);

    expect(queryAt('docs').constraints).toEqual([
      {
        kind: 'where',
        field: 'visibility',
        op: '==',
        operand: { kind: 'literal', literal: 'public' },
      },
    ]);
    expect(queryAt('docs').branches).toBeUndefined();

    expect(queryAt('users').constraints).toEqual([
      {
        kind: 'where',
        field: 'tier',
        op: '==',
        operand: { kind: 'literal', literal: 'public' },
      },
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
      (q) =>
        q.baseRef.pattern.segments[0]?.kind === 'lit' &&
        q.baseRef.pattern.segments[0].text === 'items',
    )!;
    expect(itemsQuery.constraints).toEqual([
      {
        kind: 'where',
        field: 'visibility',
        op: '==',
        operand: { kind: 'literal', literal: 'public' },
      },
    ]);
    expect(itemsQuery.branches).toBeUndefined();

    const unionQuery = usage.queries.find(
      (q) =>
        q.baseRef.pattern.segments[0]?.kind === 'lit' &&
        q.baseRef.pattern.segments[0].text === 'union-idx',
    )!;
    expect(unionQuery.branches?.map((b) => b[0]?.operand?.literal).sort()).toEqual([
      'docs',
      'items',
    ]);

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
      .map((d) => {
        const segTexts: string[] = [];
        for (const s of d.resource?.segments ?? []) {
          if (s.kind === 'lit') segTexts.push(s.text);
          else segTexts.push('');
        }
        return segTexts.join('/');
      })
      .sort();
    expect(uncoveredStatic).toEqual(['docs/d1', 'docs/d2', 'items/meta', 'mid/m1', 'union-idx']);
  });
});
