import { describe, expect, test } from 'bun:test';
import * as adminFs from 'firebase-admin/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { doc, getFirestore, onSnapshot, type DocumentSnapshot } from 'pyric/firestore';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { auditProbeSessionAuthModes } from '../../src/sdk-probe-runtime.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';
import { probe as connectEmulatorProbe } from '../../probes/firestore/firestore-connect-emulator-options.ts';
import {
  type AnonymousListenerAuthTransitionSubject,
  buildAnonymousListenerRulesBlock,
  observeFirestoreAnonymousListenerAuthTransition,
  probe as anonymousListenerProbe,
} from '../../probes/firestore/firestore-anonymous-listener-auth-transition.ts';
import {
  type AdminFirestoreMaintenanceSubject,
  type AdminGeoPointLike,
  type AdminMaintBulkWriterLike,
  type AdminMaintDocRefLike,
  type AdminMaintDocSnapLike,
  observeFirestoreAdminGeoPointInitAndMaintenance,
  probe as adminMaintProbe,
} from '../../probes/firestore-admin/firestore-admin-geopoint-init-and-maintenance.ts';

const WAVE2_SLICE2_PROBE_IDS = [
  'firestore-admin-geopoint-init-and-maintenance',
  'firestore-anonymous-listener-auth-transition',
  'firestore-connect-emulator-options',
] as const;

function wrapRulesBlock(block: string): string {
  return `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n${block}\n    match /{document=**} { allow read, write: if false; }\n  }\n}\n`;
}

function errorCodeOf(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const shaped = err as { code?: unknown };
    if (typeof shaped.code === 'string') {
      return shaped.code;
    }
  }
  return 'unknown';
}

function encodeLengthPrefixedJson(payload: Record<string, unknown>): Uint8Array {
  const json = JSON.stringify(payload);
  const body = new TextEncoder().encode(json);
  const prefix = new TextEncoder().encode(String(body.byteLength));
  const out = new Uint8Array(prefix.byteLength + body.byteLength);
  out.set(prefix, 0);
  out.set(body, prefix.byteLength);
  return out;
}

