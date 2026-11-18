import { describe, expect, test } from 'bun:test';
import {
  observeArrayWriteNormalization,
  type ArrayWriteNormalizationSdk,
} from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-array-write-normalization.ts';
import {
  observeNullAndEmptyAncestorPruning,
  type AncestorPruningProbeSdk,
} from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-null-and-empty-ancestor-pruning.ts';
import {
  observeSparseIntegerArrayCoercion,
  type SparseArrayCoercionClientSdk,
} from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-sparse-integer-array-coercion.ts';
import {
  observeSyncWriteAndDisconnectValidation,
  type SyncWriteValidationProbeSdk,
} from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-sync-write-and-disconnect-validation.ts';
import {
  hostedRtdbContext,
  load,
  restoreSharedWorker,
  servedRtdbContext,
  type ServedRtdbAdminContext,
} from './support.ts';

restoreSharedWorker();

const planes: ReadonlyArray<
  readonly [string, () => Promise<ServedRtdbAdminContext>]
> = [
  ['served SharedWorker', () => servedRtdbContext()],
  ['served Node host', () => hostedRtdbContext()],
];

for (const [planeName, makeContext] of planes) {
  describe(`RTDB modular normalization and validation oracle captures (${planeName})`, () => {
    test('rtdb-modular-array-write-normalization (rtdb-modular#M65, #AS1)', async () => {
      const ctx = await makeContext();
      const actual = await observeArrayWriteNormalization(
        {
          db: ctx.db as unknown as ArrayWriteNormalizationSdk['db'],
          ...(ctx.rtdb as unknown as Omit<ArrayWriteNormalizationSdk, 'db'>),
        },
        `${ctx.base}/array-write-norm`,
      );
      expect(actual).toEqual(load('rtdb-modular-array-write-normalization'));
    });

    test('rtdb-modular-sparse-integer-array-coercion (rtdb-modular#M66, #AS1, rtdb-admin#4)', async () => {
      const ctx = await makeContext();
      const adminDb = await ctx.openAdminDb();
      const actual = await observeSparseIntegerArrayCoercion(
        {
          db: ctx.db as unknown as SparseArrayCoercionClientSdk['db'],
          ...(ctx.rtdb as unknown as Omit<SparseArrayCoercionClientSdk, 'db'>),
        },
        adminDb as unknown as Parameters<typeof observeSparseIntegerArrayCoercion>[1],
        `${ctx.base}/sparse-coercion`,
      );
      expect(actual).toEqual(load('rtdb-modular-sparse-integer-array-coercion'));
    });

    test('rtdb-modular-null-and-empty-ancestor-pruning (rtdb-modular#M67)', async () => {
      const ctx = await makeContext();
      const actual = await observeNullAndEmptyAncestorPruning(
        {
          db: ctx.db as unknown as AncestorPruningProbeSdk['db'],
          ...(ctx.rtdb as unknown as Omit<AncestorPruningProbeSdk, 'db'>),
        },
        `${ctx.base}/ancestor-pruning`,
      );
      expect(actual).toEqual(load('rtdb-modular-null-and-empty-ancestor-pruning'));
    });

    test('rtdb-modular-sync-write-and-disconnect-validation (rtdb-modular#M68, #SW1)', async () => {
      const ctx = await makeContext();
      const actual = await observeSyncWriteAndDisconnectValidation(
        {
          db: ctx.db as unknown as SyncWriteValidationProbeSdk['db'],
          ...(ctx.rtdb as unknown as Omit<SyncWriteValidationProbeSdk, 'db'>),
        },
        ctx.base,
      );
      expect(actual).toEqual(load('rtdb-modular-sync-write-and-disconnect-validation'));
    });
  });
}
