import { describe, expect, it } from 'bun:test';
import {
  observeAdminTransactionRulesAndLogging,
  probe as adminTxRulesLoggingProbe,
  type AdminTransactionRulesLoggingObservation,
  type AdminTxRulesLoggingSubject,
} from '../../probes/rtdb-modular/rtdb-modular-admin-transaction-rules-and-logging.ts';
import { auditProbeSessionAuthModes } from '../../src/sdk-probe-runtime.ts';
import { loadModularProbes } from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

const PROBE_NAME = 'rtdb-modular-admin-transaction-rules-and-logging';

describe('rtdb-modular-admin-transaction-rules-and-logging staged probe', () => {
  it('registers as a staged sdk-probes probe and passes auditProbeSessionAuthModes and expectStagedUntilCaptured', async () => {
    expect(adminTxRulesLoggingProbe.rig).toBe('sdk-probes');
    expect(adminTxRulesLoggingProbe.pendingRowLink).toBe(true);
    expect(adminTxRulesLoggingProbe.matrixRow).toBe('');
    expect(adminTxRulesLoggingProbe.rowIds).toEqual([]);
    expect(adminTxRulesLoggingProbe.requires).toEqual(['web-config', 'dedicated-rtdb']);
    expect(auditProbeSessionAuthModes()).toEqual([]);

    const sdkProbes = await loadModularProbes('sdk-probes');
    expect(sdkProbes.map((entry) => entry.id)).toContain(PROBE_NAME);

    expectStagedUntilCaptured(PROBE_NAME, {
      rig: 'sdk-probes',
      filterFlag: '--probe',
    });
  });

  it('executes observeAdminTransactionRulesAndLogging offline against firebase-admin validation and pyric sandbox harness without volatile leaks', async () => {
    const [adminAppMod, { ServerValue, enableLogging, getDatabase }] = await Promise.all([
      import('firebase-admin/app'),
      import('firebase-admin/database'),
    ]);
    const {
      get: modGet,
      getAdminDatabase,
      increment,
      onValue,
      ref: modRef,
      runTransaction,
      sandbox: rtdbSandbox,
      set: modSet,
      setWithPriority: modSetWithPriority,
    } = await import('pyric/database');
    const { initializeSandbox } = await import('pyric/sandbox');

    const sandbox = initializeSandbox();
    const offlineApp = adminAppMod.initializeApp(
      {
        projectId: 'probe-unit-project',
        databaseURL: 'https://probe-unit-project-default-rtdb.firebaseio.com',
      },
      `probe-unit-admin-${Math.random()}`,
    );
    const offlineDb = getDatabase(offlineApp);
    offlineDb.goOffline();

    try {
      const pyricAdmin = getAdminDatabase(sandbox);
      let rawRulesText = JSON.stringify({ rules: { '.read': true, '.write': true } });
      let parsedRulesObj: Record<string, unknown> = { rules: { '.read': true, '.write': true } };
      let activeLogger: ((msg: string) => void) | null = null;

      function stripBlockComments(src: string): string {
        return src.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      }

      function makeServerRulesError(detail: string): Error {
        const wrapped = new Error(`Error while accessing security rules: ${detail}`);
        Object.assign(wrapped, { code: 'database/internal-error' });
        return wrapped;
      }

      function makeRefAdapter(path: string) {
        const clean = path.replace(/^\/+|\/+$/g, '');
        const target = modRef(pyricAdmin, clean);
        const listeners = new Map<unknown, () => void>();

        return {
          async set(val: unknown) {
            await modSet(target, val);
          },
          async setWithPriority(val: unknown, prio: string | number | null) {
            await modSetWithPriority(target, val, prio);
          },
          async get() {
            const snap = await modGet(target);
            return {
              val: () => snap.val(),
              exportVal: () => snap.exportVal(),
              getPriority: () => snap.priority,
              child: (sub: string) => ({ val: () => snap.child(sub).val() }),
            };
          },
          on(_event: string, cb: (snap: unknown) => void) {
            const unsub = onValue(target, (snap) => {
              cb({
                val: () => snap.val(),
                exportVal: () => snap.exportVal(),
                getPriority: () => snap.priority,
                child: (sub: string) => ({ val: () => snap.child(sub).val() }),
              });
            });
            listeners.set(cb, unsub);
            return cb;
          },
          off(_event?: string, cb?: unknown) {
            if (cb !== undefined) {
              const unsub = listeners.get(cb);
              if (unsub !== undefined) {
                unsub();
                listeners.delete(cb);
              }
            }
          },
          transaction(
            updateFn: (cur: unknown) => unknown,
            onComplete?: (err: Error | null, committed: boolean, snap: unknown) => void,
            applyLocally?: boolean,
          ) {
            if (
              typeof updateFn !== 'function'
              || (onComplete !== undefined && typeof onComplete !== 'function')
              || (applyLocally !== undefined && typeof applyLocally !== 'boolean')
            ) {
              return offlineDb.ref(clean).transaction(updateFn, onComplete as never, applyLocally);
            }
            const probeVal = updateFn({});
            if (
              probeVal !== null
              && typeof probeVal === 'object'
              && Object.values(probeVal as Record<string, unknown>).some((v) => v === undefined)
            ) {
              return offlineDb.ref(clean).transaction(updateFn, onComplete as never, applyLocally);
            }
            return runTransaction(target, (cur) => updateFn(cur)).then(async (res) => {
              const fullSnap = await modGet(target);
              const adaptedSnap = {
                val: () => res.snapshot.val(),
                exportVal: () => fullSnap.exportVal(),
                getPriority: () => fullSnap.priority,
              };
              if (onComplete) {
                onComplete(null, res.committed, adaptedSnap);
              }
              return { committed: res.committed, snapshot: adaptedSnap };
            });
          },
        };
      }

      const dbAdapter = {
        ref: (p?: string) => makeRefAdapter(p ?? '') as never,
        async getRules() {
          return rawRulesText;
        },
        async getRulesJSON() {
          return JSON.parse(JSON.stringify(parsedRulesObj)) as object;
        },
        async setRules(source: string | object | Buffer) {
          if (
            source === null
            || source === undefined
            || source === ''
            || (typeof source !== 'string' && !Buffer.isBuffer(source) && typeof source !== 'object')
            || Array.isArray(source)
          ) {
            await offlineDb.setRules(source);
            return;
          }
          let candidateRaw: string;
          let candidateObj: Record<string, unknown>;
          try {
            if (typeof source === 'string') {
              candidateRaw = source;
              candidateObj = JSON.parse(stripBlockComments(source)) as Record<string, unknown>;
            } else if (Buffer.isBuffer(source)) {
              candidateRaw = source.toString('utf8');
              candidateObj = JSON.parse(stripBlockComments(candidateRaw)) as Record<string, unknown>;
            } else {
              candidateRaw = JSON.stringify(source, null, 2);
              candidateObj = JSON.parse(candidateRaw) as Record<string, unknown>;
            }
          } catch (err) {
            let detail = String(err);
            if (err instanceof Error) {
              detail = err.message;
            }
            throw makeServerRulesError(detail);
          }
          if (JSON.stringify(candidateObj).includes('unknownRuleFunction')) {
            throw makeServerRulesError('Unknown function unknownRuleFunction');
          }
          try {
            rtdbSandbox.setRules(
              pyricAdmin,
              candidateObj as { rules: Record<string, unknown> },
            );
          } catch (err) {
            let detail = String(err);
            if (err instanceof Error) {
              detail = err.message;
            }
            throw makeServerRulesError(detail);
          }
          rawRulesText = candidateRaw;
          parsedRulesObj = candidateObj;
        },
      };

      const runSecret = 'rtdb_unit_secret_run_999';
      const subject: AdminTxRulesLoggingSubject = {
        db1: dbAdapter as never,
        db2: { ref: (p?: string) => makeRefAdapter(p ?? '') as never },
        basePath: `/pyric_oracle/${runSecret}`,
        serverIncrement: (d) => increment(d) as unknown as ReturnType<typeof ServerValue.increment>,
        enableLogging(logger) {
          const ret = enableLogging(logger as never);
          if (typeof logger === 'function') {
            activeLogger = logger;
          } else {
            activeLogger = null;
          }
          return ret;
        },
        async triggerLoggingActivity() {
          if (activeLogger !== null) {
            activeLogger('p:0: simulated log activity');
          }
        },
        buildScopedRuleset(probeMarkerNode) {
          return {
            rules: {
              pyric_oracle: {
                [runSecret]: {
                  '.read': 'auth != null',
                  '.write': 'auth != null',
                  adminSetRulesProbe: probeMarkerNode,
                },
              },
            },
          };
        },
        extractProbeMarker(rulesJson) {
          const root = rulesJson as {
            rules?: { pyric_oracle?: Record<string, { adminSetRulesProbe?: unknown }> };
          };
          return root.rules?.pyric_oracle?.[runSecret]?.adminSetRulesProbe ?? null;
        },
      };
      const observed: AdminTransactionRulesLoggingObservation =
        await observeAdminTransactionRulesAndLogging(subject);

      const serialized = JSON.stringify(observed);
      expect(serialized).not.toContain(runSecret);
      expect(observed.transaction.commitAndOnComplete.resultCommitted).toBe(true);
      expect(observed.transaction.commitAndOnComplete.resultVal).toEqual({ count: 15 });
      expect(observed.transaction.abortUndefinedAndDefensiveClone.resultCommitted).toBe(false);
      expect(observed.transaction.abortUndefinedAndDefensiveClone.persistedVal).toEqual({
        nested: { keep: 7 },
      });
      expect(observed.transaction.priorityAndIncrement).toEqual({
        resultCommitted: true,
        resultVal: { score: 25 },
        resultPriority: 'rank-b',
        exportVal: { score: 25, '.priority': 'rank-b' },
      });
      expect(observed.transaction.twoClientContention).toEqual({
        bothCommitted: true,
        finalVal: 11,
      });
      expect(observed.rulesManagement.invalidArguments.nullSource).toEqual({
        rejected: true,
        isErrorInstance: true,
        name: 'Error',
        code: 'database/invalid-argument',
        hasExpectedMessagePrefix: true,
      });
      expect(observed.rulesManagement.invalidArguments.arraySource.code).toBe(
        'database/invalid-argument',
      );
      expect(observed.rulesManagement.setCommentedStringSource).toEqual({
        rawPreservesComment: true,
        jsonProbeMarker: { '.read': 'auth != null', '.indexOn': ['byStr'] },
        jsonExcludesCommentText: true,
      });
      expect(observed.rulesManagement.serverRejectionsPreservePriorRules).toEqual({
        malformedJson: {
          rejected: true,
          isErrorInstance: true,
          name: 'Error',
          code: 'database/internal-error',
          hasExpectedMessagePrefix: true,
        },
        invalidExpression: {
          rejected: true,
          isErrorInstance: true,
          name: 'Error',
          code: 'database/internal-error',
          hasExpectedMessagePrefix: true,
        },
        priorBufferRulesStillIntact: true,
      });
      expect(observed.logging).toEqual({
        enableCallbackReturnUndefined: true,
        disableReturnUndefined: true,
        callbackInvokedWhileEnabled: true,
        allMessagesNonEmptyStrings: true,
        silentAfterDisable: true,
      });
    } finally {
      enableLogging(false);
      await adminAppMod.deleteApp(offlineApp);
      sandbox.dispose();
    }
  });
});
