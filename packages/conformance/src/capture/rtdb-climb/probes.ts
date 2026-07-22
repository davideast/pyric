import { deleteApp, initializeApp, type FirebaseOptions } from 'firebase/app';
import { deleteUser, getAuth, signInAnonymously } from 'firebase/auth';
import {
  DataSnapshot,
  Database,
  QueryConstraint,
  TransactionResult,
  child,
  get,
  getDatabase,
  off,
  onValue,
  orderByKey,
  query,
  ref,
  refFromURL,
  runTransaction,
  set,
  update,
  type Database as DatabaseHandle,
} from 'firebase/database';

export interface RtdbClimbProbe {
  name: string;
  matrixRow: string;
  rowIds: string[];
  description: string;
  observe(): Promise<Record<string, unknown>>;
}

export interface RtdbClimbContext {
  config: FirebaseOptions & { projectId: string; databaseURL: string };
  rtdbAdminToken: string;
  runId: string;
}

interface Client {
  db: DatabaseHandle;
  close(): Promise<void>;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function repeatStable(
  count: number,
  run: (attempt: number) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const results: Record<string, unknown>[] = [];
  for (let attempt = 0; attempt < count; attempt++) results.push(await run(attempt));
  const first = stable(results[0]);
  if (!results.every((result) => stable(result) === first)) {
    throw new Error(`repeatability mismatch across ${count} RTDB climb attempts`);
  }
  return { repeatCount: count, ...results[0] };
}

async function createClient(ctx: RtdbClimbContext, suffix: string): Promise<Client> {
  const app = initializeApp(ctx.config, `rtdb-climb-${ctx.runId}-${suffix}`);
  const auth = getAuth(app);
  try {
    await signInAnonymously(auth);
  } catch (error) {
    await deleteApp(app).catch(() => undefined);
    throw error;
  }
  return {
    db: getDatabase(app),
    async close() {
      if (auth.currentUser) await deleteUser(auth.currentUser).catch(() => undefined);
      await deleteApp(app);
    },
  };
}

function scenarioPath(ctx: RtdbClimbContext, probe: string, attempt: number): string {
  return `pyric_oracle/${ctx.runId}/rtdb-climb/${probe}/attempt-${attempt}`;
}

function adminUrl(ctx: RtdbClimbContext, path: string, extra = ''): string {
  const normalized = path.split('/').filter(Boolean).join('/');
  return `${ctx.config.databaseURL}/${normalized}.json?access_token=${encodeURIComponent(ctx.rtdbAdminToken)}${extra}`;
}

async function adminRead(ctx: RtdbClimbContext, path: string): Promise<unknown> {
  const response = await fetch(adminUrl(ctx, path));
  if (!response.ok) throw new Error(`RTDB climb admin read failed: ${response.status}`);
  return response.json();
}

async function adminRemove(ctx: RtdbClimbContext, path: string): Promise<void> {
  const response = await fetch(adminUrl(ctx, path, '&print=silent'), { method: 'DELETE' });
  if (!response.ok) throw new Error(`RTDB climb cleanup failed: ${response.status}`);
}

async function cleanup(tasks: Array<() => Promise<void>>): Promise<void> {
  const results = await Promise.allSettled(tasks.map((task) => task()));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length === 1) throw failures[0]!.reason;
  if (failures.length > 1) {
    throw new AggregateError(failures.map((failure) => failure.reason), 'RTDB climb cleanup failed');
  }
}

function prototypeShape(value: object, constructor: Function): Record<string, unknown> {
  return {
    constructorName: value.constructor.name,
    instanceOf: value instanceof constructor,
    prototypeIsExportPrototype: Object.getPrototypeOf(value) === constructor.prototype,
    prototypeKeys: Object.getOwnPropertyNames(constructor.prototype).sort(),
  };
}

