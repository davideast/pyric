import { deleteApp, initializeApp } from 'firebase/app';
import { deleteUser, getAuth, signInAnonymously } from 'firebase/auth';
import { getDatabase } from 'firebase/database';
import type { RtdbClimbClient, RtdbClimbContext } from './probe-types.ts';

export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function repeatStable(
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

export async function createClient(ctx: RtdbClimbContext, suffix: string): Promise<RtdbClimbClient> {
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
    auth,
    authToken: await auth.currentUser!.getIdToken(),
    async close() {
      if (auth.currentUser) await deleteUser(auth.currentUser).catch(() => undefined);
      await deleteApp(app);
    },
  };
}

export function scenarioPath(ctx: RtdbClimbContext, probe: string, attempt: number): string {
  return `pyric_oracle/${ctx.runId}/rtdb-climb/${probe}/attempt-${attempt}`;
}

export function adminUrl(ctx: RtdbClimbContext, path: string, extra = ''): string {
  const normalized = path.split('/').filter(Boolean).join('/');
  return `${ctx.config.databaseURL}/${normalized}.json?access_token=${encodeURIComponent(ctx.rtdbAdminToken)}${extra}`;
}

export async function adminRead(ctx: RtdbClimbContext, path: string): Promise<unknown> {
  const response = await fetch(adminUrl(ctx, path));
  if (!response.ok) throw new Error(`RTDB climb admin read failed: ${response.status}`);
  return response.json();
}

export async function adminRemove(ctx: RtdbClimbContext, path: string): Promise<void> {
  const response = await fetch(adminUrl(ctx, path, '&print=silent'), { method: 'DELETE' });
  if (!response.ok) throw new Error(`RTDB climb cleanup failed: ${response.status}`);
}

export async function cleanup(tasks: Array<() => Promise<void>>): Promise<void> {
  const results = await Promise.allSettled(tasks.map((task) => task()));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length === 1) throw failures[0]!.reason;
  if (failures.length > 1) {
    throw new AggregateError(failures.map((failure) => failure.reason), 'RTDB climb cleanup failed');
  }
}

export function prototypeShape(value: object, constructor: Function): Record<string, unknown> {
  return {
    constructorName: value.constructor.name,
    instanceOf: value instanceof constructor,
    prototypeIsExportPrototype: Object.getPrototypeOf(value) === constructor.prototype,
    prototypeKeys: Object.getOwnPropertyNames(Object.getPrototypeOf(value)).sort(),
  };
}

export function directConstruction(constructor: new () => object): Record<string, unknown> {
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

export function referenceStringShape(value: string, expectedPath: string): Record<string, unknown> {
  const parsed = new URL(value);
  const normalizedExpected = `/${expectedPath.split('/').filter(Boolean).join('/')}`;
  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    pathMatches: parsed.pathname.replace(/\/$/, '') === normalizedExpected.replace(/\/$/, ''),
  };
}

export function errorShape(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    name: error instanceof Error ? error.name : typeof error,
    code: (error as { code?: unknown }).code ?? null,
    message: message.replace(/ at \/pyric_oracle\/.*?: Client/, ' at <path>: Client'),
  };
}

export async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(100);
  }
  throw new Error(`${label} timed out; the probe is inconclusive`);
}

export async function captureInvocation(task: () => unknown): Promise<Record<string, unknown>> {
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