describe('Firestore Wave 2 connectFirestoreEmulator, anonymous listener, and admin maintenance probes', () => {
  test('registers all 3 staged sdk-probes with pendingRowLink and inert preview safety', async () => {
    expect(auditProbeSessionAuthModes()).toEqual([]);
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of WAVE2_SLICE2_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    const stagedProbes = [connectEmulatorProbe, anonymousListenerProbe, adminMaintProbe];
    for (const probeRecord of stagedProbes) {
      expect(probeRecord.rig).toBe('sdk-probes');
      expect(probeRecord.pendingRowLink).toBe(true);
      expect(probeRecord.matrixRow).toBe('');
      expect(probeRecord.rowIds).toEqual([]);
      expect(probeRecord.description.length).toBeGreaterThan(20);
    }

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );

    expectStagedUntilCaptured(WAVE2_SLICE2_PROBE_IDS, {
      rig: 'sdk-probes',
      filterFlag: '--probe',
      filterValueFor: (name) => name,
      whenUncaptured(name) {
        expect(unfilteredIds.has(name)).toBe(false);
      },
      whenCaptured(name) {
        expect(unfilteredIds.has(name)).toBe(true);
      },
    });

    const previewLines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded.filter((entry) =>
        (WAVE2_SLICE2_PROBE_IDS as readonly string[]).includes(entry.id),
      ),
      log: (line) => previewLines.push(line),
    });
    const previewText = previewLines.join('\n');
    expect(previewText).toContain('firestore-connect-emulator-options');
    expect(previewText).toContain('firestore-anonymous-listener-auth-transition');
    expect(previewText).toContain('firestore-admin-geopoint-init-and-maintenance');
  });

  test('executes offline connectFirestoreEmulator probe deterministically against firebase/firestore', async () => {
    const first = await connectEmulatorProbe.observe();
    const second = await connectEmulatorProbe.observe();
    expect(first).toEqual(second);
    expect(first.basicHostPort).toEqual({
      threw: false,
      code: null,
      errorName: null,
      isFirebaseError: false,
      messageMentionsSubOrUserId: false,
    });
    expect(first.afterDocReferenceCreation).toEqual({
      threw: false,
      code: null,
      errorName: null,
      isFirebaseError: false,
      messageMentionsSubOrUserId: false,
    });
    expect(first.mockUserTokenEmptyObject).toEqual({
      threw: true,
      code: null,
      errorName: 'Error',
      isFirebaseError: false,
      messageMentionsSubOrUserId: true,
    });
    expect(first.afterClientStarted).toEqual({
      threw: true,
      code: 'failed-precondition',
      errorName: 'FirebaseError',
      isFirebaseError: true,
      messageMentionsSubOrUserId: false,
    });
  });

  test('executes anonymous listener auth-transition observer cleanly against pyric/firestore', async () => {
    const runId = 'local_al';
    const basePath = `__pyric_fs_probe/${runId}`;
    const sandbox = initializeSandbox();
    setRules(sandbox, wrapRulesBlock(buildAnonymousListenerRulesBlock(runId)));
    sandbox.currentUser = null;
    const db = getFirestore(sandbox);

    const subject: AnonymousListenerAuthTransitionSubject = {
      async seedAdminDoc(relPath, data) {
        sandbox.admin.setDocument(`${basePath}/${relPath}`, data);
      },
      isSignedIn() {
        return sandbox.currentUser !== null;
      },
      async signInAs(roleLabel) {
        sandbox.currentUser = { uid: roleLabel };
        return roleLabel;
      },
      subscribeDoc(relPath, onNext, onError) {
        return onSnapshot(
          doc(db, `${basePath}/${relPath}`),
          (snap: unknown) => {
            onNext((snap as DocumentSnapshot).data() as Record<string, unknown> | undefined);
          },
          (err: unknown) => {
            onError(errorCodeOf(err));
          },
        );
      },
    };

    const observed = await observeFirestoreAnonymousListenerAuthTransition(subject, 500);
    expect(observed).toEqual({
      publicAnonymousListenerAcrossSignIn: {
        signedInBeforeAttach: false,
        signedInAfterSignIn: true,
        sawInitialPublic: true,
        sawPostSignInPublic: true,
        sawPostUserSwapPublic: true,
        stepsObserved: [0, 1, 2],
        errorCode: null,
      },
      ownerGatedListenerAcrossUserSwitch: {
        sawInitialOwned: true,
        countsObserved: [0],
        errorCodeAfterSwitch: 'permission-denied',
      },
    });
  });

  test('executes admin maintenance observer deterministically against firebase-admin GeoPoint and GrpcStatus', async () => {
    const store = new Map<string, Record<string, unknown>>();

    function makeDocRef(fullPath: string): AdminMaintDocRefLike {
      const segments = fullPath.split('/');
      const id = segments[segments.length - 1] ?? '';
      return {
        id,
        path: fullPath,
        async set(data) {
          store.set(fullPath, { ...data });
        },
        async get(): Promise<AdminMaintDocSnapLike> {
          const found = store.get(fullPath);
          return {
            id,
            exists: found !== undefined,
            data() {
              if (found === undefined) {
                return undefined;
              }
              return { ...found };
            },
          };
        },
      };
    }

    const subject: AdminFirestoreMaintenanceSubject = {
      createGeoPoint: (lat, lng) => new adminFs.GeoPoint(lat, lng),
      isGeoPoint: (val): val is AdminGeoPointLike => val instanceof adminFs.GeoPoint,
      grpcStatus: adminFs.GrpcStatus as unknown as Record<string, string | number>,
      setLogFunction: () => {},
      async checkSettingsAndInitialize() {
        return {
          initReturnsSameAsGetFirestore: true,
          repeatInitReturnsSameHandle: true,
          secondSettingsCallThrew: true,
          ignoreUndefinedStoredKeys: ['present'],
          terminateThenReadThrew: true,
          getFirestoreAfterTerminateSameHandle: true,
        };
      },
      doc: (relPath) => makeDocRef(`pyric_oracle/local/${relPath}`),
      topLevelCollection: (collectionId) => ({
        id: collectionId,
        path: collectionId,
        doc: (id) => makeDocRef(`${collectionId}/${id}`),
        async get() {
          let size = 0;
          for (const key of store.keys()) {
            if (key.startsWith(`${collectionId}/`) && key.split('/').length === 2) {
              size += 1;
            }
          }
          return { size };
        },
      }),
      async getAll(refs, fieldMask) {
        const out: AdminMaintDocSnapLike[] = [];
        for (const r of refs) {
          const snap = await r.get();
          if (fieldMask === undefined || !snap.exists) {
            out.push(snap);
            continue;
          }
          const raw = snap.data() ?? {};
          const projected: Record<string, unknown> = {};
          for (const field of fieldMask) {
            if (Object.hasOwn(raw, field)) {
              projected[field] = raw[field];
            }
          }
          out.push({
            id: snap.id,
            exists: true,
            data: () => projected,
          });
        }
        return out;
      },
      async callGetAllZeroArgs() {
        return true;
      },
      async listMatchingTopLevelSuffixes(prefix) {
        const cols = new Set<string>();
        for (const key of store.keys()) {
          const top = key.split('/')[0] ?? '';
          if (top.startsWith(prefix)) {
            cols.add(top.slice(prefix.length));
          }
        }
        return [...cols].sort();
      },
      async recursiveDeleteDoc(relPath) {
        const full = `pyric_oracle/local/${relPath}`;
        for (const key of [...store.keys()]) {
          if (key === full || key.startsWith(`${full}/`)) {
            store.delete(key);
          }
        }
      },
      async recursiveDeleteTopLevelCollection(collectionId) {
        for (const key of [...store.keys()]) {
          if (key.startsWith(`${collectionId}/`)) {
            store.delete(key);
          }
        }
      },
      createBulkWriter(): AdminMaintBulkWriterLike {
        let closed = false;
        let onResult: ((ref: { readonly path: string }) => void) | null = null;
        function ensureOpen(): void {
          if (closed) {
            throw new Error('BulkWriter has already been closed.');
          }
        }
        return {
          onWriteResult(cb) {
            onResult = cb;
          },
          create(ref, data) {
            ensureOpen();
            return (async () => {
              await ref.set(data);
              if (onResult) onResult(ref);
            })();
          },
          set(ref, data) {
            ensureOpen();
            return (async () => {
              await ref.set(data);
              if (onResult) onResult(ref);
            })();
          },
          update(ref, data) {
            ensureOpen();
            return (async () => {
              const prev = (await ref.get()).data() ?? {};
              await ref.set({ ...prev, ...data });
              if (onResult) onResult(ref);
            })();
          },
          delete(ref) {
            ensureOpen();
            return (async () => {
              store.delete(ref.path);
              if (onResult) onResult(ref);
            })();
          },
          async flush() {},
          async close() {
            closed = true;
          },
        };
      },
      async buildSampleBundle(bundleId, _docRelPath, _collectionRelPath, queryName) {
        const header = encodeLengthPrefixedJson({
          metadata: {
            id: bundleId,
            createTime: '2026-01-01T00:00:00Z',
            version: 1,
            totalDocuments: 2,
            totalBytes: '0',
          },
        });
        const named = encodeLengthPrefixedJson({
          namedQuery: { name: queryName },
        });
        return Buffer.concat([Buffer.from(header), Buffer.from(named)]);
      },
    };

    const observed = await observeFirestoreAdminGeoPointInitAndMaintenance(subject, '__lc_test_');
    expect((observed.geoPoint as Record<string, unknown>).equalSameCoords).toBe(true);
    expect((observed.geoPoint as Record<string, unknown>).roundTripIsGeoPoint).toBe(true);
    expect((observed.grpcStatus as Record<string, unknown>).notFound).toBe(5);
    expect((observed.listCollections as Record<string, unknown>).listedSuffixesBeforeDelete).toEqual(['a', 'b']);
    expect((observed.listCollections as Record<string, unknown>).listedSuffixesAfterDelete).toEqual(['b']);
    expect(observed.recursiveDelete).toEqual({
      rootExistsAfter: false,
      childExistsAfter: false,
      leafExistsAfter: false,
      siblingExistsAfter: true,
    });
    expect((observed.bulkWriter as Record<string, unknown>).writeResultsCount).toBe(4);
    expect((observed.bulkWriter as Record<string, unknown>).postCloseWriteThrew).toBe(true);
    expect((observed.bulkWriter as Record<string, unknown>).postCloseWriteThrewSynchronously).toBe(true);
    expect(observed.bundle).toEqual({
      isBuffer: true,
      metadataId: 'admin-items-bundle',
      version: 1,
      totalDocuments: 2,
      containsNamedQuery: true,
    });
  });
});
