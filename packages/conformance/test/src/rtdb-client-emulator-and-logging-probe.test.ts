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

const PROBE_NAME = 'rtdb-modular-client-emulator-and-logging';

describe('rtdb-modular-client-emulator-and-logging probe', () => {
  it('registers as a linked sdk-probes probe and passes auditProbeSessionAuthModes', async () => {
    expect(probe.rig).toBe('sdk-probes');
    expect(probe.requires).toEqual(['web-config', 'dedicated-rtdb']);
    expect(probe.pendingRowLink).toBeUndefined();
    expect(probe.matrixRow).toBe('rtdb-modular#173');
    expect(probe.rowIds).toEqual([
      'rtdb-modular#173',
      'rtdb-modular#M32',
      'rtdb-modular#165',
    ]);
    expect(auditProbeSessionAuthModes()).toEqual([]);

    const sdkProbes = await loadModularProbes('sdk-probes');
    expect(sdkProbes.map((entry) => entry.id)).toContain(PROBE_NAME);
  });

  it('executes observeClientEmulatorContract offline against firebase/database and observeClientLoggingContract against pyric/database without volatile leaks', async () => {
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

    expect(emulatorActual.preStartBindingAndOverwrite.afterConnectRefUrl).toBe(
      'http://127.0.0.1:9000/items/k1',
    );
    expect(emulatorActual.preStartBindingAndOverwrite.ipv6LoopbackHost.resultingUrl).toBe(
      'http://[::1]:9000/items/k1',
    );
    expect(emulatorActual.mockUserTokenOptions.emptyMockTokenThrow.message).toBe(
      "mockUserToken must contain 'sub' or 'user_id' field!",
    );
    expect(emulatorActual.lifecycleAndPostStartGuards.callOnDeletedDatabase.message).toBe(
      'FIREBASE FATAL ERROR: Cannot call useEmulator on a deleted database. ',
    );

    const sandbox = initializeSandbox({ projectId: 'demo-logging' });
    const sandboxDb = pyricDb.getDatabase(sandbox);
    pyricDb.sandbox.setDefaultPolicy(sandboxDb, 'allow');

    const loggingActual = await observeClientLoggingContract({
      db: sandboxDb as unknown as fdb.Database,
      basePath: '/pyric_oracle/offline_logging_run',
      enableLogging: pyricDb.enableLogging,
      ref: pyricDb.ref as unknown as typeof fdb.ref,
      get: pyricDb.get as unknown as typeof fdb.get,
      set: pyricDb.set as unknown as typeof fdb.set,
      onValue: pyricDb.onValue as unknown as typeof fdb.onValue,
      runTransaction: pyricDb.runTransaction as unknown as typeof fdb.runTransaction,
    });

    expect(loggingActual.receivedCallbackLogs).toBe(true);
    expect(loggingActual.logsEmittedAfterDisable).toBe(0);
    expect(loggingActual.customLoggerPersistentThrow).toEqual({
      threw: true,
      isErrorInstance: true,
      mentionsCantTurnOnPersistently: true,
    });

    const serialized = JSON.stringify({ logging: loggingActual, emulator: emulatorActual });
    expect(serialized.includes('offline_logging_run')).toBe(false);
    expect(serialized.includes('demo-client-emulator')).toBe(false);
  });
});
