import { describe, expect, it } from 'bun:test';
import { doc as clientDoc, getDoc as clientGetDoc, getFirestore as getClientFirestore } from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { deleteApp, getApps, initializeApp, type PyricAdminApp } from '../../../pyric-admin/src/app/index.js';
import {
  FieldPath,
  FieldValue,
  getFirestore,
  Timestamp,
} from '../../../pyric-admin/src/firestore/index.js';
import {
  observeFirestoreAdminBypassAndLifecycle,
  probe as bypassAndLifecycleProbe,
  type FirestoreAdminBypassLifecycleSubject,
} from '../../probes/firestore-admin/firestore-admin-getfirestore-bypass-and-lifecycle.ts';
import {
  observeFirestoreAdminPathsAndAutoIds,
  probe as pathsAndAutoIdsProbe,
} from '../../probes/firestore-admin/firestore-admin-paths-and-autoids.ts';
import {
  observeFirestoreAdminSentinelsAndValues,
  probe as sentinelsAndValuesProbe,
  type FirestoreAdminSentinelsSubject,
} from '../../probes/firestore-admin/firestore-admin-sentinels-and-value-types.ts';
import { loadModularProbes } from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

const STAGED_FIRESTORE_ADMIN_PROBES = [
  'firestore-admin-getfirestore-bypass-and-lifecycle',
  'firestore-admin-paths-and-autoids',
  'firestore-admin-sentinels-and-value-types',
] as const;

const DENY_UNAUTH_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /{document=**} {',
  '      allow read, write: if request.auth != null;',
  '    }',
  '  }',
  '}',
].join('\n');

function isDocumentRefLike(value: unknown): value is { readonly id: string; readonly path: string } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { id?: unknown; path?: unknown };
  return typeof candidate.id === 'string' && typeof candidate.path === 'string';
}

