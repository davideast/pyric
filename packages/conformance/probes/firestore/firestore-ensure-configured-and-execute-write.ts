import type { Probe } from '../../rigs/types.ts';

interface ObservedCallFailureShape {
  readonly syncThrew: boolean;
  readonly rejected: boolean;
  readonly code: string | null;
  readonly isFirebaseError: boolean;
}

export interface EnsureConfiguredAndExecuteWriteSubject<AppHandle, DbHandle> {
  createApp(name: string): AppHandle;
  deleteApp(app: AppHandle): Promise<void>;
  getFirestore(app: AppHandle): DbHandle;
  ensureFirestoreConfigured(db: DbHandle): unknown;
  executeWrite(db: DbHandle, mutations: unknown[]): Promise<void>;
  connectEmulator(db: DbHandle, host: string, port: number): void;
  terminate(db: DbHandle): Promise<void>;
  isFirebaseError(err: unknown): boolean;
}

function extractFailureFields(
  err: unknown,
  syncThrew: boolean,
  rejected: boolean,
  isFirebaseError: (err: unknown) => boolean,
): ObservedCallFailureShape {
  let code: string | null = null;
  if (err !== null && typeof err === 'object') {
    const rawCode = (err as { code?: unknown }).code;
    if (typeof rawCode === 'string') {
      code = rawCode;
    }
  }
  return {
    syncThrew,
    rejected,
    code,
    isFirebaseError: isFirebaseError(err),
  };
}

function captureSyncOutcome(
  fn: () => void,
  isFirebaseError: (err: unknown) => boolean,
): ObservedCallFailureShape {
  try {
    fn();
    return {
      syncThrew: false,
      rejected: false,
      code: null,
      isFirebaseError: false,
    };
  } catch (err) {
    return extractFailureFields(err, true, false, isFirebaseError);
  }
}

async function captureMaybeSyncOrAsyncOutcome(
  fn: () => Promise<unknown>,
  isFirebaseError: (err: unknown) => boolean,
): Promise<ObservedCallFailureShape> {
  let returnedPromise: Promise<unknown>;
  try {
    returnedPromise = fn();
  } catch (err) {
    return extractFailureFields(err, true, false, isFirebaseError);
  }
  try {
    await returnedPromise;
    return {
      syncThrew: false,
      rejected: false,
      code: null,
      isFirebaseError: false,
    };
  } catch (err) {
    return extractFailureFields(err, false, true, isFirebaseError);
  }
}

export async function observeFirestoreEnsureConfiguredAndExecuteWrite<AppHandle, DbHandle>(
  subject: EnsureConfiguredAndExecuteWriteSubject<AppHandle, DbHandle>,
): Promise<Record<string, unknown>> {
  const createdApps: AppHandle[] = [];
  const createdDbs: DbHandle[] = [];
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  function freshDb(tag: string): DbHandle {
    const app = subject.createApp(`fs-cfg-ew-${tag}-${suffix}`);
    createdApps.push(app);
    const db = subject.getFirestore(app);
    createdDbs.push(db);
    return db;
  }

  try {
    const configuredDb = freshDb('configured');
    const firstClient = subject.ensureFirestoreConfigured(configuredDb);
    const secondClient = subject.ensureFirestoreConfigured(configuredDb);
    const configuredReturn = {
      isObject: firstClient !== null && typeof firstClient === 'object',
      sameClientOnRepeat: firstClient === secondClient,
    };
    const emulatorAfterEnsureConfigured = captureSyncOutcome(
      () => subject.connectEmulator(configuredDb, '127.0.0.1', 8080),
      subject.isFirebaseError,
    );

    const execDb = freshDb('exec');
    let execSyncThrew = false;
    let execReturnsPromise = false;
    try {
      const pending = subject.executeWrite(execDb, []);
      execReturnsPromise = pending instanceof Promise;
      if (execReturnsPromise) {
        void pending.catch(() => undefined);
      }
    } catch {
      execSyncThrew = true;
    }
    const executeWriteOnActiveDb = {
      syncThrew: execSyncThrew,
      returnsPromise: execReturnsPromise,
    };
    const emulatorAfterExecuteWrite = captureSyncOutcome(
      () => subject.connectEmulator(execDb, '127.0.0.1', 8080),
      subject.isFirebaseError,
    );

    const terminatedDb = freshDb('terminated');
    await subject.terminate(terminatedDb);
    const ensureConfiguredAfterTerminate = captureSyncOutcome(
      () => {
        subject.ensureFirestoreConfigured(terminatedDb);
      },
      subject.isFirebaseError,
    );
    const executeWriteAfterTerminate = await captureMaybeSyncOrAsyncOutcome(
      () => subject.executeWrite(terminatedDb, []),
      subject.isFirebaseError,
    );

    return {
      configuredReturn,
      emulatorAfterEnsureConfigured,
      executeWriteOnActiveDb,
      emulatorAfterExecuteWrite,
      ensureConfiguredAfterTerminate,
      executeWriteAfterTerminate,
    };
  } finally {
    for (const db of createdDbs) {
      await subject.terminate(db).catch(() => undefined);
    }
    for (const app of createdApps) {
      await subject.deleteApp(app).catch(() => undefined);
    }
  }
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: [],
  matrixRow: '',
  rowIds: [],
  pendingRowLink: true,
  description:
    'firebase/firestore ensureFirestoreConfigured(db) idempotent client initialization and post-start/post-terminate failed-precondition guards, plus executeWrite(db, []) synchronous startup transition, Promise return, and synchronous post-terminate failed-precondition throw.',
  async observe(): Promise<Record<string, unknown>> {
    const [appMod, fsMod] = await Promise.all([
      import('firebase/app'),
      import('firebase/firestore'),
    ]);
    const runtimePlumbing = fsMod as unknown as {
      ensureFirestoreConfigured(targetDb: ReturnType<typeof fsMod.getFirestore>): unknown;
      executeWrite(
        targetDb: ReturnType<typeof fsMod.getFirestore>,
        batchMutations: unknown[],
      ): Promise<void>;
    };

    return observeFirestoreEnsureConfiguredAndExecuteWrite({
      createApp(name: string) {
        return appMod.initializeApp({ projectId: 'demo-ensure-exec-probe' }, name);
      },
      deleteApp(app) {
        return appMod.deleteApp(app);
      },
      getFirestore(app) {
        return fsMod.getFirestore(app);
      },
      ensureFirestoreConfigured(db) {
        return runtimePlumbing.ensureFirestoreConfigured(db);
      },
      executeWrite(db, mutations: unknown[]) {
        return runtimePlumbing.executeWrite(db, mutations);
      },
      connectEmulator(db, host: string, port: number) {
        fsMod.connectFirestoreEmulator(db, host, port);
      },
      terminate(db) {
        return fsMod.terminate(db);
      },
      isFirebaseError(err: unknown): boolean {
        return err instanceof appMod.FirebaseError;
      },
    });
  },
};
