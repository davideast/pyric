import { describe, expect, it } from 'bun:test';
import { deleteApp, initializeApp } from 'firebase/app';
import * as fdb from 'firebase/database';
import { initializeSandbox } from 'pyric/sandbox';
import * as pyricDb from 'pyric/database';
import {
  observeClientEmulatorContract,
  observeClientLoggingContract,
  probe,
  type ClientEmulatorHandle,
} from '../../probes/rtdb-modular/rtdb-modular-client-emulator-and-logging.ts';
import { auditProbeSessionAuthModes } from '../../src/sdk-probe-runtime.ts';
import { loadModularProbes } from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

const PROBE_NAME = 'rtdb-modular-client-emulator-and-logging';

describe('rtdb-modular-client-emulator-and-logging staged probe', () => {
  it('registers as a staged sdk-probes probe with pendingRowLink and passes auditProbeSessionAuthModes', async () => {
    expect(probe.rig).toBe('sdk-probes');
    expect(probe.requires).toEqual(['web-config', 'dedicated-rtdb']);
    expect(probe.pendingRowLink).toBe(true);
    expect(probe.rowIds).toEqual([]);
    expect(probe.matrixRow).toBe('');
    expect(auditProbeSessionAuthModes()).toEqual([]);

    const sdkProbes = await loadModularProbes('sdk-probes');
    expect(sdkProbes.map((entry) => entry.id)).toContain(PROBE_NAME);

    expectStagedUntilCaptured(PROBE_NAME, {
      rig: 'sdk-probes',
      filterFlag: '--probe',
    });
  });

  it('executes observeClientEmulatorContract offline against firebase/database and observeClientLoggingContract against harness without volatile leaks', async () => {
    let runSeq = 0;
    const emulatorActual = await observeClientEmulatorContract({
      openHandle(suffix: string): ClientEmulatorHandle {
        runSeq += 1;
        const app = initializeApp(
          {
            projectId: 'demo-client-emulator',
            databaseURL: `https://demo-client-emulator-${suffix}.firebaseio.com`,
          },
          `offline-client-emu-${Date.now()}-${runSeq}-${suffix}`,
        );
        const db = fdb.getDatabase(app);
        return {
          db,
          goOffline() {
            fdb.goOffline(db);
          },
          async deleteHandle() {
            await deleteApp(app);
          },
        };
      },
      connectDatabaseEmulator: fdb.connectDatabaseEmulator,
      ref: fdb.ref,
      refFromURL: fdb.refFromURL,
    });

    expect(emulatorActual.baselineHttpsOrigin).toEqual({
      startsWithHttps: true,
      endsWithTargetPath: true,
    });
    expect(emulatorActual.preStartBindingAndOverwrite).toEqual({
      connectReturnsUndefined: true,
      afterConnectRefUrl: 'http://127.0.0.1:9000/items/k1',
      afterConnectRefJson: 'http://127.0.0.1:9000/items/k1',
      afterConnectRootUrl: 'http://127.0.0.1:9000/',
      overwrittenBeforeStartRefUrl: 'http://127.0.0.1:9002/items/k1',
      ipv6LoopbackHost: {
        callOutcome: { threw: false, isErrorInstance: false, code: null, message: null },
        resultingUrl: 'http://[::1]:9000/items/k1',
      },
    });
    expect(emulatorActual.mockUserTokenOptions.userIdTokenBinding).toEqual({
      callOutcome: { threw: false, isErrorInstance: false, code: null, message: null },
      resultingUrl: 'http://127.0.0.1:9000/items/k1',
    });
    expect(emulatorActual.mockUserTokenOptions.emptyMockTokenThrow).toEqual({
      threw: true,
      isErrorInstance: true,
      code: null,
      message: "mockUserToken must contain 'sub' or 'user_id' field!",
    });
    expect(emulatorActual.mockUserTokenOptions.sameMockTokenRepeatAfterStart.threw).toBe(false);
    expect(emulatorActual.mockUserTokenOptions.differentMockTokenAfterStart).toEqual({
      threw: true,
      isErrorInstance: true,
      code: null,
      message:
        'FIREBASE FATAL ERROR: connectDatabaseEmulator() cannot initialize or alter the emulator configuration after the database instance has started. ',
    });
    expect(emulatorActual.lifecycleAndPostStartGuards.callOnDeletedDatabase).toEqual({
      threw: true,
      isErrorInstance: true,
      code: null,
      message: 'FIREBASE FATAL ERROR: Cannot call useEmulator on a deleted database. ',
    });

    // Harness logging check using simulated callback sink:
    const sandbox = initializeSandbox({ projectId: 'demo-logging' });
    const sandboxDb = pyricDb.getDatabase(sandbox);
    pyricDb.sandbox.setDefaultPolicy(sandboxDb, 'allow');
    let activeSink: ((message: string) => void) | null = null;
    const emitIfActive = (msg: string) => {
      if (activeSink !== null) {
        activeSink(msg);
      }
    };

    const loggingActual = await observeClientLoggingContract({
      db: sandboxDb as unknown as fdb.Database,
      basePath: '/pyric_oracle/offline_logging_run',
      enableLogging(logger?: boolean | ((message: string) => void), persistent?: boolean) {
        if (typeof logger === 'function') {
          if (persistent === true) {
            throw new Error("Can't turn on custom loggers persistently.");
          }
          activeSink = logger;
          return;
        }
        if (logger === false) {
          activeSink = null;
        }
      },
      ref: pyricDb.ref as unknown as typeof fdb.ref,
      async get(r) {
        emitIfActive('0: get');
        return (await pyricDb.get(r as unknown as pyricDb.DatabaseReference)) as unknown as fdb.DataSnapshot;
      },
      async set(r, val) {
        emitIfActive('0: set');
        await pyricDb.set(r as unknown as pyricDb.DatabaseReference, val as pyricDb.JsonValue);
      },
      onValue(q, cb) {
        emitIfActive('0: onValue');
        return pyricDb.onValue(
          q as unknown as pyricDb.Query,
          (snap) => cb(snap as unknown as fdb.DataSnapshot),
        );
      },
      async runTransaction(r, update) {
        emitIfActive('0: transaction');
        return (await pyricDb.runTransaction(
          r as unknown as pyricDb.DatabaseReference,
          update as unknown as Parameters<typeof pyricDb.runTransaction>[1],
        )) as unknown as fdb.TransactionResult;
      },
    });

    expect(loggingActual).toEqual({
      callbackToggleReturnsUndefined: true,
      customLoggerPersistentThrow: {
        threw: true,
        isErrorInstance: true,
        mentionsCantTurnOnPersistently: true,
      },
      booleanEnableReturnsUndefined: true,
      booleanDisableReturnsUndefined: true,
      disableReturnsUndefined: true,
      readVal: { count: 1 },
      listenerValues: [{ count: 1 }, { count: 2 }],
      transactionCommitted: true,
      transactionVal: 5,
      receivedCallbackLogs: true,
      allCallbackLogsNonEmptyStrings: true,
      afterDisableReadVal: { quiet: true },
      logsEmittedAfterDisable: 0,
    });

    const serialized = JSON.stringify({ logging: loggingActual, emulator: emulatorActual });
    expect(serialized.includes('offline_logging_run')).toBe(false);
    expect(serialized.includes('demo-client-emulator')).toBe(false);
  });
});
