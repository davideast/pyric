import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import {
  analyzeOwners,
  checkRtdbIndexes,
  countSites,
  coverageMatrixPass,
  extractAccessSites,
  extractSdkUsage,
  FIRESTORE_SERVICE_MODEL,
  firestoreIndexPass,
  inferOwnerBindings,
  loadDiskProject,
  loadRuleSources,
  mergeRtdbIndexes,
  ownerConditionsFrom,
  parseRtdbRulesText,
  planProbes,
  probeActors,
  projectRuleSurface,
  RTDB_SERVICE_MODEL,
  rtdbIndexPass,
  runProbes,
  staticQueryProofPass,
  STORAGE_SERVICE_MODEL,
  storageContractPass,
  withEmbeddedRules,
  type ConstraintOperand,
  type CoverageMatrixRuntimeInput,
  type SdkQuery,
  type SdkQueryConstraint,
  type SdkRef,
  type SdkServiceModel,
  type SdkUsageIndex,
  type SdkUsagePass,
  type StaticQueryProofPassOptions,
  type StorageContractPassOptions,
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
    expect(STORAGE_SERVICE_MODEL.service).toBe('storage');

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

  test('re-exports staticQueryProofPass, storageContractPass, and coverageMatrixPass across one SdkUsageIndex', () => {
    const usage = extractSdkUsage({
      root: '/virtual/tri-source',
      files: {
        'src/app.ts': `
          import { getFirestore, collection, doc, getDoc, getDocs } from 'firebase/firestore';
          import { getStorage, ref, uploadString } from 'firebase/storage';

          export async function run() {
            const db = getFirestore();
            await getDocs(collection(db, 'items'));
            await getDoc(doc(db, 'unmapped', '1'));

            const storage = getStorage(undefined, 'gs://media-bucket');
            await uploadString(ref(storage, 'avatars/a.png'), 'not-an-image', 'raw', {
              contentType: 'text/plain',
            });
          }
        `,
      },
    });

    const firestoreRules = `
      rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /items/{itemId} {
            allow read: if request.auth != null && resource.data.ownerId == request.auth.uid;
          }
        }
      }
    `;
    const storageRules = `
      rules_version = '2';
      service firebase.storage {
        match /b/{bucket}/o {
          match /avatars/{fileName} {
            allow create: if request.auth != null && request.resource.contentType.matches('image/.*');
          }
        }
      }
    `;

    const ruleSurface = projectRuleSurface({
      firestore: firestoreRules,
      storage: storageRules,
    });

    const queryOpts: StaticQueryProofPassOptions = { rules: firestoreRules };
    const storageOpts: StorageContractPassOptions = {
      ruleSurface,
      configuredBuckets: ['media-bucket'],
    };
    const runtimeOpts: CoverageMatrixRuntimeInput = {};

    const queryDiags = staticQueryProofPass(usage, queryOpts);
    const storageDiags = storageContractPass(usage, storageOpts);
    const coverageDiags = coverageMatrixPass(usage, ruleSurface, runtimeOpts);

    expect(queryDiags.map((d) => d.code)).toEqual(['firestore-unprovable-list-query']);
    expect(storageDiags.map((d) => d.code)).toEqual(['storage-content-type-mismatch']);
    expect(coverageDiags.map((d) => d.code)).toEqual(['uncovered-client-operation']);
  });

  test('exposes browser-clean probe and rule-source helpers without static node:* imports or Buffer', async () => {
    expect(typeof analyzeOwners).toBe('function');
    expect(typeof inferOwnerBindings).toBe('function');
    expect(typeof loadDiskProject).toBe('function');
    expect(typeof loadRuleSources).toBe('function');
    expect(typeof ownerConditionsFrom).toBe('function');
    expect(typeof parseRtdbRulesText).toBe('function');
    expect(typeof planProbes).toBe('function');
    expect(typeof probeActors).toBe('function');
    expect(typeof runProbes).toBe('function');
    expect(typeof withEmbeddedRules).toBe('function');

    const roots = [
      resolve(import.meta.dir, '../../src/assurance-surface'),
      resolve(import.meta.dir, '../../src/indexes'),
    ];
    const staticNodeImports: string[] = [];
    for (const dir of roots) {
      const entries = readdirSync(dir, { recursive: true }) as string[];
      for (const rel of entries) {
        if (!rel.endsWith('.ts')) continue;
        const abs = join(dir, rel);
        const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true);
        for (const stmt of sf.statements) {
          if (
            (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt))
            && stmt.moduleSpecifier
            && ts.isStringLiteralLike(stmt.moduleSpecifier)
            && stmt.moduleSpecifier.text.startsWith('node:')
          ) {
            staticNodeImports.push(`${rel} -> ${stmt.moduleSpecifier.text}`);
          }
        }
      }
    }
    expect(staticNodeImports).toEqual([]);
  });
});
