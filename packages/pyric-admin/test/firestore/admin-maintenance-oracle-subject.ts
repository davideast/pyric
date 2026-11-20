import type { Sandbox } from 'pyric/sandbox';
import type { RemoteSandbox } from '../../../cli/src/remote/index.js';
import { deleteApp, initializeApp } from '../../src/app/index.js';
import {
  GeoPoint,
  getFirestore,
  GrpcStatus,
  initializeFirestore,
  setLogFunction,
} from '../../src/firestore/index.js';
import type { AdminBulkWriter } from '../../src/firestore/admin-bulk-writer.js';
import type { AdminBundleBuilder } from '../../src/firestore/admin-bundle-builder.js';
import type {
  AdminFirestoreMaintenanceSubject,
  AdminMaintBulkWriterLike,
  AdminMaintDocRefLike,
  AdminMaintDocSnapLike,
} from '../../../conformance/probes/firestore-admin/firestore-admin-geopoint-init-and-maintenance.ts';

type ExtendedAdminDb = ReturnType<typeof getFirestore> & {
  settings(s: Record<string, unknown>): void;
  terminate(): Promise<void>;
  getAll(...args: unknown[]): Promise<AdminMaintDocSnapLike[]>;
  listCollections(): Promise<Array<{ id: string }>>;
  recursiveDelete(ref: unknown): Promise<void>;
  bulkWriter(): AdminBulkWriter;
  bundle(id?: string): AdminBundleBuilder;
};

export function createAdminMaintenanceReplaySubject(
  adminSandbox: Sandbox | RemoteSandbox,
  basePath: string,
  armTag: string,
): AdminFirestoreMaintenanceSubject {
  const mainApp = initializeApp(
    { sandbox: adminSandbox, projectId: 'proj-1' },
    `fs-admin-maint-main-${armTag}`,
  );
  const mainDb = getFirestore(mainApp) as ExtendedAdminDb;

  return {
    createGeoPoint: (lat, lng) => new GeoPoint(lat, lng),
    isGeoPoint: (val): val is GeoPoint => val instanceof GeoPoint,
    grpcStatus: GrpcStatus as Record<string, string | number>,
    setLogFunction: (fn) => setLogFunction(fn),
    async checkSettingsAndInitialize() {
      const initApp = initializeApp(
        { sandbox: adminSandbox, projectId: 'proj-1' },
        `fs-admin-maint-init-${armTag}`,
      );
      const settingsApp = initializeApp(
        { sandbox: adminSandbox, projectId: 'proj-1' },
        `fs-admin-maint-settings-${armTag}`,
      );
      try {
        const initDb = initializeFirestore(initApp, { preferRest: false }) as ExtendedAdminDb;
        const viaGet = getFirestore(initApp);
        const repeatInit = initializeFirestore(initApp, { preferRest: false });

        const settingsDb = getFirestore(settingsApp) as ExtendedAdminDb;
        settingsDb.settings({ ignoreUndefinedProperties: true });
        let secondSettingsCallThrew = false;
        try {
          settingsDb.settings({ ignoreUndefinedProperties: false });
        } catch {
          secondSettingsCallThrew = true;
        }
        const settingsDoc = settingsDb.doc(`${basePath}/init-settings/doc-1`);
        await settingsDoc.set({ present: 'yes', omitted: undefined } as Record<string, unknown>);
        const snap = await settingsDoc.get();
        const storedKeys = Object.keys(snap.data() ?? {}).sort();

        await settingsDb.terminate();
        const afterTermHandle = getFirestore(settingsApp);
        let terminateThenReadThrew = false;
        try {
          await settingsDb.doc(`${basePath}/init-settings/doc-1`).set({ afterTerminate: true });
        } catch {
          terminateThenReadThrew = true;
        }
        await initDb.terminate();

        return {
          initReturnsSameAsGetFirestore: initDb === viaGet,
          repeatInitReturnsSameHandle: repeatInit === initDb,
          secondSettingsCallThrew,
          ignoreUndefinedStoredKeys: storedKeys,
          terminateThenReadThrew,
          getFirestoreAfterTerminateSameHandle: afterTermHandle === settingsDb,
        };
      } finally {
        await deleteApp(initApp).catch(() => undefined);
        await deleteApp(settingsApp).catch(() => undefined);
      }
    },
    doc: (relPath) => mainDb.doc(`${basePath}/${relPath}`) as unknown as AdminMaintDocRefLike,
    topLevelCollection: (collectionId) =>
      mainDb.collection(collectionId) as unknown as ReturnType<
        AdminFirestoreMaintenanceSubject['topLevelCollection']
      >,
    async getAll(refs, fieldMask) {
      if (fieldMask !== undefined) {
        return mainDb.getAll(...refs, { fieldMask: [...fieldMask] });
      }
      return mainDb.getAll(...refs);
    },
    async callGetAllZeroArgs() {
      try {
        await mainDb.getAll();
        return false;
      } catch {
        return true;
      }
    },
    async listMatchingTopLevelSuffixes(prefix) {
      const cols = await mainDb.listCollections();
      return cols
        .map((c) => c.id)
        .filter((id) => id.startsWith(prefix))
        .map((id) => id.slice(prefix.length));
    },
    async recursiveDeleteDoc(relPath) {
      await mainDb.recursiveDelete(mainDb.doc(`${basePath}/${relPath}`));
    },
    async recursiveDeleteTopLevelCollection(collectionId) {
      await mainDb.recursiveDelete(mainDb.collection(collectionId));
    },
    createBulkWriter: () => mainDb.bulkWriter() as unknown as AdminMaintBulkWriterLike,
    async buildSampleBundle(bundleId, docRelPath, collectionRelPath, queryName) {
      const singleSnap = await mainDb.doc(`${basePath}/${docRelPath}`).get();
      const querySnap = await mainDb.collection(`${basePath}/${collectionRelPath}`).get();
      return mainDb.bundle(bundleId).add(singleSnap).add(queryName, querySnap).build();
    },
  };
}