function directConstruction(constructor: new () => object): Record<string, unknown> {
  try {
    const value = new constructor();
    return {
      threw: false,
      constructorName: value.constructor.name,
      ownKeys: Object.keys(value).sort(),
    };
  } catch (error) {
    return {
      threw: true,
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function referenceStringShape(value: string, expectedPath: string): Record<string, unknown> {
  const parsed = new URL(value);
  const normalizedExpected = `/${expectedPath.split('/').filter(Boolean).join('/')}`;
  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    pathMatches: parsed.pathname.replace(/\/$/, '') === normalizedExpected.replace(/\/$/, ''),
  };
}

async function captureInvocation(task: () => unknown): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = task();
  } catch (error) {
    return {
      timing: 'synchronous-throw',
      name: error instanceof Error ? error.name : typeof error,
      code: (error as { code?: unknown }).code ?? null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    const resolved = await value;
    return { timing: 'resolved', value: resolved ?? null };
  } catch (error) {
    return {
      timing: 'asynchronous-reject',
      name: error instanceof Error ? error.name : typeof error,
      code: (error as { code?: unknown }).code ?? null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createRtdbClimbProbes(ctx: RtdbClimbContext): RtdbClimbProbe[] {
  return [
    {
      name: 'rtdb-modular-runtime-class-identity',
      matrixRow: 'rtdb-modular#M85, rtdb-modular#M86, rtdb-modular#M87, rtdb-modular#M88',
      rowIds: ['rtdb-modular#M85', 'rtdb-modular#M86', 'rtdb-modular#M87', 'rtdb-modular#M88'],
      description:
        'Runtime constructor exports, actual-instance prototype identity, direct construction, and TransactionResult.toJSON behavior.',
      observe: () => repeatStable(2, async (attempt) => {
        const path = scenarioPath(ctx, 'runtime-class-identity', attempt);
        const client = await createClient(ctx, `runtime-class-identity-${attempt}`);
        try {
          await set(ref(client.db, path), { value: 1 });
          const snapshot = await get(ref(client.db, path));
          const constraint = orderByKey();
          const result = await runTransaction(ref(client.db, `${path}/counter`), (value) =>
            ((value as number | null) ?? 0) + 1);
          return {
            exportTypes: {
              Database: typeof Database,
              DataSnapshot: typeof DataSnapshot,
              QueryConstraint: typeof QueryConstraint,
              TransactionResult: typeof TransactionResult,
            },
            database: prototypeShape(client.db, Database),
            snapshot: prototypeShape(snapshot, DataSnapshot),
            queryConstraint: prototypeShape(constraint, QueryConstraint),
            transactionResult: {
              ...prototypeShape(result, TransactionResult),
              toJSONType: typeof result.toJSON,
              toJSON: result.toJSON(),
            },
            directConstruction: {
              Database: directConstruction(Database as unknown as new () => object),
              DataSnapshot: directConstruction(DataSnapshot as unknown as new () => object),
              QueryConstraint: directConstruction(QueryConstraint as unknown as new () => object),
              TransactionResult: directConstruction(TransactionResult as unknown as new () => object),
            },
          };
        } finally {
          await cleanup([() => client.close(), () => adminRemove(ctx, path)]);
        }
      }),
    },
    {
      name: 'rtdb-modular-reference-shape-url',
      matrixRow: 'rtdb-modular#100-105, rtdb-modular#174',
      rowIds: [
        'rtdb-modular#100', 'rtdb-modular#101', 'rtdb-modular#102',
        'rtdb-modular#103', 'rtdb-modular#104', 'rtdb-modular#105',
        'rtdb-modular#174',
      ],
      description:
        'Reference navigation/string shape, refFromURL validation, forged-reference failure timing, and a successful normal read control.',
      observe: () => repeatStable(2, async (attempt) => {
        const path = scenarioPath(ctx, 'reference-shape-url', attempt);
        const client = await createClient(ctx, `reference-shape-url-${attempt}`);
        try {
          const root = ref(client.db);
          const nested = ref(client.db, `${path}/parent/child`);
          const viaChild = child(ref(client.db, `${path}/parent`), 'child');
          await set(nested, { ok: true });
          const matchingUrl = `${ctx.config.databaseURL.replace(/\/$/, '')}/${path}/parent/child`;
          const matching = refFromURL(client.db, matchingUrl);
          const otherHost = new URL(ctx.config.databaseURL);
          otherHost.hostname = `other-${otherHost.hostname}`;
          otherHost.pathname = `/${path}/parent/child`;
          return {
            root: {
              key: root.key,
              parent: root.parent,
              rootKey: root.root.key,
              toString: referenceStringShape(root.toString(), '/'),
            },
            nested: {
              key: nested.key,
              parentKey: nested.parent?.key ?? null,
              rootKey: nested.root.key,
              toString: referenceStringShape(nested.toString(), `${path}/parent/child`),
              childToStringMatches: viaChild.toString() === nested.toString(),
            },
            matchingUrl: {
              key: matching.key,
              value: (await get(matching)).val(),
              toString: referenceStringShape(matching.toString(), `${path}/parent/child`),
            },
            mismatchedHost: await captureInvocation(() => refFromURL(client.db, otherHost.toString())),
            malformedUrl: await captureInvocation(() => refFromURL(client.db, 'not-an-absolute-url')),
            forgedReference: await captureInvocation(() => get({} as never)),
            terminal: await adminRead(ctx, path),
          };
        } finally {
          await cleanup([() => client.close(), () => adminRemove(ctx, path)]);
        }
      }),
    },
    {
      name: 'rtdb-modular-write-return-validation',
      matrixRow: 'rtdb-modular#111, rtdb-modular#120',
      rowIds: ['rtdb-modular#111', 'rtdb-modular#120'],
      description:
        'set resolution value, overlapping update validation timing and atomic no-mutation proof, plus a successful non-overlapping control.',
      observe: () => repeatStable(2, async (attempt) => {
        const path = scenarioPath(ctx, 'write-return-validation', attempt);
        const client = await createClient(ctx, `write-return-validation-${attempt}`);
        try {
          const target = ref(client.db, path);
          const setResult = await set(target, { seed: true });
          const overlapping = await captureInvocation(() => update(target, { a: 1, 'a/b': 2 }));
          const afterRejected = await adminRead(ctx, path);
          const controlResult = await update(target, { 'left/value': 1, 'right/value': 2 });
          return {
            setResolution: setResult ?? null,
            overlapping,
            afterRejected,
            controlResolution: controlResult ?? null,
            terminal: await adminRead(ctx, path),
          };
        } finally {
          await cleanup([() => client.close(), () => adminRemove(ctx, path)]);
        }
      }),
    },
    {
      name: 'rtdb-modular-off-duplicate-registration',
      matrixRow: 'rtdb-modular#183',
      rowIds: ['rtdb-modular#183'],
      description:
        'Duplicate callback registration and exact off() removal scope, with terminal state independently confirmed.',
      observe: () => repeatStable(2, async (attempt) => {
        const path = scenarioPath(ctx, 'off-duplicate-registration', attempt);
        const client = await createClient(ctx, `off-duplicate-registration-${attempt}`);
        try {
          const target = ref(client.db, path);
          await set(target, 0);
          const values: unknown[] = [];
          const callback = (snapshot: DataSnapshot) => values.push(snapshot.val());
          onValue(target, callback);
          onValue(target, callback);
          await new Promise((resolve) => setTimeout(resolve, 250));
          const afterInitial = [...values];
          await set(target, 1);
          await new Promise((resolve) => setTimeout(resolve, 250));
          const afterFirstWrite = [...values];
          off(target, 'value', callback);
          await set(target, 2);
          await new Promise((resolve) => setTimeout(resolve, 250));
          const afterFirstOff = [...values];
          off(target, 'value', callback);
          await set(target, 3);
          await new Promise((resolve) => setTimeout(resolve, 250));
          return {
            afterInitial,
            afterFirstWrite,
            afterFirstOff,
            afterSecondOff: values,
            terminal: await adminRead(ctx, path),
          };
        } finally {
          off(ref(client.db, path));
          await cleanup([() => client.close(), () => adminRemove(ctx, path)]);
        }
      }),
    },
  ];
}
