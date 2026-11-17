import { expect, it } from 'bun:test';
import {
  get as adminGet,
  getAdminDatabase,
  limitToFirst,
  limitToLast,
  orderByKey,
  query,
  ref as adminRef,
  set as adminSet,
} from 'pyric/database';
import * as client from '../../../../src/serve/worker/index.js';
import { setDatabaseRules } from '../../../../src/serve/worker/host/rules.js';
import { connectClientToHost, makeHostCtx } from '../integration-support.js';
import { load, restoreSharedWorker } from './support.ts';

restoreSharedWorker();

interface LiveQueryReadOutcome {
  status: 'ok' | 'error' | 'timeout';
  keys: string[] | null;
  val: unknown;
  errorCode: string | null;
  errorMessage: string | null;
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

function extractServedKeysAndVal(snap: Awaited<ReturnType<typeof client.rtdbGet>>): {
  keys: string[];
  val: unknown;
} {
  const keys: string[] = [];
  snap.forEach((child) => {
    if (child.key !== null) {
      keys.push(child.key);
    }
    return false;
  });
  return { keys, val: snap.val() };
}

async function runBoundedServedGet(
  q: Parameters<typeof client.rtdbGet>[0],
  timeoutMs = 40,
): Promise<{ status: 'ok' | 'error' | 'timeout'; keys: string[] | null; val: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timed = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const settled = await Promise.race([client.rtdbGet(q), timed]);
    if (settled === null) {
      return { status: 'timeout', keys: null, val: null };
    }
    const summary = extractServedKeysAndVal(settled);
    return { status: 'ok', keys: summary.keys, val: summary.val };
  } catch {
    return { status: 'error', keys: null, val: null };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function runBoundedServedOnValue(
  q: Parameters<typeof client.rtdbOnValue>[0],
  timeoutMs = 40,
): Promise<{
  status: 'ok' | 'error' | 'timeout';
  keys: string[] | null;
  val: unknown;
  errorCode: string | null;
}> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    return await new Promise((resolve) => {
      timer = setTimeout(() => {
        resolve({ status: 'timeout', keys: null, val: null, errorCode: null });
      }, timeoutMs);
      unsubscribe = client.rtdbOnValue(
        q,
        (snap) => {
          const summary = extractServedKeysAndVal(snap);
          resolve({ status: 'ok', keys: summary.keys, val: summary.val, errorCode: null });
        },
        (err) => {
          const code = (err as { code?: unknown }).code;
          let errorCode: string | null = null;
          if (typeof code === 'string') {
            errorCode = code;
          }
          resolve({
            status: 'error',
            keys: null,
            val: null,
            errorCode,
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

it('rtdb-modular-query-limit-infinity, served', async () => {
  const production = load('rtdb-modular-query-limit-infinity') as {
    live: Record<string, { get: LiveQueryReadOutcome; onValue: LiveQueryReadOutcome }>;
  };

  const ctx = await makeHostCtx();
  setDatabaseRules(ctx, undefined, { rules: { pyric_oracle: { $run: RUN_RULES } } });
  const adminDb = getAdminDatabase(ctx.sandbox);
  const runPath = '/pyric_oracle/replay';
  const seeded = { a: 1, b: 2, c: 3 };
  for (const bucket of [
    'permissive',
    'firstNonNull',
    'firstAtMostTwo',
    'lastNonNull',
    'lastAtMostTwo',
  ]) {
    await adminSet(adminRef(adminDb, `${runPath}/${bucket}/items`), seeded);
  }
  expect((await adminGet(adminRef(adminDb, `${runPath}/permissive/items`))).val()).toEqual(seeded);

  let seq = 0;
  const openAuthedClient = async (label: string) => {
    seq += 1;
    const connected = connectClientToHost(ctx, `worker://limit-inf-${label}-${seq}`);
    const auth = client.getAuth(connected.db);
    await client.signInAnonymously(auth);
    return client.rtdbGetDatabase(connected.db);
  };

  const evalServedCase = async (
    label: string,
    subpath: string,
    buildQuery: (baseRef: ReturnType<typeof client.rtdbRef>) => Parameters<typeof client.rtdbGet>[0],
  ) => {
    const db = await openAuthedClient(label);
    const baseRef = client.rtdbRef(db, `${runPath}/${subpath}`);
    const getRes = await runBoundedServedGet(buildQuery(baseRef));
    const listenRes = await runBoundedServedOnValue(
      buildQuery(baseRef) as Parameters<typeof client.rtdbOnValue>[0],
    );
    return { get: getRes, onValue: listenRes };
  };

  const servedLive = {
    permissiveLimitFirstInfinity: await evalServedCase('perm-f-inf', 'permissive/items', (r) =>
      query(r as never, orderByKey(), limitToFirst(Infinity)) as never,
    ),
    permissiveLimitLastInfinity: await evalServedCase('perm-l-inf', 'permissive/items', (r) =>
      query(r as never, orderByKey(), limitToLast(Infinity)) as never,
    ),
    rulesFirstNonNullControlTwo: await evalServedCase('fn-ctrl', 'firstNonNull/items', (r) =>
      query(r as never, orderByKey(), limitToFirst(2)) as never,
    ),
    rulesFirstNonNullInfinity: await evalServedCase('fn-inf', 'firstNonNull/items', (r) =>
      query(r as never, orderByKey(), limitToFirst(Infinity)) as never,
    ),
    rulesFirstAtMostTwoControlTwo: await evalServedCase('fb-ctrl', 'firstAtMostTwo/items', (r) =>
      query(r as never, orderByKey(), limitToFirst(2)) as never,
    ),
    rulesFirstAtMostTwoNegativeControlThree: await evalServedCase(
      'fb-neg3',
      'firstAtMostTwo/items',
      (r) => query(r as never, orderByKey(), limitToFirst(3)) as never,
    ),
    rulesFirstAtMostTwoInfinity: await evalServedCase('fb-inf', 'firstAtMostTwo/items', (r) =>
      query(r as never, orderByKey(), limitToFirst(Infinity)) as never,
    ),
    rulesLastNonNullControlTwo: await evalServedCase('ln-ctrl', 'lastNonNull/items', (r) =>
      query(r as never, orderByKey(), limitToLast(2)) as never,
    ),
    rulesLastNonNullInfinity: await evalServedCase('ln-inf', 'lastNonNull/items', (r) =>
      query(r as never, orderByKey(), limitToLast(Infinity)) as never,
    ),
    rulesLastAtMostTwoControlTwo: await evalServedCase('lb-ctrl', 'lastAtMostTwo/items', (r) =>
      query(r as never, orderByKey(), limitToLast(2)) as never,
    ),
    rulesLastAtMostTwoNegativeControlThree: await evalServedCase(
      'lb-neg3',
      'lastAtMostTwo/items',
      (r) => query(r as never, orderByKey(), limitToLast(3)) as never,
    ),
    rulesLastAtMostTwoInfinity: await evalServedCase('lb-inf', 'lastAtMostTwo/items', (r) =>
      query(r as never, orderByKey(), limitToLast(Infinity)) as never,
    ),
  };

  for (const [subcaseName, expected] of Object.entries(production.live)) {
    const actual = servedLive[subcaseName as keyof typeof servedLive];
    expect(actual.get).toEqual({
      status: expected.get.status,
      keys: expected.get.keys,
      val: expected.get.val,
    });
    expect(actual.onValue.status).toBe(expected.onValue.status);
    expect(actual.onValue.keys).toEqual(expected.onValue.keys);
    expect(actual.onValue.val).toEqual(expected.onValue.val);
    expect(actual.onValue.errorCode).toBe(expected.onValue.errorCode);
  }

  // Also ensure an unanswered Infinity get on a port does NOT stall subsequent finite reads on that same port.
  const sharedPortDb = await openAuthedClient('shared-port');
  const sharedBaseRef = client.rtdbRef(sharedPortDb, `${runPath}/permissive/items`);
  const infTimedOut = await runBoundedServedGet(
    query(sharedBaseRef as never, orderByKey(), limitToFirst(Infinity)) as never,
  );
  expect(infTimedOut.status).toBe('timeout');
  const finiteAfterInf = await runBoundedServedGet(
    query(sharedBaseRef as never, orderByKey(), limitToFirst(2)) as never,
  );
  expect(finiteAfterInf).toEqual({
    status: 'ok',
    keys: ['a', 'b'],
    val: { a: 1, b: 2 },
  });
});
