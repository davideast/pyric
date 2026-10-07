import {
  type Query,
  type QueryConstraint,
  get,
  limitToFirst,
  onValue,
  orderByChild,
  orderByKey,
  orderByValue,
  query,
  ref,
  startAt,
} from 'firebase/database';
import {
  adminRemove,
  adminUrl,
  captureInvocation,
  cleanup,
  createClient,
  errorShape,
  repeatStable,
  scenarioPath,
  stable,
  waitFor,
} from './probe-runtime.ts';
import type { RtdbClimbClient, RtdbClimbContext, RtdbClimbProbe } from './probe-types.ts';

type DataKind = 'child' | 'value';

interface QueryShape {
  name: string;
  data: DataKind;
  constraints: () => QueryConstraint[];
  rest: string;
}

const CHILD_SEED = { c: { pos: 3 }, a: { pos: 1 }, e: { pos: 5 }, b: { pos: 2 }, d: { pos: 4 } };
const VALUE_SEED = { alice: 30, bob: 10, carol: 50, dave: 20, eve: 40 };

const SHAPES: QueryShape[] = [
  { name: 'orderByChild-limitToFirst', data: 'child', constraints: () => [orderByChild('pos'), limitToFirst(2)], rest: 'orderBy=%22pos%22&limitToFirst=2' },
  { name: 'orderByValue-limitToFirst', data: 'value', constraints: () => [orderByValue(), limitToFirst(2)], rest: 'orderBy=%22$value%22&limitToFirst=2' },
  { name: 'orderByKey-limitToFirst', data: 'child', constraints: () => [orderByKey(), limitToFirst(2)], rest: 'orderBy=%22$key%22&limitToFirst=2' },
  { name: 'orderByChild-unlimited', data: 'child', constraints: () => [orderByChild('pos')], rest: 'orderBy=%22pos%22' },
  { name: 'orderByValue-unlimited', data: 'value', constraints: () => [orderByValue()], rest: 'orderBy=%22$value%22' },
  { name: 'orderByChild-startAt', data: 'child', constraints: () => [orderByChild('pos'), startAt(2)], rest: 'orderBy=%22pos%22&startAt=2' },
];

/** Strip the logger timestamp and the run-scoped path so repeated attempts compare equal. */
function normalizeLog(text: string, base: string): string {
  return text
    .replace(/^\[[^\]]*\]\s*/, '')
    .split(`/${base}`).join('/<base>')
    .split(base).join('<base>');
}

