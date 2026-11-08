import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  checkRtdbIndexes,
  countSites,
  extractAccessSites,
  extractSdkUsage,
  FIRESTORE_SERVICE_MODEL,
  firestoreIndexPass,
  mergeRtdbIndexes,
  RTDB_SERVICE_MODEL,
  rtdbIndexPass,
  type ConstraintOperand,
  type SdkQuery,
  type SdkQueryConstraint,
  type SdkRef,
  type SdkServiceModel,
  type SdkUsageIndex,
  type SdkUsagePass,
} from '../../src/assurance-surface/usage.js';

describe('pyric/rules/internal/usage seam', () => {
  test('wires ./rules/internal/usage in package.json exports without violating src/rules boundary', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dir, '../../package.json'), 'utf8'),
    ) as { exports: Record<string, { types: string; import: string }> };
    expect(pkg.exports['./rules/internal/usage']).toEqual({
      types: './dist/assurance-surface/usage.d.ts',
      import: './dist/assurance-surface/usage.js',
    });
  });

  test('exposes extractSdkUsage, built-in service models, and backwards-compatible extractAccessSites projection', () => {
    const customStorageModel: SdkServiceModel = {
      service: 'storage',
      modules: ['pyric/storage'],
      handleFactories: { getStorage: { resourceArgIndex: 1, singleStringArgIsResource: true } },
      refConstructors: { ref: { refKind: 'object' } },
      constraints: {},
      operations: {
        uploadBytes: { op: 'uploadBytes', write: true, data: 1 },
        getBytes: { op: 'get', readKind: true },
      },
    };

    expect(FIRESTORE_SERVICE_MODEL.service).toBe('firestore');
    expect(RTDB_SERVICE_MODEL.service).toBe('rtdb');

    const options = {
      root: '/virtual/app',
      serviceModels: [customStorageModel],
      files: {
        'app.ts': `
          import { getFirestore, collection, doc, query, where, getDocs, setDoc } from 'pyric/firestore';
          import { getDatabase, ref as dbRef, update } from 'pyric/database';
          import { getStorage, ref as storageRef, uploadBytes } from 'pyric/storage';
          import { getAuth } from 'pyric/auth';

          const db = getFirestore();
          const rtdb = getDatabase();
          const storage = getStorage(undefined, 'gs://media-bucket');

          export const orphanDoc = doc(db, 'orgs', 'acme');

          export async function syncUser(bytes: Uint8Array) {
            const uid = getAuth().currentUser!.uid;
            await setDoc(doc(db, 'users', uid), { ownerId: uid });
            await update(dbRef(rtdb, 'status/' + uid), { online: true });
            await uploadBytes(storageRef(storage, 'avatars/' + uid + '.png'), bytes);
            const q = query(collection(db, 'items'), where('ownerId', '==', uid));
            return getDocs(q);
          }
        `,
      },
    };

    const usage: SdkUsageIndex = extractSdkUsage(options);
    const report = extractAccessSites(options);

    expect(report.accessSites).toEqual(usage.operations);
    expect(report.filesScanned).toBe(usage.filesScanned);
    expect(report.projects).toEqual(usage.projects);
    expect(report.embeddedRules).toEqual(usage.embeddedRules);
    expect(report.counts).toEqual({
      total: 5,
      writes: 3,
      reads: 1,
      resolved: 4,
      partial: 0,
      unresolved: 1,
    });
    expect(countSites(report.accessSites, [customStorageModel])).toEqual(report.counts);

    const standaloneRefs: readonly SdkRef[] = usage.refs.filter((r) => r.consumedBy.length === 0);
    expect(standaloneRefs.map((r) => r.refKind)).toContain('doc');

    const queries: readonly SdkQuery[] = usage.queries;
    expect(queries).toHaveLength(1);
    const firstConstraint: SdkQueryConstraint = queries[0]!.constraints[0]!;
    const operand: ConstraintOperand | undefined = firstConstraint.operand;
    expect(operand).toEqual({
      kind: 'auth',
      auth: [{ source: 'auth.uid', certainty: 'exact' }],
    });

    const pass: SdkUsagePass<string[]> = (idx) => idx.operations.map((op) => op.op);
    expect(pass(usage)).toEqual(['ref', 'setDoc', 'update', 'uploadBytes', 'query']);
    expect(firestoreIndexPass(usage).config.indexes).toEqual([]);
    expect(rtdbIndexPass(usage).requirements).toEqual([]);
    expect(checkRtdbIndexes(mergeRtdbIndexes(undefined, []).rules, [])).toEqual([]);
  });
});
