import { initializeApp, deleteApp, type FirebaseOptions } from 'firebase/app';
import { deleteUser, getAuth, signInAnonymously } from 'firebase/auth';
import {
  getDatabase,
  goOffline,
  goOnline,
  onDisconnect,
  onValue,
  ref,
  set,
  type Database,
  type Unsubscribe,
} from 'firebase/database';
import { cert, deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';

export interface OracleProbe {
  name: string;
  matrixRow: string;
  rowIds: string[];
  description: string;
  observe(): Promise<Record<string, unknown>>;
}

export interface RtdbDisconnectContext {
  config: FirebaseOptions & { projectId: string; databaseURL: string };
  serviceAccount: {
    client_email: string;
    private_key: string;
    project_id: string;
  };
  rtdbAdminToken: string;
  runId: string;
}

interface Clients {
  writerDb: Database;
  observerDb: Database;
  close(): Promise<void>;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizedError(error: unknown): { code: string | null; name: string } {
  return {
    code: (error as { code?: string }).code ?? null,
    name: error instanceof Error ? error.name : typeof error,
  };
}

async function attempt(task: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    const value = await task();
    return { resolved: true, value: value ?? null };
  } catch (error) {
    return { resolved: false, error: normalizedError(error) };
  }
}

async function createClients(config: RtdbDisconnectContext['config'], suffix: string): Promise<Clients> {
  const writerApp = initializeApp(config, `disconnect-writer-${suffix}`);
  const observerApp = initializeApp(config, `disconnect-observer-${suffix}`);
  const writerAuth = getAuth(writerApp);
  const observerAuth = getAuth(observerApp);
  const signIns = await Promise.allSettled([
    signInAnonymously(writerAuth),
    signInAnonymously(observerAuth),
  ]);
  const signInFailure = signIns.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (signInFailure) {
    await Promise.all([
      writerAuth.currentUser ? deleteUser(writerAuth.currentUser).catch(() => undefined) : undefined,
      observerAuth.currentUser ? deleteUser(observerAuth.currentUser).catch(() => undefined) : undefined,
    ]);
    await Promise.all([deleteApp(writerApp).catch(() => undefined), deleteApp(observerApp).catch(() => undefined)]);
    throw signInFailure.reason;
  }
  return {
    writerDb: getDatabase(writerApp),
    observerDb: getDatabase(observerApp),
    async close() {
      goOnline(getDatabase(writerApp));
      await Promise.all([
        writerAuth.currentUser ? deleteUser(writerAuth.currentUser).catch(() => undefined) : undefined,
        observerAuth.currentUser ? deleteUser(observerAuth.currentUser).catch(() => undefined) : undefined,
      ]);
      await Promise.all([deleteApp(writerApp), deleteApp(observerApp)]);
    },
  };
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
  run: (attemptIndex: number) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const results: Record<string, unknown>[] = [];
  for (let index = 0; index < count; index++) results.push(await run(index));
  const first = stable(results[0]);
  if (!results.every((result) => stable(result) === first)) {
    throw new Error(`repeatability mismatch across ${count} attempts`);
  }
  return { repeatCount: count, ...results[0] };
}

async function waitFor(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(100);
  }
  throw new Error(`inconclusive timeout waiting for ${label}`);
}

function adminUrl(ctx: RtdbDisconnectContext, path: string, extra = ''): string {
  const normalized = path.split('/').filter(Boolean).join('/');
  return `${ctx.config.databaseURL}/${normalized}.json?access_token=${encodeURIComponent(ctx.rtdbAdminToken)}${extra}`;
}

async function adminRead(ctx: RtdbDisconnectContext, path: string, exportFormat = false): Promise<unknown> {
  const response = await fetch(adminUrl(ctx, path, exportFormat ? '&format=export' : ''));
  if (!response.ok) throw new Error(`admin read failed: ${response.status}`);
  return response.json();
}

