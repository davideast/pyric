import type {
  DataSnapshot as AdminDataSnapshot,
  Database as AdminDatabase,
} from 'firebase-admin/database';
import type { Probe } from '../../rigs/types.ts';
import { RTDB_RULES_SCOPE } from '../../src/oracle-access-token.ts';
import { loadOracleServiceAccount, oracleAccessToken } from '../../src/oracle-credential.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

interface AdminSyncThrowShape {
  timing: 'synchronous-throw' | 'returned';
  isErrorInstance: boolean;
  name: string | null;
  message: string | null;
}

interface AdminRulesRejectionShape {
  rejected: boolean;
  isErrorInstance: boolean;
  name: string | null;
  code: string | null;
  hasExpectedMessagePrefix: boolean;
}

interface AdminTxCommitOrAbortShape {
  resultCommitted: boolean;
  resultVal: unknown;
  callbackInvoked: boolean;
  callbackErrorIsNull: boolean;
  callbackCommitted: boolean | null;
  callbackVal: unknown;
  persistedVal: unknown;
}

export type AdminTransactionRulesLoggingObservation = {
  transaction: {
    commitAndOnComplete: AdminTxCommitOrAbortShape;
    abortUndefinedAndDefensiveClone: AdminTxCommitOrAbortShape & { spuriousListenerFires: number };
    priorityAndIncrement: {
      resultCommitted: boolean;
      resultVal: unknown;
      resultPriority: string | number | null;
      exportVal: unknown;
    };
    twoClientContention: { bothCommitted: boolean; finalVal: unknown };
    syncValidation: {
      nonFunctionUpdate: AdminSyncThrowShape;
      nonFunctionOnComplete: AdminSyncThrowShape;
      nonBooleanApplyLocally: AdminSyncThrowShape;
      undefinedPropertyThrowsSync: {
        timing: 'synchronous-throw' | 'returned';
        isErrorInstance: boolean;
        name: string | null;
        mentionsUndefinedBadProp: boolean;
      };
    };
  };
  rulesManagement: {
    setObjectSource: { rawIsString: boolean; jsonProbeMarker: unknown };
    setCommentedStringSource: {
      rawPreservesComment: boolean;
      jsonProbeMarker: unknown;
      jsonExcludesCommentText: boolean;
    };
    setBufferSource: { rawPreservesBufferComment: boolean; jsonProbeMarker: unknown };
    invalidArguments: Record<
      'nullSource' | 'undefinedSource' | 'emptyStringSource' | 'numberSource' | 'arraySource',
      AdminRulesRejectionShape
    >;
    serverRejectionsPreservePriorRules: {
      malformedJson: AdminRulesRejectionShape;
      invalidExpression: AdminRulesRejectionShape;
      priorBufferRulesStillIntact: boolean;
    };
  };
  logging: Record<
    | 'enableCallbackReturnUndefined'
    | 'disableReturnUndefined'
    | 'callbackInvokedWhileEnabled'
    | 'allMessagesNonEmptyStrings'
    | 'silentAfterDisable',
    boolean
  >;
};

export interface AdminTxRulesLoggingSubject {
  db1: Pick<AdminDatabase, 'ref' | 'getRules' | 'getRulesJSON' | 'setRules'>;
  db2: Pick<AdminDatabase, 'ref'>;
  basePath: string;
  serverIncrement(delta: number): object;
  enableLogging(logger?: boolean | ((message: string) => void), persistent?: boolean): unknown;
  triggerLoggingActivity(): Promise<void>;
  buildScopedRuleset(probeMarkerNode: Record<string, unknown>): Record<string, unknown>;
  extractProbeMarker(rulesJson: unknown): unknown;
}

function extractAdminError(err: unknown): {
  isErrorInstance: boolean;
  name: string;
  code: string | null;
  message: string;
} {
  let isErrorInstance = false;
  let name: string = typeof err;
  let message = String(err);
  if (err instanceof Error) {
    isErrorInstance = true;
    name = err.name;
    message = err.message;
  }
  let code: string | null = null;
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const rawCode = (err as { code?: unknown }).code;
    if (typeof rawCode === 'string') {
      code = rawCode;
    }
  }
  return { isErrorInstance, name, code, message };
}

