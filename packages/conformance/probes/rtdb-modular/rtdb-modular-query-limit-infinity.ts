import type { DataSnapshot, Query } from 'firebase/database';
import type { Probe } from '../../rigs/types.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

export interface ClientConstraintValidationOutcome {
  threw: boolean;
  errorMessage: string | null;
}

export async function probeClientLimitValidation(): Promise<{
  limitToFirstInfinity: ClientConstraintValidationOutcome;
  limitToLastInfinity: ClientConstraintValidationOutcome;
  limitToFirstNegativeInfinity: ClientConstraintValidationOutcome;
  limitToFirstNaN: ClientConstraintValidationOutcome;
  limitToFirstZero: ClientConstraintValidationOutcome;
}> {
  const [{ deleteApp, initializeApp }, { getDatabase, limitToFirst, limitToLast, orderByKey, query, ref }] =
    await Promise.all([import('firebase/app'), import('firebase/database')]);

  const app = initializeApp(
    { projectId: 'validation-only', databaseURL: 'https://validation-only-2.firebaseio.com' },
    `limit-infinity-check-${Date.now()}`,
  );
  const db = getDatabase(app);

  const check = (build: () => Query): ClientConstraintValidationOutcome => {
    try {
      build();
      return { threw: false, errorMessage: null };
    } catch (err) {
      let errorMessage = String(err);
      if (err instanceof Error) {
        errorMessage = err.message;
      }
      return { threw: true, errorMessage };
    }
  };

  try {
    return {
      limitToFirstInfinity: check(() => query(ref(db, 'items'), orderByKey(), limitToFirst(Infinity))),
      limitToLastInfinity: check(() => query(ref(db, 'items'), orderByKey(), limitToLast(Infinity))),
      limitToFirstNegativeInfinity: check(() =>
        query(ref(db, 'items'), orderByKey(), limitToFirst(-Infinity)),
      ),
      limitToFirstNaN: check(() => query(ref(db, 'items'), orderByKey(), limitToFirst(Number.NaN))),
      limitToFirstZero: check(() => query(ref(db, 'items'), orderByKey(), limitToFirst(0))),
    };
  } finally {
    await deleteApp(app);
  }
}

interface LiveQueryReadOutcome {
  status: 'ok' | 'error' | 'timeout';
  keys: string[] | null;
  val: unknown;
  errorCode: string | null;
  errorMessage: string | null;
}

function extractSnapshotSummary(snap: DataSnapshot): { keys: string[]; val: unknown } {
  const keys: string[] = [];
  snap.forEach((child) => {
    if (child.key !== null) {
      keys.push(child.key);
    }
    return false;
  });
  return { keys, val: snap.val() };
}

export function scrubOracleRunPath(message: string): string {
  return message.replace(/\/pyric_oracle\/rtdb_[a-z0-9_]+\//g, '/pyric_oracle/<runId>/');
}

function classifyError(err: unknown): { errorCode: string | null; errorMessage: string } {
  const code = (err as { code?: unknown }).code;
  let errorCode: string | null = null;
  if (typeof code === 'string') {
    errorCode = code;
  }
  let errorMessage = String(err);
  if (err instanceof Error) {
    errorMessage = err.message;
  }
  return { errorCode, errorMessage: scrubOracleRunPath(errorMessage) };
}

async function runBoundedGet(
  getFn: (q: Query) => Promise<DataSnapshot>,
  q: Query,
  timeoutMs = 6_000,
): Promise<LiveQueryReadOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timed = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const settled = await Promise.race([getFn(q), timed]);
    if (settled === null) {
      return { status: 'timeout', keys: null, val: null, errorCode: null, errorMessage: null };
    }
    const summary = extractSnapshotSummary(settled);
    return {
      status: 'ok',
      keys: summary.keys,
      val: summary.val,
      errorCode: null,
      errorMessage: null,
    };
  } catch (err) {
    const info = classifyError(err);
    return {
      status: 'error',
      keys: null,
      val: null,
      errorCode: info.errorCode,
      errorMessage: info.errorMessage,
    };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function runBoundedOnValueOnce(
  onValueFn: typeof import('firebase/database').onValue,
  q: Query,
  timeoutMs = 6_000,
): Promise<LiveQueryReadOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    return await new Promise<LiveQueryReadOutcome>((resolve) => {
      timer = setTimeout(() => {
        resolve({ status: 'timeout', keys: null, val: null, errorCode: null, errorMessage: null });
      }, timeoutMs);
      unsubscribe = onValueFn(
        q,
        (snap) => {
          const summary = extractSnapshotSummary(snap);
          resolve({
            status: 'ok',
            keys: summary.keys,
            val: summary.val,
            errorCode: null,
            errorMessage: null,
          });
        },
        (err) => {
          const info = classifyError(err);
          resolve({
            status: 'error',
            keys: null,
            val: null,
            errorCode: info.errorCode,
            errorMessage: info.errorMessage,
          });
        },
      );
    });
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (unsubscribe !== undefined) {
      unsubscribe();
    }
  }
}