describe('staged firestore-admin probes', () => {
  it('registers all three probes under sdk-probes and tracks staged discovery via expectStagedUntilCaptured', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((item) => item.id);
    for (const id of STAGED_FIRESTORE_ADMIN_PROBES) {
      expect(loadedIds).toContain(id);
    }

    expect(bypassAndLifecycleProbe.rig).toBe('sdk-probes');
    expect(bypassAndLifecycleProbe.pendingRowLink).toBe(true);
    expect(bypassAndLifecycleProbe.rowIds).toEqual([]);
    expect(bypassAndLifecycleProbe.requires).toEqual([
      'web-config',
      'firestore-rules',
      'admin-firestore',
    ]);

    expect(pathsAndAutoIdsProbe.rig).toBe('sdk-probes');
    expect(pathsAndAutoIdsProbe.pendingRowLink).toBe(true);
    expect(pathsAndAutoIdsProbe.rowIds).toEqual([]);
    expect(pathsAndAutoIdsProbe.requires).toEqual(['admin-firestore']);

    expect(sentinelsAndValuesProbe.rig).toBe('sdk-probes');
    expect(sentinelsAndValuesProbe.pendingRowLink).toBe(true);
    expect(sentinelsAndValuesProbe.rowIds).toEqual([]);
    expect(sentinelsAndValuesProbe.requires).toEqual(['admin-firestore']);

    expectStagedUntilCaptured(STAGED_FIRESTORE_ADMIN_PROBES, {
      rig: 'sdk-probes',
      filterFlag: '--probe',
      filterValueFor: (name) => name,
    });
  });

  it('produces deterministic two-run observations on pyric-admin/firestore for bypass and app lifecycle', async () => {
    async function runOnce(tag: string): Promise<Record<string, unknown>> {
      const sandbox = initializeSandbox();
      getInternalEnv(sandbox).deployRules(DENY_UNAUTH_RULES);
      const clientDb = getClientFirestore(sandbox);
      const subject: FirestoreAdminBypassLifecycleSubject<
        PyricAdminApp,
        ReturnType<typeof getFirestore>
      > = {
        initializeNamedAdminApp(name: string): PyricAdminApp {
          return initializeApp({ sandbox }, name);
        },
        getAdminFirestore(app: PyricAdminApp) {
          return getFirestore(app);
        },
        getAdminFirestoreRaw(arg: unknown) {
          return getFirestore(arg as never);
        },
        deleteAdminApp(app: PyricAdminApp) {
          return deleteApp(app);
        },
        async readProtectedViaUnauthenticatedClient(docPath: string): Promise<void> {
          await clientGetDoc(clientDoc(clientDb, docPath));
        },
        async writeViaAdmin(db, docPath: string, data: Record<string, unknown>): Promise<void> {
          await db.doc(docPath).set(data);
        },
        async readViaAdmin(db, docPath: string) {
          const snap = await db.doc(docPath).get();
          return {
            exists: snap.exists,
            data: snap.data() as Record<string, unknown> | undefined,
          };
        },
      };
      try {
        return await observeFirestoreAdminBypassAndLifecycle(
          subject,
          `pyric_oracle/${tag}/bypass/doc-1`,
        );
      } finally {
        await Promise.all(getApps().map((app) => deleteApp(app).catch(() => undefined)));
        sandbox.dispose();
      }
    }

    const first = await runOnce('run-1');
    const second = await runOnce('run-2');
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toEqual({
      cachedSameAppHandle: true,
      distinctHandlesAcrossApps: true,
      nonAppObjectThrowsTypeError: true,
      nullAppThrowsTypeError: true,
      adminBypassRead: {
        exists: true,
        data: { scope: 'admin-bypass', level: 7 },
      },
      unauthenticatedClientRead: {
        threw: true,
        code: 'permission-denied',
      },
      getFirestoreAfterDeleteApp: {
        mode: 'sync-throw',
        code: 'app/app-deleted',
        message: 'Firebase app named "<appName>" has already been deleted.',
      },
      siblingReadAfterPrimaryDelete: true,
    });
  });

  it('produces deterministic two-run observations on pyric-admin/firestore for paths, auto-IDs, sentinels, and value types', async () => {
    async function runOnce(tag: string) {
      const sandbox = initializeSandbox();
      const app = initializeApp({ sandbox }, `fs-admin-vals-${tag}`);
      const db = getFirestore(app);
      const sentinelsSubject: FirestoreAdminSentinelsSubject = {
        collection: (path) => db.collection(path),
        serverTimestamp: () => FieldValue.serverTimestamp(),
        increment: (delta) => FieldValue.increment(delta),
        arrayUnion: (...elements) => FieldValue.arrayUnion(...elements),
        arrayRemove: (...elements) => FieldValue.arrayRemove(...elements),
        deleteField: () => FieldValue.delete(),
        createFieldPath: (...names) => new FieldPath(...names),
        documentIdFieldPath: () => FieldPath.documentId(),
        createTimestamp: (seconds, nanoseconds) => new Timestamp(seconds, nanoseconds),
        isTimestamp: (value): value is Timestamp => value instanceof Timestamp,
        readBytes(value: unknown): readonly number[] | null {
          if (value instanceof Uint8Array) {
            return Array.from(value);
          }
          return null;
        },
        readDocRefPath(value: unknown) {
          if (isDocumentRefLike(value)) {
            return { id: value.id, path: value.path };
          }
          return null;
        },
      };

      try {
        const paths = await observeFirestoreAdminPathsAndAutoIds(db, `pyric_oracle/${tag}_paths`);
        const values = await observeFirestoreAdminSentinelsAndValues(
          sentinelsSubject,
          `pyric_oracle/${tag}_values`,
        );
        return { paths, values };
      } finally {
        await deleteApp(app).catch(() => undefined);
        sandbox.dispose();
      }
    }

    const first = await runOnce('det-1');
    const second = await runOnce('det-2');
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.paths.autoIds).toEqual({
      sampleCount: 10,
      allDocAutoIdsTwentyAlnum: true,
      allDocAutoIdsUnique: true,
      addedDocAutoIdTwentyAlnum: true,
    });
    expect(first.values.serverTimestampResolved).toBe(true);
    expect(first.values.updatedCounter).toBe(3);
    expect(first.values.updatedTags).toEqual(['beta', 'gamma']);
    expect(first.values.obsoletePresentAfterDelete).toBe(false);
    expect(first.values.bytesRoundTrip).toEqual([0, 1, 127, 255]);
    expect(first.values.refRoundTrip).toEqual({
      isRef: true,
      idMatches: true,
      pathMatchesTarget: true,
    });
  });
});