export function createProbe(ctx: RtdbClimbContext): RtdbClimbProbe {
  return {
    name: 'rtdb-modular-query-index-enforcement',
    matrixRow: 'rtdb-modular#M51/#144',
    rowIds: ['rtdb-modular#M51', 'rtdb-modular#144'],
    description:
      'Index enforcement for orderByChild, orderByValue and orderByKey queries, limited and unlimited, each with and without a matching `.indexOn`, through get(), onValue() and the REST API, recording rejections and client log warnings.',
    observe: () => repeatStable(2, async (attempt) => {
      const path = scenarioPath(ctx, 'query-index-enforcement', attempt);
      const run = path.split('/')[1]!;
      const rulesUrl = `${ctx.config.databaseURL}/.settings/rules.json?access_token=${encodeURIComponent(ctx.rtdbAdminToken)}`;
      const readRules = async (): Promise<Record<string, unknown>> => {
        const response = await fetch(rulesUrl);
        if (!response.ok) throw new Error(`query index rules read failed: ${response.status}`);
        return response.json() as Promise<Record<string, unknown>>;
      };
      const writeRules = async (body: Record<string, unknown>): Promise<void> => {
        const response = await fetch(`${rulesUrl}&print=silent`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`query index rules write failed: ${response.status}`);
      };
      const before = await readRules();
      const rootRules = before.rules && typeof before.rules === 'object'
        ? before.rules as Record<string, unknown>
        : {};
      const oracleRules = rootRules.pyric_oracle && typeof rootRules.pyric_oracle === 'object'
        ? rootRules.pyric_oracle as Record<string, unknown>
        : {};
      const deployed = {
        ...before,
        rules: {
          ...rootRules,
          pyric_oracle: {
            ...oracleRules,
            [run]: {
              '.read': 'auth != null',
              '.write': 'auth != null',
              'rtdb-climb': {
                'query-index-enforcement': {
                  [`attempt-${attempt}`]: {
                    indexed: {
                      child: { $q: { '.indexOn': ['pos'] } },
                      value: { $q: { '.indexOn': '.value' } },
                    },
                  },
                },
              },
            },
          },
        },
      };

      const listPath = (indexed: boolean, shape: QueryShape, method: string) =>
        `${path}/${indexed ? 'indexed' : 'unindexed'}/${shape.data}/${method}-${shape.name}`;
      const adminPut = async (target: string, value: unknown): Promise<void> => {
        const response = await fetch(adminUrl(ctx, target, '&print=silent'), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(value),
        });
        if (!response.ok) throw new Error(`query index seed failed: ${response.status}`);
      };

      const logs: string[] = [];
      const originalWarn = console.warn;
      const originalError = console.error;
      const originalLog = console.log;
      const capture = (sink: (...args: unknown[]) => void, level: string) => (...args: unknown[]) => {
        const text = args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' ');
        if (text.includes('@firebase/database')) logs.push(`${level}: ${normalizeLog(text, path)}`);
        else sink(...args);
      };

      let getClient: RtdbClimbClient | null = null;
      let listenClient: RtdbClimbClient | null = null;
      try {
        await writeRules(deployed);
        for (const indexed of [true, false]) {
          for (const shape of SHAPES) {
            for (const method of ['get', 'listen', 'rest']) {
              await adminPut(listPath(indexed, shape, method), shape.data === 'child' ? CHILD_SEED : VALUE_SEED);
            }
          }
        }
        const authProbe = await createClient(ctx, `query-index-enforcement-ready-${attempt}`);
        try {
          await waitFor('query index rules readiness', async () => {
            const response = await fetch(
              `${ctx.config.databaseURL}/${listPath(true, SHAPES[1]!, 'rest')}.json?auth=${encodeURIComponent(authProbe.authToken)}&orderBy=%22$value%22&limitToFirst=1`,
            );
            return response.ok;
          }, 30_000);
        } finally {
          await authProbe.close();
        }

        console.warn = capture(originalWarn, 'warn');
        console.error = capture(originalError, 'error');
        console.log = capture(originalLog, 'log');

        getClient = await createClient(ctx, `query-index-enforcement-get-${attempt}`);
        listenClient = await createClient(ctx, `query-index-enforcement-listen-${attempt}`);
        const results: Record<string, unknown> = {};
        for (const indexed of [true, false]) {
          for (const shape of SHAPES) {
            const key = `${indexed ? 'indexed' : 'unindexed'}:${shape.name}`;

            logs.length = 0;
            const getQuery = query(ref(getClient.db, listPath(indexed, shape, 'get')), ...shape.constraints());
            const getOutcome = await captureInvocation(async () => {
              const snapshot = await get(getQuery);
              const keys: string[] = [];
              snapshot.forEach((child) => { keys.push(child.key!); return false; });
              return { keys };
            });
            await new Promise((resolve) => setTimeout(resolve, 250));
            const getLogs = [...logs];

            logs.length = 0;
            const listenQuery: Query = query(ref(listenClient.db, listPath(indexed, shape, 'listen')), ...shape.constraints());
            let listenOutcome: Record<string, unknown> | null = null;
            const unsubscribe = onValue(
              listenQuery,
              (snapshot) => {
                if (listenOutcome) return;
                const keys: string[] = [];
                snapshot.forEach((child) => { keys.push(child.key!); return false; });
                listenOutcome = { event: 'value', keys };
              },
              (error) => { listenOutcome ??= { event: 'cancel', error: errorShape(error) }; },
            );
            await waitFor(`${key} listener outcome`, () => listenOutcome !== null);
            await new Promise((resolve) => setTimeout(resolve, 250));
            unsubscribe();
            const listenLogs = [...logs];

            const restResponse = await fetch(
              `${ctx.config.databaseURL}/${listPath(indexed, shape, 'rest')}.json?auth=${encodeURIComponent(getClient.authToken)}&${shape.rest}`,
            );
            const restBody = await restResponse.json() as unknown;
            const rest = restResponse.ok
              ? { status: restResponse.status, keys: Object.keys(restBody as Record<string, unknown>).sort() }
              : { status: restResponse.status, body: normalizeLog(stable(restBody), path) };

            results[key] = {
              get: getOutcome.timing === 'resolved'
                ? { timing: 'resolved', ...(getOutcome.value as Record<string, unknown>) }
                : { ...getOutcome, message: normalizeLog(String(getOutcome.message), path) },
              getLogs,
              listen: listenOutcome,
              listenLogs,
              rest,
            };
          }
        }
        return { results };
      } finally {
        console.warn = originalWarn;
        console.error = originalError;
        console.log = originalLog;
        await cleanup([
          async () => { await getClient?.close(); },
          async () => { await listenClient?.close(); },
          () => adminRemove(ctx, path),
          async () => {
            await writeRules(before);
            if (stable(await readRules()) !== stable(before)) {
              throw new Error('query index rules restore verification failed');
            }
          },
        ]);
      }
    }),
  };
}
