import { describe, expect, it } from 'bun:test';
import {
  get,
  getAdminDatabase,
  getDatabase,
  goOffline,
  limitToFirst,
  limitToLast,
  off,
  onChildAdded,
  onValue,
  orderByKey,
  query,
  ref,
  set,
  type DataSnapshot,
  type Database,
  type Query,
} from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/database';
import { obs } from './capture-replay.ts';

const row = (id: string, assertion: () => unknown | Promise<unknown>) => it(`rtdb-modular#${id}`, assertion);

interface ClientConstraintValidationOutcome {
  threw: boolean;
  errorMessage: string | null;
}

interface LiveQueryReadOutcome {
  status: 'ok' | 'error' | 'timeout';
  keys: string[] | null;
  val: unknown;
  errorCode: string | null;
  errorMessage: string | null;
}

interface NormalizedReadOutcome {
  status: 'ok' | 'error' | 'timeout';
  keys: string[] | null;
  val: unknown;
}

function checkClientConstraint(build: () => Query): ClientConstraintValidationOutcome {
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
  return { errorCode, errorMessage };
}

async function runBoundedGet(q: Query, timeoutMs = 25): Promise<LiveQueryReadOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timed = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const settled = await Promise.race([get(q), timed]);
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

async function runBoundedOnValueOnce(q: Query, timeoutMs = 25): Promise<LiveQueryReadOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    return await new Promise<LiveQueryReadOutcome>((resolve) => {
      timer = setTimeout(() => {
        resolve({ status: 'timeout', keys: null, val: null, errorCode: null, errorMessage: null });
      }, timeoutMs);
      unsubscribe = onValue(
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

function normalizeReadOutcome(outcome: LiveQueryReadOutcome): NormalizedReadOutcome {
  return {
    status: outcome.status,
    keys: outcome.keys,
    val: outcome.val,
  };
}

function normalizeLiveSubcases(
  subcases: Record<string, { get: LiveQueryReadOutcome; onValue: LiveQueryReadOutcome }>,
): Record<string, { get: NormalizedReadOutcome; onValue: NormalizedReadOutcome }> {
  const out: Record<string, { get: NormalizedReadOutcome; onValue: NormalizedReadOutcome }> = {};
  for (const [key, pair] of Object.entries(subcases)) {
    out[key] = {
      get: normalizeReadOutcome(pair.get),
      onValue: normalizeReadOutcome(pair.onValue),
    };
  }
  return out;
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

describe('SDK probes: RTDB limitToFirst(Infinity) and limitToLast(Infinity)', () => {
  row('query-limit-infinity', async () => {
    const production = obs('rtdb-modular-query-limit-infinity') as {
      clientValidation: Record<string, ClientConstraintValidationOutcome>;
      live: Record<string, { get: LiveQueryReadOutcome; onValue: LiveQueryReadOutcome }>;
    };

    const validationSandbox = initializeSandbox();
    const validationDb = getDatabase(validationSandbox);
    const clientValidation = {
      limitToFirstInfinity: checkClientConstraint(() =>
        query(ref(validationDb, 'items'), orderByKey(), limitToFirst(Infinity)),
      ),
      limitToLastInfinity: checkClientConstraint(() =>
        query(ref(validationDb, 'items'), orderByKey(), limitToLast(Infinity)),
      ),
      limitToFirstNegativeInfinity: checkClientConstraint(() =>
        query(ref(validationDb, 'items'), orderByKey(), limitToFirst(-Infinity)),
      ),
      limitToFirstNaN: checkClientConstraint(() =>
        query(ref(validationDb, 'items'), orderByKey(), limitToFirst(Number.NaN)),
      ),
      limitToFirstZero: checkClientConstraint(() =>
        query(ref(validationDb, 'items'), orderByKey(), limitToFirst(0)),
      ),
    };
    expect(clientValidation).toEqual(production.clientValidation);

    const sandbox = initializeSandbox();
    setRules(sandbox, { rules: { pyric_oracle: { $run: RUN_RULES } } });
    const adminDb = getAdminDatabase(sandbox);
    const runPath = '/pyric_oracle/replay';
    const seeded = { a: 1, b: 2, c: 3 };
    for (const bucket of [
      'permissive',
      'firstNonNull',
      'firstAtMostTwo',
      'lastNonNull',
      'lastAtMostTwo',
    ]) {
      await set(ref(adminDb, `${runPath}/${bucket}/items`), seeded);
    }

    let clientSeq = 0;
    const openClient = (label: string): Database => {
      clientSeq += 1;
      return getDatabase(sandbox.withAuth({ uid: `${label}-${clientSeq}` }));
    };

    const evalCase = async (
      label: string,
      subpath: string,
      makeQuery: (baseRef: ReturnType<typeof ref>) => Query,
    ): Promise<{ get: LiveQueryReadOutcome; onValue: LiveQueryReadOutcome }> => {
      const getDb = openClient(`${label}-get`);
      let getRes: LiveQueryReadOutcome;
      try {
        getRes = await runBoundedGet(makeQuery(ref(getDb, `${runPath}/${subpath}`)));
      } finally {
        goOffline(getDb);
      }
      const listenDb = openClient(`${label}-listen`);
      let listenRes: LiveQueryReadOutcome;
      try {
        listenRes = await runBoundedOnValueOnce(makeQuery(ref(listenDb, `${runPath}/${subpath}`)));
      } finally {
        goOffline(listenDb);
      }
      return { get: getRes, onValue: listenRes };
    };

    const pyricLive = {
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

    expect(normalizeLiveSubcases(pyricLive)).toEqual(normalizeLiveSubcases(production.live));

    // Verify negative controls carry PERMISSION_DENIED on onValue cancel callbacks.
    for (const negKey of [
      'rulesFirstAtMostTwoNegativeControlThree',
      'rulesLastAtMostTwoNegativeControlThree',
    ] as const) {
      expect(pyricLive[negKey].onValue.errorCode).toBe(production.live[negKey].onValue.errorCode);
      expect(pyricLive[negKey].onValue.errorMessage).toMatch(
        /^permission_denied at \/pyric_oracle\/replay\/.*: Client doesn't have permission to access the desired data\.$/,
      );
    }

    // Verify child listeners with Infinity limit also remain inert across subsequent writes and detach cleanly.
    const childDb = openClient('child-inf');
    const childQuery = query(ref(childDb, `${runPath}/permissive/items`), orderByKey(), limitToFirst(Infinity));
    const deliveredChildKeys: string[] = [];
    const childErrors: unknown[] = [];
    const unsubChild = onChildAdded(
      childQuery,
      (snap) => {
        if (snap.key !== null) {
          deliveredChildKeys.push(snap.key);
        }
      },
      (err) => {
        childErrors.push(err);
      },
    );
    await set(ref(adminDb, `${runPath}/permissive/items/d`), 4);
    expect(deliveredChildKeys).toEqual([]);
    expect(childErrors).toEqual([]);
    unsubChild();
    off(childQuery);
    goOffline(childDb);
  });
});
