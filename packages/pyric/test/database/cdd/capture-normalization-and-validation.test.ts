import { describe, expect, it } from 'bun:test';
import {
  deleteApp as deleteAdminApp,
  initializeApp as initializeAdminApp,
} from '../../../../pyric-admin/src/app/index.js';
import { getDatabase as getAdminDatabase } from '../../../../pyric-admin/src/database/index.js';
import * as pyricRtdb from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';
import {
  observeArrayWriteNormalization,
  type ArrayWriteNormalizationSdk,
} from '../../../../conformance/probes/rtdb-modular/rtdb-modular-array-write-normalization.ts';
import {
  observeNullAndEmptyAncestorPruning,
  type AncestorPruningProbeSdk,
} from '../../../../conformance/probes/rtdb-modular/rtdb-modular-null-and-empty-ancestor-pruning.ts';
import {
  observeSparseIntegerArrayCoercion,
  type SparseArrayCoercionClientSdk,
} from '../../../../conformance/probes/rtdb-modular/rtdb-modular-sparse-integer-array-coercion.ts';
import {
  observeSyncWriteAndDisconnectValidation,
  type SyncWriteValidationProbeSdk,
} from '../../../../conformance/probes/rtdb-modular/rtdb-modular-sync-write-and-disconnect-validation.ts';
import { obs } from './capture-replay.ts';

let cddNormSeq = 0;

async function withNormSandbox<T>(
  run: (
    clientDb: ArrayWriteNormalizationSdk['db'],
    adminDb: Parameters<typeof observeSparseIntegerArrayCoercion>[1],
  ) => Promise<T>,
): Promise<T> {
  cddNormSeq += 1;
  const sandbox = initializeSandbox({ projectId: `demo-rtdb-norm-cdd-${cddNormSeq}` });
  const rawClientDb = pyricRtdb.getDatabase(sandbox.withAuth({ uid: 'reader-1' }));
  pyricRtdb.sandbox.setRules(rawClientDb, {
    rules: {
      '.read': 'auth != null',
      '.write': 'auth != null',
    },
  });
  const adminApp = initializeAdminApp({ sandbox }, `demo-rtdb-norm-cdd-admin-${cddNormSeq}`);
  const adminDb = getAdminDatabase(adminApp);
  try {
    return await run(
      rawClientDb as unknown as ArrayWriteNormalizationSdk['db'],
      adminDb as unknown as Parameters<typeof observeSparseIntegerArrayCoercion>[1],
    );
  } finally {
    await deleteAdminApp(adminApp);
    await sandbox.dispose();
  }
}

describe('RTDB modular normalization and validation oracle captures (in-page sandbox)', () => {
  it('rtdb-modular-array-write-normalization (rtdb-modular#M65, #AS1)', async () => {
    const expected = obs('rtdb-modular-array-write-normalization');
    const actual = await withNormSandbox((clientDb) =>
      observeArrayWriteNormalization(
        {
          db: clientDb,
          ref: pyricRtdb.ref as unknown as ArrayWriteNormalizationSdk['ref'],
          child: pyricRtdb.child as unknown as ArrayWriteNormalizationSdk['child'],
          set: pyricRtdb.set as unknown as ArrayWriteNormalizationSdk['set'],
          get: pyricRtdb.get as unknown as ArrayWriteNormalizationSdk['get'],
        },
        '/pyric_oracle/r1/array-write-norm',
      ),
    );
    expect(actual).toEqual(expected);
  });

  it('rtdb-modular-sparse-integer-array-coercion (rtdb-modular#M66, #AS1, rtdb-admin#4)', async () => {
    const expected = obs('rtdb-modular-sparse-integer-array-coercion');
    const actual = await withNormSandbox((clientDb, adminDb) =>
      observeSparseIntegerArrayCoercion(
        {
          db: clientDb,
          ref: pyricRtdb.ref as unknown as SparseArrayCoercionClientSdk['ref'],
          set: pyricRtdb.set as unknown as SparseArrayCoercionClientSdk['set'],
          setWithPriority:
            pyricRtdb.setWithPriority as unknown as SparseArrayCoercionClientSdk['setWithPriority'],
          get: pyricRtdb.get as unknown as SparseArrayCoercionClientSdk['get'],
        },
        adminDb,
        '/pyric_oracle/r1/sparse-coercion',
      ),
    );
    expect(actual).toEqual(expected);
  });

  it('rtdb-modular-null-and-empty-ancestor-pruning (rtdb-modular#M67)', async () => {
    const expected = obs('rtdb-modular-null-and-empty-ancestor-pruning');
    const actual = await withNormSandbox((clientDb) =>
      observeNullAndEmptyAncestorPruning(
        {
          db: clientDb,
          ref: pyricRtdb.ref as unknown as AncestorPruningProbeSdk['ref'],
          set: pyricRtdb.set as unknown as AncestorPruningProbeSdk['set'],
          update: pyricRtdb.update as unknown as AncestorPruningProbeSdk['update'],
          get: pyricRtdb.get as unknown as AncestorPruningProbeSdk['get'],
        },
        '/pyric_oracle/r1/ancestor-pruning',
      ),
    );
    expect(actual).toEqual(expected);
  });

  it('rtdb-modular-sync-write-and-disconnect-validation (rtdb-modular#M68, #SW1)', async () => {
    const expected = obs('rtdb-modular-sync-write-and-disconnect-validation');
    const actual = await withNormSandbox((clientDb) =>
      observeSyncWriteAndDisconnectValidation(
        {
          db: clientDb,
          ref: pyricRtdb.ref as unknown as SyncWriteValidationProbeSdk['ref'],
          set: pyricRtdb.set as unknown as SyncWriteValidationProbeSdk['set'],
          update: pyricRtdb.update as unknown as SyncWriteValidationProbeSdk['update'],
          push: pyricRtdb.push as unknown as SyncWriteValidationProbeSdk['push'],
          setPriority: pyricRtdb.setPriority as unknown as SyncWriteValidationProbeSdk['setPriority'],
          setWithPriority:
            pyricRtdb.setWithPriority as unknown as SyncWriteValidationProbeSdk['setWithPriority'],
          onDisconnect:
            pyricRtdb.onDisconnect as unknown as SyncWriteValidationProbeSdk['onDisconnect'],
          get: pyricRtdb.get as unknown as SyncWriteValidationProbeSdk['get'],
        },
        '/pyric_oracle/rtdb_1_run',
      ),
    );
    expect(actual).toEqual(expected);
  });
});
