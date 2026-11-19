import type { Probe } from '../../rigs/types.ts';

interface ObservedEmulatorCallOutcome {
  readonly threw: boolean;
  readonly code: string | null;
  readonly errorName: string | null;
  readonly isFirebaseError: boolean;
  readonly messageMentionsSubOrUserId: boolean;
}

interface ConnectFirestoreEmulatorSubject<AppHandle, DbHandle> {
  createApp(name: string): AppHandle;
  deleteApp(app: AppHandle): Promise<void>;
  getFirestore(app: AppHandle): DbHandle;
  createDocRef(db: DbHandle, path: string): unknown;
  disableNetwork(db: DbHandle): Promise<void>;
  terminate(db: DbHandle): Promise<void>;
  connectEmulator(
    db: DbHandle,
    host: string,
    port: number,
    options?: Record<string, unknown>,
  ): void;
  isFirebaseError(err: unknown): boolean;
}

function captureOutcome(
  fn: () => void,
  isFirebaseError: (err: unknown) => boolean,
): ObservedEmulatorCallOutcome {
  try {
    fn();
    return {
      threw: false,
      code: null,
      errorName: null,
      isFirebaseError: false,
      messageMentionsSubOrUserId: false,
    };
  } catch (err) {
    let code: string | null = null;
    let errorName: string | null = null;
    let message = '';
    if (err !== null && typeof err === 'object') {
      const shaped = err as { code?: unknown; name?: unknown; message?: unknown };
      if (typeof shaped.code === 'string') {
        code = shaped.code;
      }
      if (typeof shaped.name === 'string') {
        errorName = shaped.name;
      }
      if (typeof shaped.message === 'string') {
        message = shaped.message;
      }
    }
    const mentionsSub = message.includes('sub') && message.includes('user_id');
    return {
      threw: true,
      code,
      errorName,
      isFirebaseError: isFirebaseError(err),
      messageMentionsSubOrUserId: mentionsSub,
    };
  }
}

async function observeFirestoreConnectEmulatorOptions<AppHandle, DbHandle>(
  subject: ConnectFirestoreEmulatorSubject<AppHandle, DbHandle>,
): Promise<Record<string, unknown>> {
  const createdApps: AppHandle[] = [];
  const createdDbs: DbHandle[] = [];
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  function freshDb(tag: string): DbHandle {
    const app = subject.createApp(`fs-emu-${tag}-${suffix}`);
    createdApps.push(app);
    const db = subject.getFirestore(app);
    createdDbs.push(db);
    return db;
  }

  try {
    const basicDb = freshDb('basic');
    const basicHostPort = captureOutcome(
      () => subject.connectEmulator(basicDb, '127.0.0.1', 8080),
      subject.isFirebaseError,
    );
    const repeatBeforeStart = captureOutcome(
      () => subject.connectEmulator(basicDb, '127.0.0.1', 8085),
      subject.isFirebaseError,
    );

    const docFirstDb = freshDb('doc-first');
    subject.createDocRef(docFirstDb, 'items/alpha');
    const afterDocReferenceCreation = captureOutcome(
      () => subject.connectEmulator(docFirstDb, 'localhost', 8080, { ssl: false }),
      subject.isFirebaseError,
    );

    const jwtTokenDb = freshDb('jwt-str');
    const mockUserTokenString = captureOutcome(
      () =>
        subject.connectEmulator(jwtTokenDb, '127.0.0.1', 8080, {
          mockUserToken: 'custom-jwt-token',
        }),
      subject.isFirebaseError,
    );

    const subTokenDb = freshDb('sub-obj');
    const mockUserTokenSubObject = captureOutcome(
      () =>
        subject.connectEmulator(subTokenDb, '127.0.0.1', 8080, {
          mockUserToken: { sub: 'user-alpha', role: 'member' },
        }),
      subject.isFirebaseError,
    );

    const userIdTokenDb = freshDb('uid-obj');
    const mockUserTokenUserIdObject = captureOutcome(
      () =>
        subject.connectEmulator(userIdTokenDb, '127.0.0.1', 8080, {
          mockUserToken: { user_id: 'user-beta', tier: 'standard' },
        }),
      subject.isFirebaseError,
    );

    const emptyTokenDb = freshDb('empty-obj');
    const mockUserTokenEmptyObject = captureOutcome(
      () =>
        subject.connectEmulator(emptyTokenDb, '127.0.0.1', 8080, {
          mockUserToken: {},
        }),
      subject.isFirebaseError,
    );

    const startedDb = freshDb('started');
    await subject.disableNetwork(startedDb);
    const afterClientStarted = captureOutcome(
      () => subject.connectEmulator(startedDb, '127.0.0.1', 8080),
      subject.isFirebaseError,
    );

    return {
      basicHostPort,
      repeatBeforeStart,
      afterDocReferenceCreation,
      mockUserTokenString,
      mockUserTokenSubObject,
      mockUserTokenUserIdObject,
      mockUserTokenEmptyObject,
      afterClientStarted,
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
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase/firestore connectFirestoreEmulator(db, host, port, options) offline host/port configuration before client start and after doc(), mockUserToken string/{sub}/{user_id} acceptance vs empty-object Error rejection, and failed-precondition rejection after Firestore has started.',
  async observe(): Promise<Record<string, unknown>> {
    const [appMod, fsMod] = await Promise.all([
      import('firebase/app'),
      import('firebase/firestore'),
    ]);

    return observeFirestoreConnectEmulatorOptions({
      createApp(name: string) {
        return appMod.initializeApp({ projectId: 'demo-emulator-probe' }, name);
      },
      deleteApp(app) {
        return appMod.deleteApp(app);
      },
      getFirestore(app) {
        return fsMod.getFirestore(app);
      },
      createDocRef(db, path: string) {
        return fsMod.doc(db, path);
      },
      disableNetwork(db) {
        return fsMod.disableNetwork(db);
      },
      terminate(db) {
        return fsMod.terminate(db);
      },
      connectEmulator(db, host: string, port: number, options?: Record<string, unknown>) {
        fsMod.connectFirestoreEmulator(
          db,
          host,
          port,
          options as Parameters<typeof fsMod.connectFirestoreEmulator>[3],
        );
      },
      isFirebaseError(err: unknown): boolean {
        return err instanceof appMod.FirebaseError;
      },
    });
  },
};