function captureSyncValidation(invoke: () => unknown): AdminSyncThrowShape {
  try {
    const res = invoke();
    if (res !== null && typeof res === 'object' && 'catch' in res) {
      const maybePromise = res as { catch?: (cb: () => void) => unknown };
      if (typeof maybePromise.catch === 'function') {
        maybePromise.catch(() => undefined);
      }
    }
    return { timing: 'returned', isErrorInstance: false, name: null, message: null };
  } catch (err) {
    const extracted = extractAdminError(err);
    return {
      timing: 'synchronous-throw',
      isErrorInstance: extracted.isErrorInstance,
      name: extracted.name,
      message: extracted.message,
    };
  }
}

async function captureRulesRejection(
  invoke: () => Promise<unknown>,
  expectedMessagePrefix: string,
): Promise<AdminRulesRejectionShape> {
  try {
    await invoke();
    return {
      rejected: false,
      isErrorInstance: false,
      name: null,
      code: null,
      hasExpectedMessagePrefix: false,
    };
  } catch (err) {
    const extracted = extractAdminError(err);
    return {
      rejected: true,
      isErrorInstance: extracted.isErrorInstance,
      name: extracted.name,
      code: extracted.code,
      hasExpectedMessagePrefix: extracted.message.startsWith(expectedMessagePrefix),
    };
  }
}

function waitForAdminValue(
  targetRef: ReturnType<AdminDatabase['ref']>,
  predicate: (snap: AdminDataSnapshot) => boolean,
  label: string,
  timeoutMs = 10_000,
): { ready: Promise<void>; detach(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let listener: ((snap: AdminDataSnapshot) => void) | undefined;
  const detach = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (listener !== undefined) {
      targetRef.off('value', listener);
      listener = undefined;
    }
  };
  const ready = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => {
      detach();
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);
    listener = (snap: AdminDataSnapshot) => {
      if (predicate(snap)) {
        detach();
        resolve();
      }
    };
    targetRef.on('value', listener, (err: Error) => {
      detach();
      reject(err);
    });
  });
  return { ready, detach };
}

