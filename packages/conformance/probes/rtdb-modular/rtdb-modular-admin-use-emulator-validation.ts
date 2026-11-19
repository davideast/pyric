import type { App as AdminApp } from 'firebase-admin/app';
import type { Database as AdminDatabase } from 'firebase-admin/database';
import type { Probe } from '../../rigs/types.ts';

export interface AdminUseEmulatorThrowSummary {
  threw: boolean;
  isErrorInstance: boolean;
  code: string | null;
  message: string | null;
}

export interface AdminUseEmulatorBoundaryCase {
  callOutcome: AdminUseEmulatorThrowSummary;
  resultingRefUrl: string | null;
}

export interface AdminUseEmulatorSdk {
  createApp(options: { projectId: string; databaseURL: string }, label: string): AdminApp;
  getDatabase(app: AdminApp): AdminDatabase;
  deleteApp(app: AdminApp): Promise<void>;
}

function captureUseEmulatorCall(invoke: () => unknown): AdminUseEmulatorThrowSummary {
  try {
    invoke();
    return {
      threw: false,
      isErrorInstance: false,
      code: null,
      message: null,
    };
  } catch (err) {
    const rawCode = (err as { code?: unknown }).code;
    let code: string | null = null;
    if (typeof rawCode === 'string') {
      code = rawCode;
    }
    return {
      threw: true,
      isErrorInstance: err instanceof Error,
      code,
      message: (err as Error).message,
    };
  }
}

