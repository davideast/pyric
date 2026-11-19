import type { Database, DataSnapshot, EmulatorMockTokenOptions } from 'firebase/database';
import type { Probe } from '../../rigs/types.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

interface ClientCallThrowSummary {
  threw: boolean;
  isErrorInstance: boolean;
  code: string | null;
  message: string | null;
}

interface ClientUrlCallOutcome {
  callOutcome: ClientCallThrowSummary;
  resultingUrl: string | null;
}

export interface ClientEmulatorHandle {
  db: Database;
  goOffline(): void;
  deleteHandle(): Promise<void>;
}

interface ClientEmulatorSdk {
  openHandle(suffix: string): ClientEmulatorHandle;
  connectDatabaseEmulator(
    db: Database,
    host: string,
    port: number,
    options?: { mockUserToken?: string | EmulatorMockTokenOptions },
  ): void;
  ref(db: Database, path?: string): { key: string | null; toString(): string; toJSON(): unknown };
  refFromURL(db: Database, url: string): { key: string | null; toString(): string };
}

interface ClientLoggingProbeSubject {
  db: Database;
  basePath: string;
  enableLogging(logger?: boolean | ((message: string) => void), persistent?: boolean): void;
  ref: typeof import('firebase/database').ref;
  get: typeof import('firebase/database').get;
  set: typeof import('firebase/database').set;
  onValue: typeof import('firebase/database').onValue;
  runTransaction: typeof import('firebase/database').runTransaction;
}

interface ClientEmulatorAndLoggingObservation {
  logging: {
    callbackToggleReturnsUndefined: boolean;
    customLoggerPersistentThrow: {
      threw: boolean;
      isErrorInstance: boolean;
      mentionsCantTurnOnPersistently: boolean;
    };
    booleanEnableReturnsUndefined: boolean;
    booleanDisableReturnsUndefined: boolean;
    disableReturnsUndefined: boolean;
    readVal: unknown;
    listenerValues: unknown[];
    transactionCommitted: boolean;
    transactionVal: unknown;
    receivedCallbackLogs: boolean;
    allCallbackLogsNonEmptyStrings: boolean;
    afterDisableReadVal: unknown;
    logsEmittedAfterDisable: number;
  };
  emulator: {
    baselineHttpsOrigin: {
      startsWithHttps: boolean;
      endsWithTargetPath: boolean;
    };
    preStartBindingAndOverwrite: {
      connectReturnsUndefined: boolean;
      afterConnectRefUrl: string;
      afterConnectRefJson: string;
      afterConnectRootUrl: string;
      overwrittenBeforeStartRefUrl: string;
      ipv6LoopbackHost: ClientUrlCallOutcome;
    };
    mockUserTokenOptions: {
      objectTokenBinding: ClientUrlCallOutcome;
      userIdTokenBinding: ClientUrlCallOutcome;
      stringTokenBinding: ClientUrlCallOutcome;
      emptyMockTokenThrow: ClientCallThrowSummary;
      sameMockTokenRepeatAfterStart: ClientCallThrowSummary;
      differentMockTokenAfterStart: ClientCallThrowSummary;
    };
    refFromUrlAfterConnectEmulator: {
      matchingEmulatorOrigin: ClientUrlCallOutcome;
      otherHttpsNamespaceOrigin: ClientUrlCallOutcome;
    };
    lifecycleAndPostStartGuards: {
      sameHostPortRepeatAfterRef: ClientCallThrowSummary;
      differentPortAfterRef: ClientCallThrowSummary;
      differentHostAfterRef: ClientCallThrowSummary;
      firstCallAfterRef: ClientCallThrowSummary;
      firstCallAfterGoOffline: ClientCallThrowSummary;
      callOnDeletedDatabase: ClientCallThrowSummary;
    };
  };
}

function captureSyncCall(invoke: () => unknown): ClientCallThrowSummary {
  try {
    invoke();
    return {
      threw: false,
      isErrorInstance: false,
      code: null,
      message: null,
    };
  } catch (err) {
    let code: string | null = null;
    if (typeof err === 'object' && err !== null && 'code' in err) {
      const rawCode = (err as { code?: unknown }).code;
      if (typeof rawCode === 'string') {
        code = rawCode;
      }
    }
    let message: string | null = String(err);
    if (err instanceof Error) {
      message = err.message;
    }
    return {
      threw: true,
      isErrorInstance: err instanceof Error,
      code,
      message,
    };
  }
}

