import type { Probe } from '../../rigs/types.ts';
import { loadOracleServiceAccount, oracleAppOptions } from '../../src/oracle-credential.ts';
import { resolveProbeWebConfig, withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

interface DeletedAppCallOutcome {
  readonly mode: 'sync-throw' | 'rejected' | 'resolved';
  readonly code: string | null;
  readonly message: string | null;
}

interface UnauthenticatedReadOutcome {
  readonly threw: boolean;
  readonly code: string | null;
}

interface RetainedHandleReadOutcome {
  readonly threw: boolean;
  readonly code: string | null;
  readonly exists: boolean | null;
}

export interface FirestoreAdminBypassLifecycleSubject<AppHandle, DbHandle> {
  initializeNamedAdminApp(name: string): AppHandle;
  getAdminFirestore(app: AppHandle): DbHandle;
  getAdminFirestoreRaw(arg: unknown): unknown;
  deleteAdminApp(app: AppHandle): Promise<void>;
  readProtectedViaUnauthenticatedClient(docPath: string): Promise<void>;
  writeViaAdmin(db: DbHandle, docPath: string, data: Record<string, unknown>): Promise<void>;
  readViaAdmin(
    db: DbHandle,
    docPath: string,
  ): Promise<{ readonly exists: boolean; readonly data: Record<string, unknown> | undefined }>;
}

function captureSyncCallOutcome(
  operation: () => unknown,
  appName: string,
): DeletedAppCallOutcome {
  try {
    operation();
    return {
      mode: 'resolved',
      code: null,
      message: null,
    };
  } catch (error) {
    const shaped = error as { code?: unknown; message?: unknown };
    let code: string | null = null;
    if (typeof shaped.code === 'string') {
      code = shaped.code;
    }
    let message = String(error);
    if (typeof shaped.message === 'string') {
      message = shaped.message;
    }
    message = message.replaceAll(appName, '<appName>');
    return {
      mode: 'sync-throw',
      code,
      message,
    };
  }
}

function captureTypeErrorThrow(operation: () => unknown): boolean {
  try {
    operation();
    return false;
  } catch (error) {
    return error instanceof TypeError;
  }
}

async function captureUnauthenticatedRead(
  operation: () => Promise<void>,
): Promise<UnauthenticatedReadOutcome> {
  try {
    await operation();
    return {
      threw: false,
      code: null,
    };
  } catch (error) {
    const shaped = error as { code?: unknown };
    let code: string | null = null;
    if (typeof shaped.code === 'string') {
      code = shaped.code;
    }
    return {
      threw: true,
      code,
    };
  }
}

async function captureRetainedHandleRead(
  operation: () => Promise<{ readonly exists: boolean }>,
): Promise<RetainedHandleReadOutcome> {
  let pending: Promise<{ readonly exists: boolean }>;
  try {
    pending = operation();
  } catch (error) {
    const shaped = error as { code?: unknown };
    let code: string | null = null;
    if (typeof shaped.code === 'string') {
      code = shaped.code;
    }
    return {
      threw: true,
      code,
      exists: null,
    };
  }
  try {
    const snap = await pending;
    return {
      threw: false,
      code: null,
      exists: snap.exists,
    };
  } catch (error) {
    const shaped = error as { code?: unknown };
    let code: string | null = null;
    if (typeof shaped.code === 'string') {
      code = shaped.code;
    }
    return {
      threw: true,
      code,
      exists: null,
    };
  }
}

export async function observeFirestoreAdminBypassAndLifecycle<AppHandle, DbHandle>(
  subject: FirestoreAdminBypassLifecycleSubject<AppHandle, DbHandle>,
  protectedDocPath: string,
): Promise<Record<string, unknown>> {
  const createdApps: AppHandle[] = [];
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const appAName = `fs-admin-lifecycle-a-${suffix}`;
  const appBName = `fs-admin-lifecycle-b-${suffix}`;

  const appA = subject.initializeNamedAdminApp(appAName);
  const appB = subject.initializeNamedAdminApp(appBName);
  createdApps.push(appB);

  try {
    const dbAFirst = subject.getAdminFirestore(appA);
    const dbASecond = subject.getAdminFirestore(appA);
    const dbB = subject.getAdminFirestore(appB);

    const cachedSameAppHandle = dbAFirst === dbASecond;
    const distinctHandlesAcrossApps = dbAFirst !== dbB;
    const nonAppObjectThrowsTypeError = captureTypeErrorThrow(() =>
      subject.getAdminFirestoreRaw({}),
    );
    const nullAppThrowsTypeError = captureTypeErrorThrow(() =>
      subject.getAdminFirestoreRaw(null),
    );

    await subject.writeViaAdmin(dbAFirst, protectedDocPath, {
      scope: 'admin-bypass',
      level: 7,
    });
    const adminBypassRead = await subject.readViaAdmin(dbAFirst, protectedDocPath);
    const unauthenticatedClientRead = await captureUnauthenticatedRead(() =>
      subject.readProtectedViaUnauthenticatedClient(protectedDocPath),
    );

    await subject.deleteAdminApp(appA);
    const getFirestoreAfterDeleteApp = captureSyncCallOutcome(
      () => subject.getAdminFirestore(appA),
      appAName,
    );
    const retainedHandleReadAfterDeleteApp = await captureRetainedHandleRead(() =>
      subject.readViaAdmin(dbAFirst, protectedDocPath),
    );
    const siblingReadAfterPrimaryDelete = await subject.readViaAdmin(dbB, protectedDocPath);

    return {
      cachedSameAppHandle,
      distinctHandlesAcrossApps,
      nonAppObjectThrowsTypeError,
      nullAppThrowsTypeError,
      adminBypassRead,
      unauthenticatedClientRead,
      getFirestoreAfterDeleteApp,
      retainedHandleReadAfterDeleteApp,
      siblingReadAfterPrimaryDelete: siblingReadAfterPrimaryDelete.exists,
    };
  } finally {
    await Promise.all(
      createdApps.map((app) => subject.deleteAdminApp(app).catch(() => undefined)),
    );
  }
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules', 'admin-firestore'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase-admin/firestore getFirestore(app) caches one Firestore handle per active app, isolates handles across apps, throws TypeError on non-app objects/null, bypasses Firestore Security Rules that deny unauthenticated client reads with permission-denied, and throws app/app-deleted synchronously after deleteApp(app) while preserving sibling apps.',
  async observe(): Promise<Record<string, unknown>> {
    return withFirestoreProbeSession(async ({ runId, collectionPath, firestoreSdk }) => {
      const [
        { deleteApp: deleteClientApp, initializeApp: initializeClientApp },
        adminAppMod,
        adminFsMod,
      ] = await Promise.all([
        import('firebase/app'),
        import('firebase-admin/app'),
        import('firebase-admin/firestore'),
      ]);
      const sa = await loadOracleServiceAccount();
      const webConfig = await resolveProbeWebConfig(sa);
      const unauthClientApp = initializeClientApp(
        webConfig,
        `sdk-probe-fs-admin-unauth-${runId}`,
      );
      const unauthClientDb = firestoreSdk.getFirestore(unauthClientApp);
      const protectedDocPath = `${collectionPath('bypass')}/doc-1`;

      try {
        return await observeFirestoreAdminBypassAndLifecycle(
          {
            initializeNamedAdminApp(name: string) {
              return adminAppMod.initializeApp(oracleAppOptions(sa), name);
            },
            getAdminFirestore(app) {
              return adminFsMod.getFirestore(app);
            },
            getAdminFirestoreRaw(arg: unknown) {
              return adminFsMod.getFirestore(arg as never);
            },
            deleteAdminApp(app) {
              return adminAppMod.deleteApp(app);
            },
            async readProtectedViaUnauthenticatedClient(docPath: string): Promise<void> {
              await firestoreSdk.getDoc(firestoreSdk.doc(unauthClientDb, docPath));
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
          },
          protectedDocPath,
        );
      } finally {
        await deleteClientApp(unauthClientApp).catch(() => undefined);
      }
    });
  },
};