async function adminWrite(ctx: RtdbDisconnectContext, path: string, value: unknown): Promise<void> {
  const response = await fetch(adminUrl(ctx, path, '&print=silent'), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error(`admin write failed: ${response.status}`);
}

async function adminRemove(ctx: RtdbDisconnectContext, path: string): Promise<void> {
  const response = await fetch(adminUrl(ctx, path, '&print=silent'), { method: 'DELETE' });
  if (!response.ok) throw new Error(`admin cleanup failed: ${response.status}`);
}

function observeValues(db: Database, path: string, values: unknown[]): Unsubscribe {
  return onValue(ref(db, path), (snapshot) => values.push(snapshot.val()));
}

function scenarioPath(ctx: RtdbDisconnectContext, name: string, attemptIndex: number): string {
  return `pyric_oracle/${ctx.runId}/ondisconnect/${name}/attempt-${attemptIndex}`;
}

async function readJsonLine(stream: ReadableStream<Uint8Array>, timeoutMs = 15_000): Promise<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      reader.read(),
      pause(remaining).then(() => ({ done: true, value: undefined } as ReadableStreamReadResult<Uint8Array>)),
    ]);
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });
    const newline = buffer.indexOf('\n');
    if (newline >= 0) return JSON.parse(buffer.slice(0, newline));
  }
  throw new Error('inconclusive timeout waiting for abrupt writer acknowledgement');
}

async function collectCleanupErrors(
  cleanupTasks: Array<() => void | Promise<void>>,
): Promise<unknown[]> {
  const cleanupErrors: unknown[] = [];
  for (const task of cleanupTasks) {
    try {
      await task();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  return cleanupErrors;
}

function throwCleanupErrors(cleanupErrors: unknown[]): void {
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, 'RTDB disconnect probe cleanup failed');
  }
}

/** Attempt every cleanup instead of letting one failure strand later resources. */
export async function runProbeCleanup(
  cleanupTasks: Array<() => void | Promise<void>>,
): Promise<void> {
  const cleanupErrors = await collectCleanupErrors(cleanupTasks);
  throwCleanupErrors(cleanupErrors);
}

/** Always restore live Rules, even when ordinary probe cleanup fails. */
export async function cleanupAfterRulesProbe(
  cleanupTasks: Array<() => void | Promise<void>>,
  restoreRules: () => Promise<void>,
  verifyRules: () => Promise<void>,
): Promise<void> {
  const cleanupErrors = await collectCleanupErrors(cleanupTasks);

  try {
    await restoreRules();
    await verifyRules();
  } catch (restoreError) {
    throw new AggregateError(
      [...cleanupErrors, restoreError],
      'RTDB disconnect probe failed to restore and verify Rules',
    );
  }

  throwCleanupErrors(cleanupErrors);
}

