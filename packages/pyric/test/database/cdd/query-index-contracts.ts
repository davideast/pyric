/**
 * Replay of `rtdb-modular-query-index-enforcement`: each query shape, with and
 * without a matching `.indexOn`, through `get()` and `onValue()`, recording
 * the outcome and the `@firebase/database` log lines in the observation's
 * shape. The REST column has no sandbox counterpart and is not replayed.
 */
import { expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  get,
  getDatabase,
  limitToFirst,
  onValue,
  orderByChild,
  orderByKey,
  orderByValue,
  query,
  ref,
  sandbox as databaseSandbox,
  startAt,
  type QueryConstraint,
} from '../../../src/database/index.js';
import { loadObservation } from '../modular/cdd-replay-helpers.js';

const BASE = 'base';
const CHILD_SEED = { c: { pos: 3 }, a: { pos: 1 }, e: { pos: 5 }, b: { pos: 2 }, d: { pos: 4 } };
const VALUE_SEED = { alice: 30, bob: 10, carol: 50, dave: 20, eve: 40 };

const SHAPES: Array<{ name: string; data: 'child' | 'value'; constraints: () => QueryConstraint[] }> = [
  { name: 'orderByChild-limitToFirst', data: 'child', constraints: () => [orderByChild('pos'), limitToFirst(2)] },
  { name: 'orderByValue-limitToFirst', data: 'value', constraints: () => [orderByValue(), limitToFirst(2)] },
  { name: 'orderByKey-limitToFirst', data: 'child', constraints: () => [orderByKey(), limitToFirst(2)] },
  { name: 'orderByChild-unlimited', data: 'child', constraints: () => [orderByChild('pos')] },
  { name: 'orderByValue-unlimited', data: 'value', constraints: () => [orderByValue()] },
  { name: 'orderByChild-startAt', data: 'child', constraints: () => [orderByChild('pos'), startAt(2)] },
];

function normalize(text: string): string {
  return text.replace(/^\[[^\]]*\]\s*/, '').split(`/${BASE}/`).join('/<base>/');
}

/** Run every case against a sandbox whose rules mirror the oracle's deployed rules. */
export async function replayQueryIndexEnforcement(): Promise<Record<string, unknown>> {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  databaseSandbox.setRules(db, {
    rules: {
      [BASE]: {
        '.read': 'auth != null',
        '.write': 'auth != null',
        indexed: {
          child: { $q: { '.indexOn': ['pos'] } },
          value: { $q: { '.indexOn': '.value' } },
        },
      },
    },
  });
  const listPath = (indexed: boolean, data: string, method: string, shape: string) =>
    `${BASE}/${indexed ? 'indexed' : 'unindexed'}/${data}/${method}-${shape}`;
  const seed: Record<string, unknown> = {};
  for (const indexed of [true, false]) {
    for (const shape of SHAPES) {
      for (const method of ['get', 'listen']) {
        seed[listPath(indexed, shape.data, method, shape.name)] = shape.data === 'child' ? CHILD_SEED : VALUE_SEED;
      }
    }
  }
  const tree: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(seed)) {
    const segments = path.split('/');
    let node = tree;
    for (const segment of segments.slice(0, -1)) node = (node[segment] ??= {}) as Record<string, unknown>;
    node[segments.at(-1)!] = value;
  }
  databaseSandbox.setData(db, tree as never);

  const logs: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (text.includes('@firebase/database')) logs.push(`warn: ${normalize(text)}`);
    else originalWarn(...args);
  };
  const results: Record<string, unknown> = {};
  try {
    for (const indexed of [true, false]) {
      for (const shape of SHAPES) {
        logs.length = 0;
        let getOutcome: Record<string, unknown>;
        try {
          const snapshot = await get(query(ref(db, listPath(indexed, shape.data, 'get', shape.name)), ...shape.constraints()));
          const keys: string[] = [];
          snapshot.forEach((child) => { keys.push(child.key!); return false; });
          getOutcome = { timing: 'resolved', keys };
        } catch (error) {
          getOutcome = {
            timing: 'asynchronous-reject',
            name: (error as Error).name,
            code: (error as { code?: unknown }).code ?? null,
            message: normalize((error as Error).message),
          };
        }
        const getLogs = [...logs];

        logs.length = 0;
        let listen: Record<string, unknown> | null = null;
        const unsubscribe = onValue(
          query(ref(db, listPath(indexed, shape.data, 'listen', shape.name)), ...shape.constraints()),
          (snapshot) => {
            if (listen) return;
            const keys: string[] = [];
            snapshot.forEach((child) => { keys.push(child.key!); return false; });
            listen = { event: 'value', keys };
          },
          (error) => { listen ??= { event: 'cancel', message: error.message }; },
        );
        await Promise.resolve();
        unsubscribe();
        results[`${indexed ? 'indexed' : 'unindexed'}:${shape.name}`] = {
          get: getOutcome, getLogs, listen, listenLogs: [...logs],
        };
      }
    }
  } finally {
    console.warn = originalWarn;
  }
  return results;
}

/** The observation's results without the REST column. */
export function observedQueryIndexEnforcement(): Record<string, unknown> {
  const observation = loadObservation('rtdb-modular-query-index-enforcement');
  const results = observation.results as Record<string, Record<string, unknown>>;
  return Object.fromEntries(Object.entries(results).map(([key, { rest: _rest, ...sdk }]) => [key, sdk]));
}

export async function assertQueryIndexEnforcement(): Promise<void> {
  expect(await replayQueryIndexEnforcement()).toEqual(observedQueryIndexEnforcement());
}