function captureUrlCall(invoke: () => string): ClientUrlCallOutcome {
  let resultingUrl: string | null = null;
  const callOutcome = captureSyncCall(() => {
    resultingUrl = invoke();
  });
  return { callOutcome, resultingUrl };
}

async function waitForListenerCount(
  label: string,
  values: readonly unknown[],
  expectedAtLeast: number,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (values.length < expectedAtLeast) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

export async function observeClientLoggingContract(
  subject: ClientLoggingProbeSubject,
): Promise<ClientEmulatorAndLoggingObservation['logging']> {
  const { db, enableLogging, ref, get, set, onValue, runTransaction } = subject;
  const cleanBase = subject.basePath.replace(/^\/+|\/+$/g, '');
  let prefix = '';
  if (cleanBase.length > 0) {
    prefix = `${cleanBase}/`;
  }

  const callbackLogs: string[] = [];
  let unsub: (() => void) | null = null;

  try {
    const callbackResult = enableLogging((message: string) => {
      callbackLogs.push(message);
    }, false);
    const callbackToggleReturnsUndefined = callbackResult === undefined;

    const itemRef = ref(db, `${prefix}logging/item`);
    await set(itemRef, { count: 1 });
    const firstSnap: DataSnapshot = await get(itemRef);
    const readVal = firstSnap.val();

    const listenerValues: unknown[] = [];
    unsub = onValue(itemRef, (snap) => {
      listenerValues.push(snap.val());
    });
    await waitForListenerCount('initial logging listener value', listenerValues, 1);

    await set(itemRef, { count: 2 });
    await waitForListenerCount('updated logging listener value', listenerValues, 2);
    unsub();
    unsub = null;

    const txRef = ref(db, `${prefix}logging/tx-counter`);
    const txOutcome = await runTransaction(txRef, (current) => {
      if (typeof current === 'number') {
        return current + 5;
      }
      return 5;
    });

    const receivedCallbackLogs = callbackLogs.length > 0;
    const allCallbackLogsNonEmptyStrings =
      receivedCallbackLogs &&
      callbackLogs.every((entry) => typeof entry === 'string' && entry.length > 0);

    const disableResult = enableLogging(false);
    const disableReturnsUndefined = disableResult === undefined;
    const countAtDisable = callbackLogs.length;

    const quietRef = ref(db, `${prefix}logging/after-disable`);
    await set(quietRef, { quiet: true });
    const quietSnap = await get(quietRef);
    const afterDisableReadVal = quietSnap.val();
    const logsEmittedAfterDisable = callbackLogs.length - countAtDisable;

    const booleanEnableReturnsUndefined = enableLogging(true) === undefined;
    const booleanDisableReturnsUndefined = enableLogging(false) === undefined;
    const rawPersistentThrow = captureSyncCall(() =>
      enableLogging(() => {}, true),
    );
    const customLoggerPersistentThrow = {
      threw: rawPersistentThrow.threw,
      isErrorInstance: rawPersistentThrow.isErrorInstance,
      mentionsCantTurnOnPersistently: (rawPersistentThrow.message ?? '').includes(
        "Can't turn on custom loggers persistently.",
      ),
    };

    return {
      callbackToggleReturnsUndefined,
      customLoggerPersistentThrow,
      booleanEnableReturnsUndefined,
      booleanDisableReturnsUndefined,
      disableReturnsUndefined,
      readVal,
      listenerValues,
      transactionCommitted: txOutcome.committed,
      transactionVal: txOutcome.snapshot.val(),
      receivedCallbackLogs,
      allCallbackLogsNonEmptyStrings,
      afterDisableReadVal,
      logsEmittedAfterDisable,
    };
  } finally {
    if (unsub !== null) {
      unsub();
    }
    enableLogging(false);
  }
}

export async function observeClientEmulatorContract(
  sdk: ClientEmulatorSdk,
): Promise<ClientEmulatorAndLoggingObservation['emulator']> {
  const handles: Array<{ handle: ClientEmulatorHandle; deleted: boolean }> = [];

  const open = (suffix: string): { handle: ClientEmulatorHandle; deleted: boolean } => {
    const entry = { handle: sdk.openHandle(suffix), deleted: false };
    handles.push(entry);
    return entry;
  };

  try {
    const base = open('base').handle;
    base.goOffline();
    const baselineRefUrl = sdk.ref(base.db, 'items/k1').toString();
    const baselineHttpsOrigin = {
      startsWithHttps: baselineRefUrl.startsWith('https://'),
      endsWithTargetPath: baselineRefUrl.endsWith('/items/k1'),
    };

    const pre = open('pre').handle;
    const connectReturnsUndefined =
      sdk.connectDatabaseEmulator(pre.db, '127.0.0.1', 9000) === undefined;
    pre.goOffline();
    const afterConnectRef = sdk.ref(pre.db, 'items/k1');
    const afterConnectRefUrl = afterConnectRef.toString();
    const afterConnectRefJson = String(afterConnectRef.toJSON());
    const afterConnectRootUrl = sdk.ref(pre.db).toString();

    const matchingEmulatorOrigin = captureUrlCall(() =>
      sdk.refFromURL(pre.db, 'http://127.0.0.1:9000/items/k2').toString(),
    );
    const otherHttpsNamespaceOrigin = captureUrlCall(() =>
      sdk.refFromURL(pre.db, 'https://other-namespace-rtdb.firebaseio.com/items/k2').toString(),
    );

    const sameHostPortRepeatAfterRef = captureSyncCall(() =>
      sdk.connectDatabaseEmulator(pre.db, '127.0.0.1', 9000),
    );
    const differentPortAfterRef = captureSyncCall(() =>
      sdk.connectDatabaseEmulator(pre.db, '127.0.0.1', 9001),
    );
    const differentHostAfterRef = captureSyncCall(() =>
      sdk.connectDatabaseEmulator(pre.db, 'localhost', 9000),
    );

    const overwrite = open('overwrite').handle;
    sdk.connectDatabaseEmulator(overwrite.db, '127.0.0.1', 9000);
    sdk.connectDatabaseEmulator(overwrite.db, '127.0.0.1', 9002);
    overwrite.goOffline();
    const overwrittenBeforeStartRefUrl = sdk.ref(overwrite.db, 'items/k1').toString();

    const ipv6 = open('ipv6').handle;
    const ipv6LoopbackHost = captureUrlCall(() => {
      sdk.connectDatabaseEmulator(ipv6.db, '[::1]', 9000);
      ipv6.goOffline();
      return sdk.ref(ipv6.db, 'items/k1').toString();
    });

    const mockObj = open('mock-obj').handle;
    const aliceTokenOptions: { mockUserToken: EmulatorMockTokenOptions } = {
      mockUserToken: { sub: 'alice', email: 'alice@example.com' },
    };
    const objectTokenBinding = captureUrlCall(() => {
      sdk.connectDatabaseEmulator(mockObj.db, '127.0.0.1', 9000, aliceTokenOptions);
      mockObj.goOffline();
      return sdk.ref(mockObj.db, 'items/k1').toString();
    });
    const sameMockTokenRepeatAfterStart = captureSyncCall(() =>
      sdk.connectDatabaseEmulator(mockObj.db, '127.0.0.1', 9000, {
        mockUserToken: { sub: 'alice', email: 'alice@example.com' },
      }),
    );
    const differentMockTokenAfterStart = captureSyncCall(() =>
      sdk.connectDatabaseEmulator(mockObj.db, '127.0.0.1', 9000, {
        mockUserToken: { sub: 'bob', email: 'bob@example.com' },
      }),
    );

    const mockUserId = open('mock-userid').handle;
    const userIdTokenBinding = captureUrlCall(() => {
      sdk.connectDatabaseEmulator(mockUserId.db, '127.0.0.1', 9000, {
        mockUserToken: { user_id: 'bob' },
      });
      mockUserId.goOffline();
      return sdk.ref(mockUserId.db, 'items/k1').toString();
    });

    const mockEmpty = open('mock-empty').handle;
    const emptyMockTokenThrow = captureSyncCall(() =>
      sdk.connectDatabaseEmulator(mockEmpty.db, '127.0.0.1', 9000, {
        mockUserToken: {} as unknown as EmulatorMockTokenOptions,
      }),
    );
    mockEmpty.goOffline();

    const mockStr = open('mock-str').handle;
    const rawJwt = 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJhbGljZSJ9.';
    const stringTokenBinding = captureUrlCall(() => {
      sdk.connectDatabaseEmulator(mockStr.db, '127.0.0.1', 9000, { mockUserToken: rawJwt });
      mockStr.goOffline();
      return sdk.ref(mockStr.db, 'items/k1').toString();
    });

    const startedByRef = open('started-ref').handle;
    sdk.ref(startedByRef.db, 'items/k1');
    startedByRef.goOffline();
    const firstCallAfterRef = captureSyncCall(() =>
      sdk.connectDatabaseEmulator(startedByRef.db, '127.0.0.1', 9000),
    );

    const startedByOffline = open('started-offline').handle;
    startedByOffline.goOffline();
    const firstCallAfterGoOffline = captureSyncCall(() =>
      sdk.connectDatabaseEmulator(startedByOffline.db, '127.0.0.1', 9000),
    );

    const deletedEntry = open('deleted');
    deletedEntry.handle.goOffline();
    await deletedEntry.handle.deleteHandle();
    deletedEntry.deleted = true;
    const callOnDeletedDatabase = captureSyncCall(() =>
      sdk.connectDatabaseEmulator(deletedEntry.handle.db, '127.0.0.1', 9000),
    );

    return {
      baselineHttpsOrigin,
      preStartBindingAndOverwrite: {
        connectReturnsUndefined,
        afterConnectRefUrl,
        afterConnectRefJson,
        afterConnectRootUrl,
        overwrittenBeforeStartRefUrl,
        ipv6LoopbackHost,
      },
      mockUserTokenOptions: {
        objectTokenBinding,
        userIdTokenBinding,
        stringTokenBinding,
        emptyMockTokenThrow,
        sameMockTokenRepeatAfterStart,
        differentMockTokenAfterStart,
      },
      refFromUrlAfterConnectEmulator: {
        matchingEmulatorOrigin,
        otherHttpsNamespaceOrigin,
      },
      lifecycleAndPostStartGuards: {
        sameHostPortRepeatAfterRef,
        differentPortAfterRef,
        differentHostAfterRef,
        firstCallAfterRef,
        firstCallAfterGoOffline,
        callOnDeletedDatabase,
      },
    };
  } finally {
    for (const entry of handles) {
      if (!entry.deleted) {
        try {
          entry.handle.goOffline();
        } catch {
          // Already offline.
        }
        await entry.handle.deleteHandle().catch(() => undefined);
        entry.deleted = true;
      }
    }
  }
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  matrixRow: '',
  rowIds: [],
  pendingRowLink: true,
  description:
    'firebase/database modular enableLogging(logger?, persistent?) and connectDatabaseEmulator(db, host, port, options?): observes live callback log delivery across set/get/onValue/runTransaction and post-disable silence, plus pre-start HTTP emulator URL rebinding/overwrite, mockUserToken object and JWT options, custom-host refFromURL resolution, idempotent post-start repeats, and post-start or deleted-app fatal errors.',
  observe() {
    return withRtdbProbeSession({}, async ({ runId, runPath, db, rtdbSdk }) => {
      const { deleteApp, initializeApp } = await import('firebase/app');

      const logging = await observeClientLoggingContract({
        db,
        basePath: runPath,
        enableLogging: rtdbSdk.enableLogging,
        ref: rtdbSdk.ref,
        get: rtdbSdk.get,
        set: rtdbSdk.set,
        onValue: rtdbSdk.onValue,
        runTransaction: rtdbSdk.runTransaction,
      });

      const emulator = await observeClientEmulatorContract({
        openHandle(suffix: string): ClientEmulatorHandle {
          const app = initializeApp(
            {
              projectId: 'demo-client-emulator',
              databaseURL: `https://demo-client-emulator-${suffix}.firebaseio.com`,
            },
            `sdk-probe-emu-${runId}-${suffix}`,
          );
          const emuDb = rtdbSdk.getDatabase(app);
          return {
            db: emuDb,
            goOffline() {
              rtdbSdk.goOffline(emuDb);
            },
            async deleteHandle() {
              await deleteApp(app);
            },
          };
        },
        connectDatabaseEmulator: rtdbSdk.connectDatabaseEmulator,
        ref: rtdbSdk.ref,
        refFromURL: rtdbSdk.refFromURL,
      });

      return { logging, emulator };
    });
  },
};