export function createRtdbDisconnectProbes(ctx: RtdbDisconnectContext): OracleProbe[] {
  const probe = (
    name: string,
    matrixRow: string,
    rowIds: string[],
    description: string,
    observe: () => Promise<Record<string, unknown>>,
  ): OracleProbe => ({ name, description, observe, matrixRow, rowIds });

  return [
    probe(
      'rtdb-modular-ondisconnect-registration',
      'rtdb-modular#M77, rtdb-modular#M78',
      ['rtdb-modular#M77', 'rtdb-modular#M78'],
      'onDisconnect handle shape, promise acknowledgements, and proof that registration alone does not mutate server data.',
      () => repeatStable(2, async (index) => {
        const path = scenarioPath(ctx, 'registration', index);
        const clients = await createClients(ctx.config, `${ctx.runId}-registration-${index}`);
        try {
          await set(ref(clients.writerDb, path), { state: 'online' });
          const handle = onDisconnect(ref(clients.writerDb, path));
          const prototype = Object.getPrototypeOf(handle) as Record<string, unknown>;
          const methodTypes = Object.fromEntries(
            ['cancel', 'remove', 'set', 'setWithPriority', 'update'].map((name) =>
              [name, typeof (handle as unknown as Record<string, unknown>)[name]]),
          );
          const setPromise = handle.set({ state: 'offline' });
          const setThenable = typeof (setPromise as { then?: unknown }).then === 'function';
          await setPromise;
          const unchangedAfterRegistration = await adminRead(ctx, path);
          const returnThenables: Record<string, boolean> = { set: setThenable };
          for (const [name, call] of [
            ['update', () => handle.update({ state: 'away' })],
            ['setWithPriority', () => handle.setWithPriority({ state: 'priority' }, 7)],
            ['remove', () => handle.remove()],
            ['cancel', () => handle.cancel()],
          ] as const) {
            const result = call();
            returnThenables[name] = typeof (result as { then?: unknown }).then === 'function';
            await result;
          }
          return {
            ownKeys: Object.keys(handle).sort(),
            prototypeKeys: Object.getOwnPropertyNames(prototype).filter((key) => key !== 'constructor').sort(),
            methodTypes,
            returnThenables,
            unchangedAfterRegistration,
          };
        } finally {
          await runProbeCleanup([() => clients.close(), () => adminRemove(ctx, path)]);
        }
      }),
    ),
    probe(
      'rtdb-modular-ondisconnect-clean-set',
      'rtdb-modular#M79',
      ['rtdb-modular#M79'],
      'Normal write, queued set, clean goOffline delivery, observer ordering, and one-shot behavior after goOnline.',
      () => repeatStable(2, async (index) => {
        const path = scenarioPath(ctx, 'clean-set', index);
        const clients = await createClients(ctx.config, `${ctx.runId}-clean-${index}`);
        const events: unknown[] = [];
        const unsubscribe = observeValues(clients.observerDb, path, events);
        try {
          await waitFor('observer initial event', () => events.length >= 1);
          await set(ref(clients.writerDb, path), { state: 'online' });
          await waitFor('normal online write event', () => events.length >= 2);
          const disconnect = onDisconnect(ref(clients.writerDb, path));
          await disconnect.set({ state: 'offline' });
          const beforeDisconnect = await adminRead(ctx, path);
          goOffline(clients.writerDb);
          await waitFor('queued disconnect event', () => events.some((value) => stable(value) === stable({ state: 'offline' })));
          const afterDisconnect = await adminRead(ctx, path);
          goOnline(clients.writerDb);
          await set(ref(clients.writerDb, path), { state: 'reconnected' });
          await waitFor('successful post-reconnect control', () =>
            events.some((value) => stable(value) === stable({ state: 'reconnected' })));
          const secondDisconnectControl = `${path}/secondDisconnectControl`;
          await onDisconnect(ref(clients.writerDb, secondDisconnectControl)).set({ drained: true });
          goOffline(clients.writerDb);
          await waitFor('second disconnect positive control', async () =>
            stable(await adminRead(ctx, secondDisconnectControl)) === stable({ drained: true }));
          await adminRemove(ctx, secondDisconnectControl);
          const terminalAfterReconnect = await adminRead(ctx, path);
          goOnline(clients.writerDb);
          return { events, beforeDisconnect, afterDisconnect, terminalAfterReconnect, secondDisconnectControlFired: true };
        } finally {
          await runProbeCleanup([
            () => unsubscribe(),
            () => clients.close(),
            () => adminRemove(ctx, path),
          ]);
        }
      }),
    ),
    probe(
      'rtdb-modular-ondisconnect-operations-cancel',
      'rtdb-modular#M80, rtdb-modular#M83',
      ['rtdb-modular#M80', 'rtdb-modular#M83'],
      'Queued set, update, remove, setWithPriority, cancellation scope, and overlapping parent/child registrations.',
      () => repeatStable(2, async (index) => {
        const rootPath = scenarioPath(ctx, 'operations-cancel', index);
        const clients = await createClients(ctx.config, `${ctx.runId}-ops-${index}`);
        const events: unknown[] = [];
        const unsubscribe = observeValues(clients.observerDb, rootPath, events);
        try {
          const outcomes: Record<string, unknown> = {};
          const runCase = async (name: string, seed: unknown, register: (db: Database, path: string) => Promise<void>) => {
            const path = `${rootPath}/${name}`;
            await set(ref(clients.writerDb, path), seed);
            await waitFor(`${name} seed observer event`, () => events.some((value) =>
              stable((value as Record<string, unknown> | null)?.[name]) === stable(seed)));
            await register(clients.writerDb, path);
            const eventsBeforeDisconnect = events.length;
            goOffline(clients.writerDb);
            await waitFor(`${name} terminal state`, async () => stable(await adminRead(ctx, path)) !== stable(seed));
            await waitFor(`${name} observer disconnect event`, () => events.length > eventsBeforeDisconnect);
            outcomes[name] = await adminRead(ctx, path, name === 'setWithPriority');
            goOnline(clients.writerDb);
          };
          await runCase('set', { before: true }, (db, path) => onDisconnect(ref(db, path)).set({ after: true }));
          await runCase('update', { keep: true, value: 1 }, (db, path) => onDisconnect(ref(db, path)).update({ value: 2, added: true }));
          await runCase('remove', { before: true }, (db, path) => onDisconnect(ref(db, path)).remove());
          await runCase('setWithPriority', { before: true }, (db, path) => onDisconnect(ref(db, path)).setWithPriority({ after: true }, 7));

          const overlap = `${rootPath}/overlap`;
          await set(ref(clients.writerDb, overlap), { original: true, child: 'original-child' });
          await onDisconnect(ref(clients.writerDb, overlap)).set({ parent: true, child: 'parent-child' });
          await onDisconnect(ref(clients.writerDb, `${overlap}/child`)).set('child');
          await onDisconnect(ref(clients.writerDb, `${overlap}/child`)).cancel();
          goOffline(clients.writerDb);
          await waitFor('overlap parent registration', async () =>
            stable(await adminRead(ctx, overlap)) !== stable({ original: true, child: 'original-child' }));
          outcomes.overlapAfterChildCancel = await adminRead(ctx, overlap);
          goOnline(clients.writerDb);

          const cancelScope = `${rootPath}/cancel-scope`;
          const cancelControl = `${rootPath}/cancel-control`;
          await set(ref(clients.writerDb, cancelScope), { child: 'original' });
          await onDisconnect(ref(clients.writerDb, `${cancelScope}/child`)).set('queued-child');
          await onDisconnect(ref(clients.writerDb, `${cancelScope}/child/grandchild`)).set('queued-grandchild');
          await onDisconnect(ref(clients.writerDb, cancelScope)).cancel();
          await onDisconnect(ref(clients.writerDb, cancelControl)).set({ drained: true });
          goOffline(clients.writerDb);
          await waitFor('parent cancellation positive drain control', async () =>
            stable(await adminRead(ctx, cancelControl)) === stable({ drained: true }));
          outcomes.parentCancelDescendantsTerminal = await adminRead(ctx, cancelScope);
          goOnline(clients.writerDb);

          const cancelled = `${rootPath}/cancelled`;
          await set(ref(clients.writerDb, cancelled), { original: true });
          const cancelledHandle = onDisconnect(ref(clients.writerDb, cancelled));
          await cancelledHandle.set({ shouldNotApply: true });
          await cancelledHandle.cancel();
          await onDisconnect(ref(clients.writerDb, `${rootPath}/cancelled-control`)).set({ drained: true });
          goOffline(clients.writerDb);
          await waitFor('exact cancellation positive drain control', async () =>
            stable(await adminRead(ctx, `${rootPath}/cancelled-control`)) === stable({ drained: true }));
          outcomes.cancelledTerminal = await adminRead(ctx, cancelled);
          goOnline(clients.writerDb);
          return { outcomes, observerSawDisconnectEvents: events.length > 1 };
        } finally {
          await runProbeCleanup([
            () => unsubscribe(),
            () => clients.close(),
            () => adminRemove(ctx, rootPath),
          ]);
        }
      }),
    ),
    probe(
      'rtdb-modular-ondisconnect-rules',
      'rtdb-modular#M81',
      ['rtdb-modular#M81'],
      'Registration denial and execution-time rules re-evaluation, each paired with a successful normal-write control.',
      () => repeatStable(2, async (index) => {
        const rootPath = scenarioPath(ctx, 'rules', index);
        const rulesUrl = `${ctx.config.databaseURL}/.settings/rules.json?access_token=${encodeURIComponent(ctx.rtdbAdminToken)}`;
        const readRules = async () => {
          const response = await fetch(rulesUrl);
          if (!response.ok) throw new Error(`rules read failed: ${response.status}`);
          return response.json() as Promise<Record<string, unknown>>;
        };
        const writeRules = async (body: Record<string, unknown>) => {
          const response = await fetch(`${rulesUrl}&print=silent`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          });
          if (!response.ok) throw new Error(`rules write failed: ${response.status}`);
        };
        const before = await readRules();
        const clients = await createClients(ctx.config, `${ctx.runId}-rules-${index}`);
        const observerEvents: unknown[] = [];
        const unsubscribe = observeValues(clients.observerDb, rootPath, observerEvents);
        const run = rootPath.split('/')[1]!;
        const rulesFor = (write: boolean) => {
          const rootRules = before.rules && typeof before.rules === 'object'
            ? before.rules as Record<string, unknown>
            : {};
          const oracleRules = rootRules.pyric_oracle && typeof rootRules.pyric_oracle === 'object'
            ? rootRules.pyric_oracle as Record<string, unknown>
            : {};
          // Only mutate the authorized oracle namespace. The harness normally
          // grants at /pyric_oracle, so remove those cascading grants while
          // this focused deny/allow probe runs; preserve every sibling rule
          // and restore the canonical-equivalent rules document in `finally`.
          const { ['.read']: _read, ['.write']: _write, ...oracleChildren } = oracleRules;
          return {
            ...before,
            rules: {
              ...rootRules,
              pyric_oracle: {
                ...oracleChildren,
                [run]: {
                  '.read': 'auth != null',
                  ondisconnect: {
                    rules: {
                      [`attempt-${index}`]: {
                        target: { '.write': write ? 'auth != null' : false },
                        drainControl: { '.write': 'auth != null' },
                      },
                    },
                  },
                },
              },
            },
          };
        };
        try {
          await writeRules(rulesFor(false));
          await pause(5_000);
          const target = ref(clients.writerDb, `${rootPath}/target`);
          const normalDeniedControl = await attempt(() => set(target, 'normal-denied'));
          const registrationDenied = await attempt(() => onDisconnect(target).set('disconnect-denied'));
          if (normalDeniedControl.resolved !== false || registrationDenied.resolved !== false) {
            throw new Error('deny-phase controls did not both reject');
          }

          await writeRules(rulesFor(true));
          await pause(5_000);
          const normalAllowedControl = await attempt(() => set(target, 'seed'));
          const registeredWhileAllowed = await attempt(() => onDisconnect(target).set('queued'));
          if (normalAllowedControl.resolved !== true || registeredWhileAllowed.resolved !== true) {
            throw new Error('allow-phase controls did not both resolve');
          }

          await writeRules(rulesFor(false));
          await pause(5_000);
          const drainControlPath = `${rootPath}/drainControl`;
          await onDisconnect(ref(clients.writerDb, drainControlPath)).set('drained');
          goOffline(clients.writerDb);
          await waitFor('execution-time denial drain control', async () =>
            await adminRead(ctx, drainControlPath) === 'drained');
          await waitFor('execution-time denial observer control', () => observerEvents.some((value) =>
            (value as Record<string, unknown> | null)?.drainControl === 'drained'));
          const terminalAfterExecutionDenial = await adminRead(ctx, `${rootPath}/target`);
          goOnline(clients.writerDb);
          return {
            normalDeniedControl,
            registrationDenied,
            normalAllowedControl,
            registeredWhileAllowed,
            drainControlExecuted: true,
            observerSawDrainControl: true,
            terminalAfterExecutionDenial,
          };
        } finally {
          await cleanupAfterRulesProbe(
            [() => unsubscribe(), () => clients.close(), () => adminRemove(ctx, rootPath)],
            () => writeRules(before),
            async () => {
              if (stable(await readRules()) !== stable(before)) {
                throw new Error('rules restore verification failed');
              }
            },
          );
        }
      }),
    ),
    probe(
      'rtdb-modular-ondisconnect-abrupt-exit',
      'rtdb-modular#M84',
      ['rtdb-modular#M84'],
      'Acknowledged onDisconnect registration followed by forced writer-process termination, observed independently.',
      () => repeatStable(3, async (index) => {
        const path = scenarioPath(ctx, 'abrupt-exit', index);
        const observerApp = initializeApp(ctx.config, `disconnect-abrupt-observer-${ctx.runId}-${index}`);
        const observerAuth = getAuth(observerApp);
        await signInAnonymously(observerAuth);
        const events: unknown[] = [];
        const unsubscribe = observeValues(getDatabase(observerApp), path, events);
        const adminApp = initializeAdminApp({
          credential: cert({
            projectId: ctx.serviceAccount.project_id,
            clientEmail: ctx.serviceAccount.client_email,
            privateKey: ctx.serviceAccount.private_key,
          }),
          databaseURL: ctx.config.databaseURL,
        }, `disconnect-abrupt-admin-${ctx.runId}-${index}`);
        const uid = `pyric-disconnect-${ctx.runId}-${index}`.slice(0, 128);
        let child: ReturnType<typeof Bun.spawn> | undefined;
        try {
          await set(ref(getDatabase(observerApp), path), { state: 'online' });
          await waitFor('abrupt observer seed', () => events.some((value) => stable(value) === stable({ state: 'online' })));
          await getAdminAuth(adminApp).createUser({ uid });
          const token = await getAdminAuth(adminApp).createCustomToken(uid);
          child = Bun.spawn(['bun', new URL('./abrupt-writer.ts', import.meta.url).pathname], {
            stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
          });
          const childInput = child.stdin;
          if (!childInput || typeof childInput === 'number') throw new Error('abrupt writer stdin pipe unavailable');
          childInput.write(JSON.stringify({ config: ctx.config, token, path, value: { state: 'offline' } }));
          childInput.end();
          const acknowledgement = await readJsonLine(child.stdout as ReadableStream<Uint8Array>);
          child.kill('SIGKILL');
          await child.exited;
          await waitFor('abrupt disconnect terminal value', async () =>
            stable(await adminRead(ctx, path)) === stable({ state: 'offline' }), 20_000);
          await waitFor('abrupt observer event', () =>
            events.some((value) => stable(value) === stable({ state: 'offline' })));
          return { acknowledgement, events, terminal: await adminRead(ctx, path), exitWasForced: true };
        } finally {
          await runProbeCleanup([
            () => { if (child && child.exitCode === null) child.kill('SIGKILL'); },
            () => unsubscribe(),
            async () => {
              if (observerAuth.currentUser) await deleteUser(observerAuth.currentUser);
            },
            () => getAdminAuth(adminApp).deleteUser(uid),
            () => deleteApp(observerApp),
            () => deleteAdminApp(adminApp),
            () => adminRemove(ctx, path),
          ]);
        }
      }),
    ),
  ];
}
