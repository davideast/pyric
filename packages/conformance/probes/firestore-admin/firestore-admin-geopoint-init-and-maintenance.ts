import type { Probe } from '../../rigs/types.ts';

export interface AdminGeoPointLike {
  readonly latitude: number;
  readonly longitude: number;
  isEqual(other: AdminGeoPointLike): boolean;
}

export interface AdminMaintDocSnapLike {
  readonly id: string;
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
}

export interface AdminMaintDocRefLike {
  readonly id: string;
  readonly path: string;
  set(data: Record<string, unknown>): Promise<unknown>;
  get(): Promise<AdminMaintDocSnapLike>;
}

interface AdminMaintCollectionRefLike {
  readonly id: string;
  readonly path: string;
  doc(id: string): AdminMaintDocRefLike;
  get(): Promise<{ readonly size: number }>;
}

export interface AdminMaintBulkWriterLike {
  onWriteResult(callback: (ref: { readonly path: string }) => void): void;
  create(ref: AdminMaintDocRefLike, data: Record<string, unknown>): Promise<unknown>;
  set(ref: AdminMaintDocRefLike, data: Record<string, unknown>): Promise<unknown>;
  update(ref: AdminMaintDocRefLike, data: Record<string, unknown>): Promise<unknown>;
  delete(ref: AdminMaintDocRefLike): Promise<unknown>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface AdminFirestoreMaintenanceSubject {
  createGeoPoint(latitude: number, longitude: number): AdminGeoPointLike;
  isGeoPoint(value: unknown): value is AdminGeoPointLike;
  grpcStatus: Record<string, string | number>;
  setLogFunction(logger: ((msg: string) => void) | null): void;
  checkSettingsAndInitialize(): Promise<{
    readonly initReturnsSameAsGetFirestore: boolean;
    readonly repeatInitReturnsSameHandle: boolean;
    readonly secondSettingsCallThrew: boolean;
    readonly ignoreUndefinedStoredKeys: readonly string[];
    readonly terminateThenReadThrew: boolean;
    readonly getFirestoreAfterTerminateSameHandle: boolean;
  }>;
  doc(relPath: string): AdminMaintDocRefLike;
  topLevelCollection(collectionId: string): AdminMaintCollectionRefLike;
  getAll(
    refs: readonly AdminMaintDocRefLike[],
    fieldMask?: readonly string[],
  ): Promise<readonly AdminMaintDocSnapLike[]>;
  callGetAllZeroArgs(): Promise<boolean>;
  listMatchingTopLevelSuffixes(prefix: string): Promise<readonly string[]>;
  recursiveDeleteDoc(relPath: string): Promise<void>;
  recursiveDeleteTopLevelCollection(collectionId: string): Promise<void>;
  createBulkWriter(): AdminMaintBulkWriterLike;
  buildSampleBundle(
    bundleId: string,
    docRelPath: string,
    collectionRelPath: string,
    queryName: string,
  ): Promise<Uint8Array>;
}

function syncThrew(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

async function callThrew(fn: () => unknown): Promise<{
  readonly threw: boolean;
  readonly threwSynchronously: boolean;
}> {
  let pending: unknown;
  try {
    pending = fn();
  } catch {
    return { threw: true, threwSynchronously: true };
  }
  if (pending instanceof Promise) {
    try {
      await pending;
      return { threw: false, threwSynchronously: false };
    } catch {
      return { threw: true, threwSynchronously: false };
    }
  }
  return { threw: false, threwSynchronously: false };
}

function parseFirstLengthPrefixedJson(bytes: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder().decode(bytes);
  const braceIdx = text.indexOf('{');
  if (braceIdx <= 0) {
    throw new Error('Expected length-prefixed JSON bundle header');
  }
  const byteLen = Number.parseInt(text.slice(0, braceIdx), 10);
  const encoded = new TextEncoder().encode(text.slice(braceIdx));
  const headerSlice = encoded.slice(0, byteLen);
  return JSON.parse(new TextDecoder().decode(headerSlice)) as Record<string, unknown>;
}

export async function observeFirestoreAdminGeoPointInitAndMaintenance(
  subject: AdminFirestoreMaintenanceSubject,
  listColPrefix: string,
): Promise<Record<string, unknown>> {
  const gpA = subject.createGeoPoint(37.7749, -122.4194);
  const gpB = subject.createGeoPoint(37.7749, -122.4194);
  const gpZero = subject.createGeoPoint(0, 0);

  await subject.doc('geo/point-1').set({ label: 'sf', coords: gpA });
  const geoSnap = await subject.doc('geo/point-1').get();
  const rawCoords = geoSnap.data()?.coords;
  const roundTripIsGeoPoint = subject.isGeoPoint(rawCoords);
  let roundTripEqual = false;
  let roundTripLat: number | null = null;
  let roundTripLng: number | null = null;
  if (subject.isGeoPoint(rawCoords)) {
    roundTripEqual = rawCoords.isEqual(gpA);
    roundTripLat = rawCoords.latitude;
    roundTripLng = rawCoords.longitude;
  }

  let logFnAccepted = false;
  subject.setLogFunction(() => {});
  subject.setLogFunction(null);
  logFnAccepted = true;

  const settingsAndLifecycle = await subject.checkSettingsAndInitialize();

  await subject.doc('getall/a').set({ title: 'Alpha', rank: 1 });
  await subject.doc('getall/b').set({ title: 'Beta', rank: 2 });
  const orderedSnaps = await subject.getAll([
    subject.doc('getall/b'),
    subject.doc('getall/missing'),
    subject.doc('getall/a'),
  ]);
  const maskedSnaps = await subject.getAll(
    [subject.doc('getall/a'), subject.doc('getall/b')],
    ['title'],
  );
  const zeroArgsThrew = await subject.callGetAllZeroArgs();

  const colFirst = `${listColPrefix}b`;
  const colSecond = `${listColPrefix}a`;
  await subject.topLevelCollection(colFirst).doc('d1').set({ v: 1 });
  await subject.topLevelCollection(colSecond).doc('d1').set({ v: 2 });
  const listedSuffixesBeforeDelete = await subject.listMatchingTopLevelSuffixes(listColPrefix);
  await subject.recursiveDeleteTopLevelCollection(colSecond);
  const listedSuffixesAfterDelete = await subject.listMatchingTopLevelSuffixes(listColPrefix);
  await subject.recursiveDeleteTopLevelCollection(colFirst);

  await subject.doc('tree/root').set({ level: 0 });
  await subject.doc('tree/root/children/c1').set({ level: 1 });
  await subject.doc('tree/root/children/c1/leaves/l1').set({ level: 2 });
  await subject.doc('tree/sibling').set({ keep: true });
  await subject.recursiveDeleteDoc('tree/root');
  const rootExistsAfter = (await subject.doc('tree/root').get()).exists;
  const childExistsAfter = (await subject.doc('tree/root/children/c1').get()).exists;
  const leafExistsAfter = (await subject.doc('tree/root/children/c1/leaves/l1').get()).exists;
  const siblingExistsAfter = (await subject.doc('tree/sibling').get()).exists;

  await subject.doc('bw/remove-me').set({ stale: true });
  const bw = subject.createBulkWriter();
  let writeResultsCount = 0;
  bw.onWriteResult(() => {
    writeResultsCount += 1;
  });
  const p1 = bw.create(subject.doc('bw/created'), { step: 1 });
  const p2 = bw.set(subject.doc('bw/upserted'), { step: 2 });
  await bw.flush();
  await Promise.all([p1, p2]);
  const p3 = bw.update(subject.doc('bw/created'), { step: 3 });
  const p4 = bw.delete(subject.doc('bw/remove-me'));
  await bw.flush();
  await Promise.all([p3, p4]);
  await bw.close();
  const postCloseWrite = await callThrew(() =>
    bw.set(subject.doc('bw/after-close'), { bad: true }),
  );
  const bwCreatedData = (await subject.doc('bw/created').get()).data();
  const bwUpsertedData = (await subject.doc('bw/upserted').get()).data();
  const bwRemovedExists = (await subject.doc('bw/remove-me').get()).exists;

  await subject.doc('bundle-items/one').set({ tag: 'first' });
  await subject.doc('bundle-items/two').set({ tag: 'second' });
  const bundleBytes = await subject.buildSampleBundle(
    'admin-items-bundle',
    'bundle-items/one',
    'bundle-items',
    'all-bundle-items',
  );
  const headerObj = parseFirstLengthPrefixedJson(bundleBytes);
  const metadata = (headerObj.metadata ?? {}) as Record<string, unknown>;
  const fullBundleText = new TextDecoder().decode(bundleBytes);

  return {
    geoPoint: {
      latitude: gpA.latitude,
      longitude: gpA.longitude,
      equalSameCoords: gpA.isEqual(gpB),
      equalDifferentCoords: gpA.isEqual(gpZero),
      roundTripIsGeoPoint,
      roundTripEqual,
      roundTripLat,
      roundTripLng,
      nanLatitudeThrows: syncThrew(() => subject.createGeoPoint(Number.NaN, 0)),
      outOfRangeLatHighThrows: syncThrew(() => subject.createGeoPoint(90.1, 0)),
      outOfRangeLatLowThrows: syncThrew(() => subject.createGeoPoint(-90.1, 0)),
      outOfRangeLngHighThrows: syncThrew(() => subject.createGeoPoint(0, 180.1)),
      outOfRangeLngLowThrows: syncThrew(() => subject.createGeoPoint(0, -180.1)),
    },
    grpcStatus: {
      ok: subject.grpcStatus.OK,
      invalidArgument: subject.grpcStatus.INVALID_ARGUMENT,
      notFound: subject.grpcStatus.NOT_FOUND,
      alreadyExists: subject.grpcStatus.ALREADY_EXISTS,
      permissionDenied: subject.grpcStatus.PERMISSION_DENIED,
      failedPrecondition: subject.grpcStatus.FAILED_PRECONDITION,
      unauthenticated: subject.grpcStatus.UNAUTHENTICATED,
      reverseNotFoundName: subject.grpcStatus['5'],
    },
    logFunctionAccepted: logFnAccepted,
    settingsAndLifecycle,
    getAll: {
      orderedIds: orderedSnaps.map((s) => s.id),
      orderedExists: orderedSnaps.map((s) => s.exists),
      orderedData: orderedSnaps.map((s) => s.data() ?? null),
      maskedData: maskedSnaps.map((s) => s.data() ?? null),
      zeroArgsThrew,
    },
    listCollections: {
      listedSuffixesBeforeDelete,
      listedSuffixesAfterDelete,
    },
    recursiveDelete: {
      rootExistsAfter,
      childExistsAfter,
      leafExistsAfter,
      siblingExistsAfter,
    },
    bulkWriter: {
      writeResultsCount,
      postCloseWriteThrew: postCloseWrite.threw,
      postCloseWriteThrewSynchronously: postCloseWrite.threwSynchronously,
      createdData: bwCreatedData ?? null,
      upsertedData: bwUpsertedData ?? null,
      removedExists: bwRemovedExists,
    },
    bundle: {
      isBuffer: Buffer.isBuffer(bundleBytes),
      metadataId: metadata.id ?? null,
      version: metadata.version ?? null,
      totalDocuments: metadata.totalDocuments ?? null,
      containsNamedQuery: fullBundleText.includes('"all-bundle-items"'),
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['admin-firestore'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase-admin/firestore GeoPoint, GrpcStatus, initializeFirestore, setLogFunction, and Firestore.{settings, getAll, listCollections, recursiveDelete, bulkWriter, bundle, terminate}.',
  async observe(): Promise<Record<string, unknown>> {
    const [adminAppMod, fsMod, { loadOracleServiceAccount, oracleAppOptions }] = await Promise.all([
      import('firebase-admin/app'),
      import('firebase-admin/firestore'),
      import('../../src/oracle-credential.ts'),
    ]);

    const sa = await loadOracleServiceAccount();
    const runId = `adm_maint_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const basePath = `pyric_oracle/${runId}`;
    const listColPrefix = `__pyric_admin_lc_${runId}_`;

    const mainApp = adminAppMod.initializeApp(oracleAppOptions(sa), `sdk-probe-maint-${runId}`);
    const mainDb = fsMod.getFirestore(mainApp);

    try {
      const subject: AdminFirestoreMaintenanceSubject = {
        createGeoPoint: (lat, lng) => new fsMod.GeoPoint(lat, lng),
        isGeoPoint: (val): val is AdminGeoPointLike => val instanceof fsMod.GeoPoint,
        grpcStatus: fsMod.GrpcStatus as unknown as Record<string, string | number>,
        setLogFunction: (logger) => {
          fsMod.setLogFunction(logger as Parameters<typeof fsMod.setLogFunction>[0]);
        },
        async checkSettingsAndInitialize() {
          const initApp = adminAppMod.initializeApp(
            oracleAppOptions(sa),
            `sdk-probe-init-${runId}`,
          );
          const settingsApp = adminAppMod.initializeApp(
            oracleAppOptions(sa),
            `sdk-probe-settings-${runId}`,
          );
          try {
            const initDb = fsMod.initializeFirestore(initApp, {
              preferRest: false,
            });
            const viaGet = fsMod.getFirestore(initApp);
            const repeatInit = fsMod.initializeFirestore(initApp, {
              preferRest: false,
            });

            const settingsDb = fsMod.getFirestore(settingsApp);
            settingsDb.settings({ ignoreUndefinedProperties: true });
            const secondSettingsCallThrew = syncThrew(() => {
              settingsDb.settings({ ignoreUndefinedProperties: false });
            });
            const settingsDoc = settingsDb.doc(`${basePath}/init-settings/doc-1`);
            await settingsDoc.set({
              present: 'yes',
              omitted: undefined,
            } as Record<string, unknown>);
            const snap = await settingsDoc.get();
            const storedKeys = Object.keys(snap.data() ?? {}).sort();

            await settingsDb.terminate();
            const afterTermHandle = fsMod.getFirestore(settingsApp);
            let terminateThenReadThrew = false;
            try {
              await settingsDb.doc(`${basePath}/init-settings/doc-1`).set({
                afterTerminate: true,
              });
            } catch {
              terminateThenReadThrew = true;
            }
            await initDb.terminate().catch(() => undefined);

            return {
              initReturnsSameAsGetFirestore: initDb === viaGet,
              repeatInitReturnsSameHandle: repeatInit === initDb,
              secondSettingsCallThrew,
              ignoreUndefinedStoredKeys: storedKeys,
              terminateThenReadThrew,
              getFirestoreAfterTerminateSameHandle: afterTermHandle === settingsDb,
            };
          } finally {
            await adminAppMod.deleteApp(initApp).catch(() => undefined);
            await adminAppMod.deleteApp(settingsApp).catch(() => undefined);
          }
        },
        doc: (relPath) => mainDb.doc(`${basePath}/${relPath}`) as unknown as AdminMaintDocRefLike,
        topLevelCollection: (collectionId) =>
          mainDb.collection(collectionId) as unknown as AdminMaintCollectionRefLike,
        async getAll(refs, fieldMask) {
          const rawRefs = refs as unknown as FirebaseFirestore.DocumentReference[];
          if (fieldMask !== undefined) {
            return (await mainDb.getAll(...rawRefs, {
              fieldMask: [...fieldMask],
            })) as unknown as AdminMaintDocSnapLike[];
          }
          return (await mainDb.getAll(...rawRefs)) as unknown as AdminMaintDocSnapLike[];
        },
        async callGetAllZeroArgs() {
          try {
            await (mainDb.getAll as (...args: unknown[]) => Promise<unknown>)();
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
        createBulkWriter() {
          return mainDb.bulkWriter() as unknown as AdminMaintBulkWriterLike;
        },
        async buildSampleBundle(bundleId, docRelPath, collectionRelPath, queryName) {
          const singleSnap = await mainDb.doc(`${basePath}/${docRelPath}`).get();
          const querySnap = await mainDb.collection(`${basePath}/${collectionRelPath}`).get();
          const builder = mainDb.bundle(bundleId);
          builder.add(singleSnap);
          builder.add(queryName, querySnap);
          return builder.build();
        },
      };

      return await observeFirestoreAdminGeoPointInitAndMaintenance(subject, listColPrefix);
    } finally {
      fsMod.setLogFunction(null as never);
      await mainDb.recursiveDelete(mainDb.collection(`${listColPrefix}a`)).catch(() => undefined);
      await mainDb.recursiveDelete(mainDb.collection(`${listColPrefix}b`)).catch(() => undefined);
      await mainDb.recursiveDelete(mainDb.doc(basePath)).catch(() => undefined);
      await mainDb.terminate().catch(() => undefined);
      await adminAppMod.deleteApp(mainApp).catch(() => undefined);
    }
  },
};
