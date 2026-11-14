import { describe, expect, test } from 'bun:test';
import { extractSdkUsage } from '../../../src/assurance-surface/code/usage-index.js';
import { coverageMatrixPass } from '../../../src/assurance-surface/passes/coverage-matrix.js';
import { firestoreIndexPass } from '../../../src/assurance-surface/passes/firestore-indexes.js';
import { rtdbIndexPass } from '../../../src/assurance-surface/passes/rtdb-indexes.js';
import { extractIndexes } from '../../../src/indexes/extract/extractor.js';

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
      (r) =>
        r.refKind === 'collection' &&
        r.pattern.segments.length === 1 &&
        r.pattern.segments[0]?.kind === 'lit' &&
        r.pattern.segments[0].text === 'users',
    );
    expect(parentCollectionRef).toBeDefined();

    const parentDocRef = usage.refs.find(
      (r) =>
        r.refKind === 'doc' &&
        r.pattern.segments.length === 2 &&
        r.pattern.segments[0]?.kind === 'lit' &&
        r.pattern.segments[0].text === 'users',
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
      expect(
        standaloneExtract.data.config.indexes
          .map((i) => `${i.collectionGroup}:${i.queryScope}`)
          .sort(),
      ).toEqual(['items:COLLECTION', 'posts:COLLECTION_GROUP']);
    }

    const rtdbIdx = rtdbIndexPass(usage);
    expect(rtdbIdx.warnings).toEqual([]);
    expect(rtdbIdx.requirements.map((r) => ({ path: r.path, indexOn: r.indexOn }))).toEqual([
      { path: 'items', indexOn: ['rank'] },
    ]);
  });
});