const RUN_RULES: Record<string, unknown> = {
  permissive: {
    items: {
      '.read': 'auth != null',
      '.write': 'auth != null',
    },
  },
  firstNonNull: {
    items: {
      '.read': 'auth != null && query.orderByKey && query.limitToFirst != null',
      '.write': 'auth != null',
    },
  },
  firstAtMostTwo: {
    items: {
      '.read': 'auth != null && query.orderByKey && query.limitToFirst <= 2',
      '.write': 'auth != null',
    },
  },
  lastNonNull: {
    items: {
      '.read': 'auth != null && query.orderByKey && query.limitToLast != null',
      '.write': 'auth != null',
    },
  },
  lastAtMostTwo: {
    items: {
      '.read': 'auth != null && query.orderByKey && query.limitToLast <= 2',
      '.write': 'auth != null',
    },
  },
};

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  matrixRow: 'rtdb-modular#query-limit-infinity',
  rowIds: ['rtdb-modular#query-limit-infinity'],
  description:
    'RTDB modular client get()/onValue() and query.limitToFirst / query.limitToLast rules evaluation for limitToFirst(Infinity) and limitToLast(Infinity).',
  async observe() {
    const clientValidation = await probeClientLimitValidation();
    const live = await withRtdbProbeSession(
      { runRules: RUN_RULES },
      async ({ runPath, rtdbSdk, openClient, adminWrite }) => {
        const { get, goOffline, limitToFirst, limitToLast, onValue, orderByKey, query, ref } =
          rtdbSdk;
        const seeded = { a: 1, b: 2, c: 3 };
        for (const bucket of [
          'permissive',
          'firstNonNull',
          'firstAtMostTwo',
          'lastNonNull',
          'lastAtMostTwo',
        ]) {
          await adminWrite(`${bucket}/items`, seeded);
        }

        const evalCase = async (
          label: string,
          subpath: string,
          makeQuery: (baseRef: ReturnType<typeof ref>) => Query,
        ): Promise<{ get: LiveQueryReadOutcome; onValue: LiveQueryReadOutcome }> => {
          const getClient = await openClient(`${label}-get`);
          let getRes: LiveQueryReadOutcome;
          try {
            getRes = await runBoundedGet(
              get,
              makeQuery(ref(getClient.db, `${runPath}/${subpath}`)),
            );
          } finally {
            goOffline(getClient.db);
          }
          const listenClient = await openClient(`${label}-listen`);
          let listenRes: LiveQueryReadOutcome;
          try {
            listenRes = await runBoundedOnValueOnce(
              onValue,
              makeQuery(ref(listenClient.db, `${runPath}/${subpath}`)),
            );
          } finally {
            goOffline(listenClient.db);
          }
          return { get: getRes, onValue: listenRes };
        };

        return {
          permissiveLimitFirstInfinity: await evalCase('perm-f-inf', 'permissive/items', (r) =>
            query(r, orderByKey(), limitToFirst(Infinity)),
          ),
          permissiveLimitLastInfinity: await evalCase('perm-l-inf', 'permissive/items', (r) =>
            query(r, orderByKey(), limitToLast(Infinity)),
          ),
          rulesFirstNonNullControlTwo: await evalCase('fn-ctrl', 'firstNonNull/items', (r) =>
            query(r, orderByKey(), limitToFirst(2)),
          ),
          rulesFirstNonNullInfinity: await evalCase('fn-inf', 'firstNonNull/items', (r) =>
            query(r, orderByKey(), limitToFirst(Infinity)),
          ),
          rulesFirstAtMostTwoControlTwo: await evalCase('fb-ctrl', 'firstAtMostTwo/items', (r) =>
            query(r, orderByKey(), limitToFirst(2)),
          ),
          rulesFirstAtMostTwoNegativeControlThree: await evalCase(
            'fb-neg3',
            'firstAtMostTwo/items',
            (r) => query(r, orderByKey(), limitToFirst(3)),
          ),
          rulesFirstAtMostTwoInfinity: await evalCase('fb-inf', 'firstAtMostTwo/items', (r) =>
            query(r, orderByKey(), limitToFirst(Infinity)),
          ),
          rulesLastNonNullControlTwo: await evalCase('ln-ctrl', 'lastNonNull/items', (r) =>
            query(r, orderByKey(), limitToLast(2)),
          ),
          rulesLastNonNullInfinity: await evalCase('ln-inf', 'lastNonNull/items', (r) =>
            query(r, orderByKey(), limitToLast(Infinity)),
          ),
          rulesLastAtMostTwoControlTwo: await evalCase('lb-ctrl', 'lastAtMostTwo/items', (r) =>
            query(r, orderByKey(), limitToLast(2)),
          ),
          rulesLastAtMostTwoNegativeControlThree: await evalCase(
            'lb-neg3',
            'lastAtMostTwo/items',
            (r) => query(r, orderByKey(), limitToLast(3)),
          ),
          rulesLastAtMostTwoInfinity: await evalCase('lb-inf', 'lastAtMostTwo/items', (r) =>
            query(r, orderByKey(), limitToLast(Infinity)),
          ),
        };
      },
    );

    return {
      clientValidation,
      live,
    };
  },
};