export async function observeAdminTransactionRulesAndLogging(
  subject: AdminTxRulesLoggingSubject,
): Promise<AdminTransactionRulesLoggingObservation> {
  const { db1, db2 } = subject;
  const cleanBase = subject.basePath.replace(/^\/+|\/+$/g, '');
  let scope = 'adminTxRules';
  if (cleanBase.length > 0) {
    scope = `${cleanBase}/adminTxRules`;
  }

  const scopeRef = db1.ref(scope);
  await db1.ref(`${scope}/seed`).set({ ready: true });
  const warmSub = waitForAdminValue(
    scopeRef,
    (snap) => snap.child('seed/ready').val() === true,
    'warm scope subscription',
  );
  let keepScopeListener: ((snap: AdminDataSnapshot) => void) | undefined;

  try {
    await warmSub.ready;
    keepScopeListener = () => undefined;
    scopeRef.on('value', keepScopeListener);

    // 1a. Happy-path commit + onComplete callback
    const commitRef = db1.ref(`${scope}/txCommit`);
    await commitRef.set({ count: 10 });
    let commitCbInvoked = false;
    let commitCbErr: Error | null = new Error('uninitialized');
    let commitCbCommitted: boolean | null = null;
    let commitCbVal: unknown = null;

    const commitRes = await commitRef.transaction(
      (current: unknown) => {
        if (current !== null && typeof current === 'object') {
          const prev = (current as { count?: unknown }).count;
          if (typeof prev === 'number') {
            return { count: prev + 5 };
          }
        }
        return { count: 5 };
      },
      (err, committed, snap) => {
        commitCbInvoked = true;
        commitCbErr = err;
        commitCbCommitted = committed;
        if (snap) {
          commitCbVal = snap.val();
        }
      },
    );
    const commitPersisted = (await commitRef.get()).val();

    // 1b. Returning undefined aborts without listener fan-out and deep-clones current
    const abortRef = db1.ref(`${scope}/txAbort`);
    await abortRef.set({ nested: { keep: 7 } });
    let abortListenerFires = 0;
    const abortListener = () => {
      abortListenerFires += 1;
    };
    abortRef.on('value', abortListener);
    const firesBeforeAbort = abortListenerFires;

    let abortCbInvoked = false;
    let abortCbErr: Error | null = new Error('uninitialized');
    let abortCbCommitted: boolean | null = null;
    let abortCbVal: unknown = null;

    let abortRes: { committed: boolean; snapshot: AdminDataSnapshot };
    try {
      abortRes = await abortRef.transaction(
        (current: unknown) => {
          if (current !== null && typeof current === 'object' && 'nested' in current) {
            const nested = (current as { nested?: { keep?: number } }).nested;
            if (nested && typeof nested === 'object') {
              nested.keep = 999;
            }
          }
          return undefined;
        },
        (err, committed, snap) => {
          abortCbInvoked = true;
          abortCbErr = err;
          abortCbCommitted = committed;
          if (snap) {
            abortCbVal = snap.val();
          }
        },
      );
    } finally {
      abortRef.off('value', abortListener);
    }
    const spuriousListenerFires = abortListenerFires - firesBeforeAbort;
    const abortPersisted = (await abortRef.get()).val();

    // 1c. Inline .priority and ServerValue.increment inside transaction
    const prioRef = db1.ref(`${scope}/txPrio`);
    await prioRef.setWithPriority({ score: 20 }, 'rank-a');
    const prioRes = await prioRef.transaction((current: unknown) => {
      if (current === null) {
        return current;
      }
      return { score: subject.serverIncrement(5), '.priority': 'rank-b' };
    });
    const prioAfterSnap = await prioRef.get();

    // 1d. Concurrent two-client contention (db1 vs independent db2)
    const contendRef1 = db1.ref(`${scope}/txContend`);
    const contendRef2 = db2.ref(`${scope}/txContend`);
    await contendRef1.set(0);
    const [c1, c2] = await Promise.all([
      contendRef1.transaction((cur: unknown) => {
        if (typeof cur === 'number') {
          return cur + 1;
        }
        return 1;
      }),
      contendRef2.transaction((cur: unknown) => {
        if (typeof cur === 'number') {
          return cur + 10;
        }
        return 10;
      }),
    ]);
    const contendFinalVal = (await contendRef1.get()).val();

    // 1e. Synchronous validation throws (scrubbing any runId path prefix)
    const validRef = db1.ref(`${scope}/txValidate`);
    const nonFunctionUpdate = captureSyncValidation(() => validRef.transaction(null as never));
    const nonFunctionOnComplete = captureSyncValidation(() =>
      validRef.transaction((x: unknown) => x, 'not-a-fn' as never),
    );
    const nonBooleanApplyLocally = captureSyncValidation(() =>
      validRef.transaction((x: unknown) => x, undefined, 'not-a-bool' as never),
    );
    let undefTiming: 'synchronous-throw' | 'returned' = 'returned';
    let undefIsError = false;
    let undefName: string | null = null;
    let mentionsUndefinedBadProp = false;
    try {
      void validRef.transaction(() => ({ badProp: undefined }));
    } catch (err) {
      const extracted = extractAdminError(err);
      undefTiming = 'synchronous-throw';
      undefIsError = extracted.isErrorInstance;
      undefName = extracted.name;
      mentionsUndefinedBadProp =
        extracted.message.includes('undefined in property')
        && extracted.message.endsWith('.badProp');
    }

    // 2. Database#getRules(), getRulesJSON(), setRules(source)
    const objRules = subject.buildScopedRuleset({
      '.read': 'auth != null',
      '.indexOn': ['byObj'],
    });
    await db1.setRules(objRules);
    const rawAfterObj = await db1.getRules();
    const jsonAfterObj = await db1.getRulesJSON();

    const strRulesObj = subject.buildScopedRuleset({
      '.read': 'auth != null',
      '.indexOn': ['byStr'],
    });
    await db1.setRules(`/* pyric-admin-string-comment */\n${JSON.stringify(strRulesObj, null, 2)}`);
    const rawAfterStr = await db1.getRules();
    const jsonAfterStr = await db1.getRulesJSON();

    const bufRulesObj = subject.buildScopedRuleset({
      '.read': 'auth != null',
      '.indexOn': ['byBuf'],
    });
    await db1.setRules(
      Buffer.from(`/* pyric-admin-buffer-comment */\n${JSON.stringify(bufRulesObj, null, 2)}`, 'utf8'),
    );
    const rawAfterBuf = await db1.getRules();
    const jsonAfterBuf = await db1.getRulesJSON();

    const invalidArgPrefix = 'Source must be a non-empty string, Buffer or an object.';
    const nullSource = await captureRulesRejection(() => db1.setRules(null as never), invalidArgPrefix);
    const undefinedSource = await captureRulesRejection(
      () => db1.setRules(undefined as never),
      invalidArgPrefix,
    );
    const emptyStringSource = await captureRulesRejection(() => db1.setRules(''), invalidArgPrefix);
    const numberSource = await captureRulesRejection(() => db1.setRules(123 as never), invalidArgPrefix);
    const arraySource = await captureRulesRejection(() => db1.setRules([] as never), invalidArgPrefix);

    const serverErrPrefix = 'Error while accessing security rules:';
    const malformedJson = await captureRulesRejection(
      () => db1.setRules('{ malformed json'),
      serverErrPrefix,
    );
    const invalidExprObj = subject.buildScopedRuleset({ '.read': 'unknownRuleFunction()' });
    const invalidExpression = await captureRulesRejection(
      () => db1.setRules(invalidExprObj),
      serverErrPrefix,
    );
    const jsonAfterRejections = await db1.getRulesJSON();

    // 3. enableLogging(logger?, persistent?)
    const capturedLogs: unknown[] = [];
    let enableRet: unknown;
    let disableRet: unknown;
    try {
      enableRet = subject.enableLogging((msg: string) => {
        capturedLogs.push(msg);
      });
      await subject.triggerLoggingActivity();
    } finally {
      disableRet = subject.enableLogging(false);
    }
    const countAfterDisable = capturedLogs.length;
    await subject.triggerLoggingActivity();
    const countAfterSecondActivity = capturedLogs.length;

    const bufferMarker = { '.read': 'auth != null', '.indexOn': ['byBuf'] };
    return {
      transaction: {
        commitAndOnComplete: {
          resultCommitted: commitRes.committed,
          resultVal: commitRes.snapshot.val(),
          callbackInvoked: commitCbInvoked,
          callbackErrorIsNull: commitCbErr === null,
          callbackCommitted: commitCbCommitted,
          callbackVal: commitCbVal,
          persistedVal: commitPersisted,
        },
        abortUndefinedAndDefensiveClone: {
          resultCommitted: abortRes.committed,
          resultVal: abortRes.snapshot.val(),
          callbackInvoked: abortCbInvoked,
          callbackErrorIsNull: abortCbErr === null,
          callbackCommitted: abortCbCommitted,
          callbackVal: abortCbVal,
          persistedVal: abortPersisted,
          spuriousListenerFires,
        },
        priorityAndIncrement: {
          resultCommitted: prioRes.committed,
          resultVal: prioRes.snapshot.val(),
          resultPriority: prioRes.snapshot.getPriority(),
          exportVal: prioAfterSnap.exportVal(),
        },
        twoClientContention: { bothCommitted: c1.committed && c2.committed, finalVal: contendFinalVal },
        syncValidation: {
          nonFunctionUpdate,
          nonFunctionOnComplete,
          nonBooleanApplyLocally,
          undefinedPropertyThrowsSync: {
            timing: undefTiming,
            isErrorInstance: undefIsError,
            name: undefName,
            mentionsUndefinedBadProp,
          },
        },
      },
      rulesManagement: {
        setObjectSource: {
          rawIsString: typeof rawAfterObj === 'string' && rawAfterObj.length > 0,
          jsonProbeMarker: subject.extractProbeMarker(jsonAfterObj),
        },
        setCommentedStringSource: {
          rawPreservesComment: rawAfterStr.includes('/* pyric-admin-string-comment */'),
          jsonProbeMarker: subject.extractProbeMarker(jsonAfterStr),
          jsonExcludesCommentText: !JSON.stringify(jsonAfterStr).includes('pyric-admin-string-comment'),
        },
        setBufferSource: {
          rawPreservesBufferComment: rawAfterBuf.includes('/* pyric-admin-buffer-comment */'),
          jsonProbeMarker: subject.extractProbeMarker(jsonAfterBuf),
        },
        invalidArguments: { nullSource, undefinedSource, emptyStringSource, numberSource, arraySource },
        serverRejectionsPreservePriorRules: {
          malformedJson,
          invalidExpression,
          priorBufferRulesStillIntact:
            JSON.stringify(subject.extractProbeMarker(jsonAfterRejections)) === JSON.stringify(bufferMarker),
        },
      },
      logging: {
        enableCallbackReturnUndefined: enableRet === undefined,
        disableReturnUndefined: disableRet === undefined,
        callbackInvokedWhileEnabled: countAfterDisable > 0,
        allMessagesNonEmptyStrings:
          countAfterDisable > 0
          && capturedLogs.every((entry) => typeof entry === 'string' && entry.length > 0),
        silentAfterDisable: countAfterSecondActivity === countAfterDisable,
      },
    };
  } finally {
    warmSub.detach();
    if (keepScopeListener !== undefined) {
      scopeRef.off('value', keepScopeListener);
    }
  }
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase-admin/database Reference.transaction, Database.getRules/getRulesJSON/setRules, and enableLogging: observes commit/abort/onComplete/defensive-clone/priority/increment/contention/validation transactions, string/object/Buffer rules round-trips with comment preservation and invalid-source rejections, and custom callback logging toggle.',
  observe() {
    return withRtdbProbeSession({}, async ({ runId, runPath, databaseUrl }) => {
      const [adminAppMod, { ServerValue, enableLogging, getDatabaseWithUrl }] = await Promise.all([
        import('firebase-admin/app'),
        import('firebase-admin/database'),
      ]);
      const sa = await loadOracleServiceAccount();
      const makeCredential = () => ({
        getAccessToken: async () => ({
          access_token: await oracleAccessToken(sa, RTDB_RULES_SCOPE),
          expires_in: 3600,
        }),
      });
      const app1 = adminAppMod.initializeApp(
        { credential: makeCredential(), projectId: sa.project_id, databaseURL: databaseUrl },
        `sdk-probe-rtdb-admin-tx1-${runId}`,
      );
      const app2 = adminAppMod.initializeApp(
        { credential: makeCredential(), projectId: sa.project_id, databaseURL: databaseUrl },
        `sdk-probe-rtdb-admin-tx2-${runId}`,
      );
      const db1 = getDatabaseWithUrl(databaseUrl, app1);
      const db2 = getDatabaseWithUrl(databaseUrl, app2);
      let logSeq = 0;

      try {
        const sessionRulesRaw = await db1.getRules();
        const baselineRules = (await db1.getRulesJSON()) as {
          rules?: Record<string, unknown>;
        };
        const baseRulesNode = baselineRules.rules ?? {};
        const existingPyricOracle =
          (baseRulesNode.pyric_oracle as Record<string, unknown> | undefined) ?? {};
        const existingRunNode =
          (existingPyricOracle[runId] as Record<string, unknown> | undefined) ?? {
            '.read': 'auth != null',
            '.write': 'auth != null',
          };

        try {
          return await observeAdminTransactionRulesAndLogging({
            db1,
            db2,
            basePath: runPath,
            serverIncrement: (delta) => ServerValue.increment(delta),
            enableLogging,
            async triggerLoggingActivity() {
              logSeq += 1;
              await db1.ref(`${runPath}/logPing/${logSeq}`).set(logSeq);
            },
            buildScopedRuleset(probeMarkerNode) {
              return {
                rules: {
                  ...baseRulesNode,
                  pyric_oracle: {
                    ...existingPyricOracle,
                    [runId]: {
                      ...existingRunNode,
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
              return root.rules?.pyric_oracle?.[runId]?.adminSetRulesProbe ?? null;
            },
          });
        } finally {
          await db1.setRules(sessionRulesRaw).catch(() => undefined);
        }
      } finally {
        enableLogging(false);
        db1.goOffline();
        db2.goOffline();
        await Promise.all([
          adminAppMod.deleteApp(app1).catch(() => undefined),
          adminAppMod.deleteApp(app2).catch(() => undefined),
        ]);
      }
    });
  },
};
