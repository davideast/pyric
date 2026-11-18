import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pyricRtdb from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getDatabase } from '../../src/database/index.js';
import {
  observeSparseIntegerArrayCoercion,
  type SparseArrayCoercionClientSdk,
} from '../../../conformance/probes/rtdb-modular/rtdb-modular-sparse-integer-array-coercion.ts';
import { sharedWorkerArm } from './arms.js';

const SPARSE_OBSERVATION_PATH = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'conformance',
  'observations',
  'rtdb-modular',
  'rtdb-modular-sparse-integer-array-coercion.json',
);

const expectedBehavior = JSON.parse(readFileSync(SPARSE_OBSERVATION_PATH, 'utf8')).behavior as unknown;

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

let localSeq = 0;

describe('rtdb-modular-sparse-integer-array-coercion across pyric-admin arms (rtdb-admin#4, rtdb-modular#AS1)', () => {
  test('matches production capture verbatim on the in-process pyric-admin arm', async () => {
    localSeq += 1;
    const sandbox = initializeSandbox({ projectId: `demo-admin-sparse-local-${localSeq}` });
    const rawClientDb = pyricRtdb.getDatabase(sandbox.withAuth({ uid: 'reader-1' }));
    pyricRtdb.sandbox.setRules(rawClientDb, {
      rules: { '.read': true, '.write': true },
    });
    const adminApp = initializeApp({ sandbox }, `admin-sparse-local-${localSeq}`);
    const adminDb = getDatabase(adminApp);
    try {
      const actual = await observeSparseIntegerArrayCoercion(
        {
          db: rawClientDb as unknown as SparseArrayCoercionClientSdk['db'],
          ref: pyricRtdb.ref as unknown as SparseArrayCoercionClientSdk['ref'],
          set: pyricRtdb.set as unknown as SparseArrayCoercionClientSdk['set'],
          setWithPriority:
            pyricRtdb.setWithPriority as unknown as SparseArrayCoercionClientSdk['setWithPriority'],
          get: pyricRtdb.get as unknown as SparseArrayCoercionClientSdk['get'],
        },
        adminDb as unknown as Parameters<typeof observeSparseIntegerArrayCoercion>[1],
        '/pyric_oracle/r1/sparse-coercion',
      );
      expect(actual).toEqual(expectedBehavior);
    } finally {
      await sandbox.dispose();
    }
  });

  test('matches production capture verbatim on the remote SharedWorker pyric-admin arm', async () => {
    const { app, host } = sharedWorkerArm();
    const rawClientDb = pyricRtdb.getDatabase(host.withAuth({ uid: 'reader-1' }));
    pyricRtdb.sandbox.setRules(rawClientDb, {
      rules: { '.read': true, '.write': true },
    });
    const adminDb = getDatabase(app);
    try {
      const actual = await observeSparseIntegerArrayCoercion(
        {
          db: rawClientDb as unknown as SparseArrayCoercionClientSdk['db'],
          ref: pyricRtdb.ref as unknown as SparseArrayCoercionClientSdk['ref'],
          set: pyricRtdb.set as unknown as SparseArrayCoercionClientSdk['set'],
          setWithPriority:
            pyricRtdb.setWithPriority as unknown as SparseArrayCoercionClientSdk['setWithPriority'],
          get: pyricRtdb.get as unknown as SparseArrayCoercionClientSdk['get'],
        },
        adminDb as unknown as Parameters<typeof observeSparseIntegerArrayCoercion>[1],
        '/pyric_oracle/r1/sparse-coercion',
      );
      expect(actual).toEqual(expectedBehavior);
    } finally {
      await host.dispose();
    }
  });
});