export async function observeAdminUseEmulatorContract(sdk: AdminUseEmulatorSdk): Promise<{
  preStartBindingAndOverwrite: {
    baselineHttpsRefUrl: string;
    afterUseEmulatorRefUrl: string;
    afterUseEmulatorRefJson: string;
    afterUseEmulatorRootUrl: string;
    overwrittenBeforeStartRefUrl: string;
  };
  refFromUrlAfterUseEmulator: {
    matchingEmulatorOriginUrl: string;
    originalNamespaceHttpsUrl: string;
    differentNamespaceHttpsUrl: string;
  };
  argumentBoundaryBehavior: {
    emptyHost: AdminUseEmulatorBoundaryCase;
    schemePrefixedHost: AdminUseEmulatorBoundaryCase;
    ipv6LoopbackHost: AdminUseEmulatorBoundaryCase;
    zeroPort: AdminUseEmulatorBoundaryCase;
    negativePort: AdminUseEmulatorBoundaryCase;
    nanPort: AdminUseEmulatorBoundaryCase;
  };
  lifecycleAndPostStartGuards: {
    sameHostPortRepeatAfterRef: AdminUseEmulatorThrowSummary;
    differentPortAfterRef: AdminUseEmulatorThrowSummary;
    differentHostAfterRef: AdminUseEmulatorThrowSummary;
    firstCallAfterRef: AdminUseEmulatorThrowSummary;
    firstCallAfterGoOffline: AdminUseEmulatorThrowSummary;
    mockUserTokenOptionOnAdmin: AdminUseEmulatorThrowSummary;
    callOnDeletedDatabase: AdminUseEmulatorThrowSummary;
  };
}> {
  const openedApps: AdminApp[] = [];
  const openedDbs: AdminDatabase[] = [];

  const openDb = (suffix: string): { app: AdminApp; db: AdminDatabase } => {
    const app = sdk.createApp(
      {
        projectId: 'demo-admin-emulator',
        databaseURL: `https://demo-admin-emulator-${suffix}.firebaseio.com`,
      },
      suffix,
    );
    openedApps.push(app);
    const db = sdk.getDatabase(app);
    openedDbs.push(db);
    return { app, db };
  };

  const observeBoundaryCase = (
    suffix: string,
    host: string,
    port: number,
  ): AdminUseEmulatorBoundaryCase => {
    const handle = openDb(suffix);
    const callOutcome = captureUseEmulatorCall(() => handle.db.useEmulator(host, port));
    handle.db.goOffline();
    let resultingRefUrl: string | null = null;
    if (!callOutcome.threw) {
      resultingRefUrl = handle.db.ref('items/k1').toString();
    }
    return { callOutcome, resultingRefUrl };
  };

  try {
    const baseline = openDb('base');
    baseline.db.goOffline();
    const baselineHttpsRefUrl = baseline.db.ref('items/k1').toString();

    const pre = openDb('pre');
    pre.db.useEmulator('127.0.0.1', 9000);
    pre.db.goOffline();
    const afterUseEmulatorRef = pre.db.ref('items/k1');
    const afterUseEmulatorRefUrl = afterUseEmulatorRef.toString();
    const afterUseEmulatorRefJson = String(afterUseEmulatorRef.toJSON());
    const afterUseEmulatorRootUrl = pre.db.ref().toString();

    const matchingEmulatorOriginUrl = pre.db
      .refFromURL('http://127.0.0.1:9000/orders/o1')
      .toString();
    const originalNamespaceHttpsUrl = pre.db
      .refFromURL('https://demo-admin-emulator-pre.firebaseio.com/orders/o2')
      .toString();
    const differentNamespaceHttpsUrl = pre.db
      .refFromURL('https://other-emulator-ns.firebaseio.com/orders/o3')
      .toString();

    const sameHostPortRepeatAfterRef = captureUseEmulatorCall(() =>
      pre.db.useEmulator('127.0.0.1', 9000),
    );
    const differentPortAfterRef = captureUseEmulatorCall(() =>
      pre.db.useEmulator('127.0.0.1', 9001),
    );
    const differentHostAfterRef = captureUseEmulatorCall(() =>
      pre.db.useEmulator('localhost', 9000),
    );

    const overwrite = openDb('overwrite');
    overwrite.db.useEmulator('127.0.0.1', 9000);
    overwrite.db.useEmulator('localhost', 9005);
    overwrite.db.goOffline();
    const overwrittenBeforeStartRefUrl = overwrite.db.ref('items/k1').toString();

    const emptyHost = observeBoundaryCase('boundary-empty-host', '', 9000);
    const schemePrefixedHost = observeBoundaryCase(
      'boundary-scheme-host',
      'http://127.0.0.1',
      9000,
    );
    const ipv6LoopbackHost = observeBoundaryCase('boundary-ipv6-host', '::1', 9000);
    const zeroPort = observeBoundaryCase('boundary-zero-port', '127.0.0.1', 0);
    const negativePort = observeBoundaryCase('boundary-neg-port', '127.0.0.1', -1);
    const nanPort = observeBoundaryCase('boundary-nan-port', '127.0.0.1', Number.NaN);

    const startedByRef = openDb('after-ref');
    startedByRef.db.ref('items/k1');
    startedByRef.db.goOffline();
    const firstCallAfterRef = captureUseEmulatorCall(() =>
      startedByRef.db.useEmulator('127.0.0.1', 9000),
    );

    const startedByOffline = openDb('after-offline');
    startedByOffline.db.goOffline();
    const firstCallAfterGoOffline = captureUseEmulatorCall(() =>
      startedByOffline.db.useEmulator('127.0.0.1', 9000),
    );

    const mockToken = openDb('mock-token');
    const useEmulatorWithOptions = mockToken.db.useEmulator as unknown as (
      host: string,
      port: number,
      options?: { mockUserToken?: string },
    ) => void;
    const mockUserTokenOptionOnAdmin = captureUseEmulatorCall(() =>
      useEmulatorWithOptions.call(mockToken.db, '127.0.0.1', 9000, {
        mockUserToken: 'sub-1',
      }),
    );
    mockToken.db.goOffline();

    const deletedApp = sdk.createApp(
      {
        projectId: 'demo-admin-emulator',
        databaseURL: 'https://demo-admin-emulator-deleted.firebaseio.com',
      },
      'deleted',
    );
    const deletedDb = sdk.getDatabase(deletedApp);
    await sdk.deleteApp(deletedApp);
    const callOnDeletedDatabase = captureUseEmulatorCall(() =>
      deletedDb.useEmulator('127.0.0.1', 9000),
    );

    return {
      preStartBindingAndOverwrite: {
        baselineHttpsRefUrl,
        afterUseEmulatorRefUrl,
        afterUseEmulatorRefJson,
        afterUseEmulatorRootUrl,
        overwrittenBeforeStartRefUrl,
      },
      refFromUrlAfterUseEmulator: {
        matchingEmulatorOriginUrl,
        originalNamespaceHttpsUrl,
        differentNamespaceHttpsUrl,
      },
      argumentBoundaryBehavior: {
        emptyHost,
        schemePrefixedHost,
        ipv6LoopbackHost,
        zeroPort,
        negativePort,
        nanPort,
      },
      lifecycleAndPostStartGuards: {
        sameHostPortRepeatAfterRef,
        differentPortAfterRef,
        differentHostAfterRef,
        firstCallAfterRef,
        firstCallAfterGoOffline,
        mockUserTokenOptionOnAdmin,
        callOnDeletedDatabase,
      },
    };
  } finally {
    for (const db of openedDbs) {
      try {
        db.goOffline();
      } catch {
        // Ignore already-deleted handles during cleanup.
      }
    }
    for (const app of openedApps) {
      await sdk.deleteApp(app).catch(() => undefined);
    }
  }
}

let offlineRunCounter = 0;

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: [],
  matrixRow: 'rtdb-admin#9',
  rowIds: ['rtdb-admin#9'],
  description:
    'Pure offline firebase-admin/database Database#useEmulator(host, port) contract: pre-start HTTP host:port URL rebinding and overwrite, refFromURL custom-host resolution, host/port boundary interpolation, idempotent same-endpoint repeat after start, and fatal errors on post-start initialization/alteration, mockUserToken, and deleted databases.',
  async observe() {
    const [adminAppMod, adminDbMod] = await Promise.all([
      import('firebase-admin/app'),
      import('firebase-admin/database'),
    ]);
    offlineRunCounter += 1;
    const runSeq = offlineRunCounter;

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = Object.assign(
      async () => {
        fetchCalls += 1;
        throw new Error('Unexpected outbound fetch in offline admin useEmulator probe');
      },
      { preconnect: originalFetch.preconnect },
    );

    try {
      const contract = await observeAdminUseEmulatorContract({
        createApp(options, label) {
          return adminAppMod.initializeApp(options, `admin-use-emulator-${runSeq}-${label}`);
        },
        getDatabase(app) {
          return adminDbMod.getDatabase(app);
        },
        deleteApp(app) {
          return adminAppMod.deleteApp(app);
        },
      });
      return {
        fetchCalls,
        ...contract,
      };
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
};
