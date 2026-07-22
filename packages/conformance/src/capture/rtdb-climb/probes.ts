import { deleteApp, initializeApp, type FirebaseOptions } from 'firebase/app';
import { deleteUser, getAuth, signInAnonymously, signOut, type Auth } from 'firebase/auth';
import {
  DataSnapshot,
  Database,
  QueryConstraint,
  TransactionResult,
  child,
  endAt,
  endBefore,
  equalTo,
  get,
  getDatabase,
  increment,
  limitToFirst,
  limitToLast,
  off,
  onChildAdded,
  onChildChanged,
  onChildMoved,
  onChildRemoved,
  onValue,
  orderByChild,
  orderByKey,
  orderByPriority,
  orderByValue,
  query,
  ref,
  refFromURL,
  remove,
  runTransaction,
  set,
  setPriority,
  setWithPriority,
  startAfter,
  startAt,
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
  auth: Auth;
  authToken: string;
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
    auth,
    authToken: await auth.currentUser!.getIdToken(),
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
    prototypeKeys: Object.getOwnPropertyNames(Object.getPrototypeOf(value)).sort(),
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

function errorShape(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    name: error instanceof Error ? error.name : typeof error,
    code: (error as { code?: unknown }).code ?? null,
    message: message.replace(/ at \/pyric_oracle\/.*?: Client/, ' at <path>: Client'),
  };
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
  throw new Error(`${label} timed out; the probe is inconclusive`);
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
      name: 'rtdb-modular-listener-cancellation',
      matrixRow: 'rtdb-modular#M75a',
      rowIds: ['rtdb-modular#M75a'],
      description:
        'Cancellation callback timing and Firebase error shape for initially denied and subsequently revoked value/child listeners, with successful read controls and exact rules restoration.',
      observe: () => repeatStable(2, async (attempt) => {
        const path = scenarioPath(ctx, 'listener-cancellation', attempt);
        const run = path.split('/')[1]!;
        const rulesUrl = `${ctx.config.databaseURL}/.settings/rules.json?access_token=${encodeURIComponent(ctx.rtdbAdminToken)}`;
        const readRules = async (): Promise<Record<string, unknown>> => {
          const response = await fetch(rulesUrl);
          if (!response.ok) throw new Error(`listener cancellation rules read failed: ${response.status}`);
          return response.json() as Promise<Record<string, unknown>>;
        };
        const writeRules = async (body: Record<string, unknown>): Promise<void> => {
          const response = await fetch(`${rulesUrl}&print=silent`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!response.ok) throw new Error(`listener cancellation rules write failed: ${response.status}`);
        };
        const before = await readRules();
        const rootRules = before.rules && typeof before.rules === 'object'
          ? before.rules as Record<string, unknown>
          : {};
        const oracleRules = rootRules.pyric_oracle && typeof rootRules.pyric_oracle === 'object'
          ? rootRules.pyric_oracle as Record<string, unknown>
          : {};
        const { ['.read']: _read, ['.write']: _write, ...oracleChildren } = oracleRules;
        const rulesFor = (deniedRead: boolean, revokedRead: boolean) => ({
          ...before,
          rules: {
            ...rootRules,
            pyric_oracle: {
              ...oracleChildren,
              [run]: {
                '.write': 'auth != null',
                'rtdb-climb': {
                  'listener-cancellation': {
                    [`attempt-${attempt}`]: {
                      control: { '.read': 'auth != null' },
                      denied: { '.read': deniedRead ? false : 'auth != null' },
                      revoked: { '.read': revokedRead ? false : 'auth != null' },
                      callbackless: { '.read': 'auth != null' },
                    },
                  },
                },
              },
            },
          },
        });
        const client = await createClient(ctx, `listener-cancellation-${attempt}`);
        const clientRead = (readPath: string) => fetch(
          `${ctx.config.databaseURL}/${readPath}.json?auth=${encodeURIComponent(client.authToken)}`,
        );
        const unsubs: Array<() => void> = [];
        try {
          await writeRules(rulesFor(false, false));
          await waitFor('listener cancellation allow rules readiness', async () => {
            try {
              const [control, revoked] = await Promise.all([
                clientRead(`${path}/control`),
                clientRead(`${path}/revoked`),
              ]);
              return control.ok && revoked.ok;
            } catch {
              return false;
            }
          });
          await set(ref(client.db, `${path}/control`), { ok: true });
          await set(ref(client.db, `${path}/denied`), { child: 1 });
          await set(ref(client.db, `${path}/revoked`), { child: 1 });
          await set(ref(client.db, `${path}/callbackless`), { value: 0 });
          const allowedControl = (await get(ref(client.db, `${path}/control`))).val();

          await writeRules(rulesFor(true, false));
          await waitFor('listener cancellation denied rules readiness', async () => {
            const response = await clientRead(`${path}/denied`);
            return response.status === 401 || response.status === 403;
          });
          const registrars = [onValue, onChildAdded, onChildChanged, onChildRemoved, onChildMoved] as const;
          const names = ['value', 'child_added', 'child_changed', 'child_removed', 'child_moved'] as const;
          const denied: Record<string, unknown> = {};
          for (let index = 0; index < registrars.length; index++) {
            const cancellations: Record<string, unknown>[] = [];
            let synchronous: Record<string, unknown> | null = null;
            try {
              const unsubscribe = registrars[index]!(
                ref(client.db, `${path}/denied`),
                () => undefined,
                (error: Error) => { cancellations.push(errorShape(error)); },
              ) as () => void;
              unsubs.push(unsubscribe);
            } catch (error) {
              synchronous = errorShape(error);
            }
            await waitFor(`${names[index]} initial-denial cancellation`, () =>
              synchronous !== null || cancellations.length > 0);
            denied[names[index]!] = {
              synchronous,
              cancellations,
            };
          }

          const revokedCancellations: Record<string, Record<string, unknown>[]> = {};
          const deliveryCounts: Record<string, number> = {};
          for (let index = 0; index < registrars.length; index++) {
            const name = names[index]!;
            revokedCancellations[name] = [];
            deliveryCounts[name] = 0;
            unsubs.push(registrars[index]!(
              ref(client.db, `${path}/revoked`),
              () => { deliveryCounts[name] = (deliveryCounts[name] ?? 0) + 1; },
              (error: Error) => { revokedCancellations[name]!.push(errorShape(error)); },
            ) as () => void);
          }
          await writeRules(rulesFor(true, true));
          await waitFor('revoked listener cancellations', () =>
            Object.values(revokedCancellations).every((events) => events.length === 1));
          const controlAfterRevocation = (await get(ref(client.db, `${path}/control`))).val();
          const callbacklessDeliveries: unknown[] = [];
          unsubs.push(onValue(ref(client.db, `${path}/callbackless`), (snapshot) => {
            callbacklessDeliveries.push(snapshot.val());
          }));
          await waitFor('callbackless listener initial readiness', () =>
            callbacklessDeliveries.length === 1);
          await signOut(client.auth);
          const signedOutCancellations: Record<string, unknown>[] = [];
          unsubs.push(onValue(
            ref(client.db, `${path}/callbackless`),
            () => undefined,
            (error) => { signedOutCancellations.push(errorShape(error)); },
          ));
          await waitFor('callbackless listener signed-out denial readiness', () =>
            signedOutCancellations.length === 1);
          await signInAnonymously(client.auth);
          const freshControlDeliveries: unknown[] = [];
          unsubs.push(onValue(ref(client.db, `${path}/callbackless`), (snapshot) => {
            freshControlDeliveries.push(snapshot.val());
          }));
          await set(ref(client.db, `${path}/callbackless`), { value: 1 });
          await waitFor('callbackless fresh-listener control delivery', () =>
            (freshControlDeliveries.at(-1) as { value?: number } | undefined)?.value === 1);
          return {
            allowedControl,
            denied,
            revoked: { deliveryCounts, cancellations: revokedCancellations },
            controlAfterRevocation,
            callbacklessAuth: {
              deliveries: callbacklessDeliveries,
              signedOutCancellations,
              freshControlDeliveries,
            },
          };
        } finally {
          for (const unsubscribe of unsubs) unsubscribe();
          await cleanup([
            () => client.close(),
            () => adminRemove(ctx, path),
            async () => {
              await writeRules(before);
              if (stable(await readRules()) !== stable(before)) {
                throw new Error('listener cancellation rules restore verification failed');
              }
            },
          ]);
        }
      }),
    },
    {
      name: 'rtdb-modular-child-listener-only-once',
      matrixRow: 'rtdb-modular#M75d',
      rowIds: ['rtdb-modular#M75d'],
      description:
        'Child-listener options and cancellation-plus-options overloads stop after the first added, changed, removed, or moved delivery.',
      observe: () => repeatStable(2, async (attempt) => {
        const path = scenarioPath(ctx, 'child-listener-only-once', attempt);
        const client = await createClient(ctx, `child-listener-only-once-${attempt}`);
        const target = ref(client.db, path);
        const added: Array<[string | null, string | null]> = [];
        const changed: Array<[string | null, string | null]> = [];
        const removed: Array<[string | null, string | null]> = [];
        const moved: Array<[string | null, string | null]> = [];
        const controlAdded: Array<string | null> = [];
        const controlChanged: Array<string | null> = [];
        const controlRemoved: Array<string | null> = [];
        const controlMoved: Array<string | null> = [];
        const cancellations: Record<string, unknown>[] = [];
        try {
          await set(target, {
            a: { rank: 1, value: 1 },
            b: { rank: 2, value: 2 },
            c: { rank: 3, value: 3 },
          });
          onChildAdded(target, (snap, previous) => { added.push([snap.key, previous]); }, { onlyOnce: true });
          onChildChanged(
            target,
            (snap, previous) => { changed.push([snap.key, previous]); },
            (error) => cancellations.push(errorShape(error)),
            { onlyOnce: true },
          );
          onChildRemoved(target, ((snap: DataSnapshot, previous?: string | null) => {
            removed.push([snap.key, previous ?? null]);
          }) as (snap: DataSnapshot) => void, { onlyOnce: true });
          onChildMoved(
            query(target, orderByChild('rank')),
            (snap, previous) => { moved.push([snap.key, previous]); },
            { onlyOnce: true },
          );
          onChildAdded(target, (snap) => { controlAdded.push(snap.key); });
          onChildChanged(target, (snap) => { controlChanged.push(snap.key); });
          onChildRemoved(target, (snap) => { controlRemoved.push(snap.key); });
          onChildMoved(query(target, orderByChild('rank')), (snap) => {
            controlMoved.push(snap.key);
          });
          await waitFor('child onlyOnce initial replay readiness', () =>
            added.length === 3 && controlAdded.length === 3);
          await update(child(target, 'a'), { value: 10, rank: 4 });
          await waitFor('child onlyOnce first change readiness', () =>
            controlChanged.length === 1 && controlMoved.length === 1);
          await update(child(target, 'a'), { value: 11, rank: 0 });
          await waitFor('child onlyOnce second change readiness', () =>
            controlChanged.length === 2 && controlMoved.length === 2);
          await remove(child(target, 'b'));
          await waitFor('child onlyOnce first removal readiness', () =>
            controlRemoved.length === 1);
          await remove(child(target, 'c'));
          await waitFor('child onlyOnce second removal readiness', () =>
            controlRemoved.length === 2);
          await set(child(target, 'd'), { rank: 5, value: 4 });
          await waitFor('child onlyOnce later addition readiness', () =>
            controlAdded.length === 4);
          return { added, changed, removed, moved, cancellations };
        } finally {
          off(target);
          await cleanup([() => client.close(), () => adminRemove(ctx, path)]);
        }
      }),
    },
    {
      name: 'rtdb-modular-child-previous-name',
      matrixRow: 'rtdb-modular#M75, rtdb-modular#M75c',
      rowIds: ['rtdb-modular#M75', 'rtdb-modular#M75c'],
      description:
        'previousChildName values for initial replay, add/change/remove, and ordered movement, with terminal state independently confirmed.',
      observe: () => repeatStable(2, async (attempt) => {
        const path = scenarioPath(ctx, 'child-previous-name', attempt);
        const client = await createClient(ctx, `child-previous-name-${attempt}`);
        const target = ref(client.db, path);
        const plainPriorityTarget = ref(client.db, `${path}-plain-priority`);
        const added: Array<[string | null, string | null]> = [];
        const changed: Array<[string | null, string | null]> = [];
        const removed: Array<[string | null, string | null]> = [];
        const moved: Array<[string | null, string | null]> = [];
        const plainPriorityAdded: Array<[string | null, string | null]> = [];
        try {
          await set(target, {
            a: { rank: 1, stable: false },
            b: { rank: 2, stable: false },
            c: { rank: 3, stable: false },
          });
          const ordered = query(target, orderByKey());
          onChildAdded(ordered, (snap, previous) => { added.push([snap.key, previous ?? null]); });
          onChildChanged(ordered, ((snap: DataSnapshot, previous?: string | null) => {
            changed.push([snap.key, previous ?? null]);
          }) as (snap: DataSnapshot) => void);
          onChildRemoved(ordered, ((snap: DataSnapshot, previous?: string | null) => {
            removed.push([snap.key, previous ?? null]);
          }) as (snap: DataSnapshot) => void);
          const rankOrdered = query(target, orderByChild('rank'));
          onChildMoved(rankOrdered, (snap, previous) => moved.push([snap.key, previous]));
          await waitFor('child previous-name initial replay readiness', () => added.length === 3);
          const initialAdded = [...added];
          await set(child(target, 'd'), { rank: 4, stable: false });
          await waitFor('child previous-name addition readiness', () => added.length === 4);
          await update(child(target, 'b'), { stable: true });
          await waitFor('child previous-name first change readiness', () => changed.length === 1);
          await remove(child(target, 'a'));
          await waitFor('child previous-name removal readiness', () => removed.length === 1);
          await update(child(target, 'c'), { rank: 0 });
          await waitFor('child previous-name movement readiness', () =>
            changed.length === 2 && moved.length === 1);
          const terminal = await adminRead(ctx, path);
          await setWithPriority(child(plainPriorityTarget, 'z'), { value: 2 }, 2);
          await setWithPriority(child(plainPriorityTarget, 'a'), { value: 1 }, 1);
          onChildAdded(plainPriorityTarget, (snap, previous) => {
            plainPriorityAdded.push([snap.key, previous ?? null]);
          });
          await waitFor('plain child priority-order readiness', () =>
            plainPriorityAdded.length === 2);
          return {
            initialAdded,
            postMutationAdded: added.slice(initialAdded.length),
            changed,
            removed,
            moved,
            plainPriorityAdded,
            terminal,
          };
        } finally {
          off(target);
          off(plainPriorityTarget);
          await cleanup([
            () => client.close(),
            () => adminRemove(ctx, path),
            () => adminRemove(ctx, `${path}-plain-priority`),
          ]);
        }
      }),
    },
    {
      name: 'rtdb-modular-priority-contract',
      matrixRow: 'rtdb-modular#M46, rtdb-modular#M89, rtdb-modular#M90, rtdb-modular#M91',
      rowIds: ['rtdb-modular#M46', 'rtdb-modular#M89', 'rtdb-modular#M90', 'rtdb-modular#M91'],
      description:
        'Priority round trips, replacement/preservation/clearing, priority ordering with bounds and limits, movement, and transaction lifecycle.',
      observe: () => repeatStable(2, async (attempt) => {
        const path = scenarioPath(ctx, 'priority-contract', attempt);
        const client = await createClient(ctx, `priority-contract-${attempt}`);
        const target = ref(client.db, path);
        const moved: Array<[string | null, string | null]> = [];
        const plainMoved: Array<[string | null, string | null]> = [];
        let orderedValueDeliveries = 0;
        try {
          await setWithPriority(child(target, 'a'), { value: 1 }, 10);
          await setWithPriority(child(target, 'b'), { value: 2 }, 5);
          await setWithPriority(child(target, 'c'), { value: 3 }, 5);
          const before = await Promise.all(['a', 'b', 'c'].map(async (key) => {
            const snap = await get(child(target, key));
            return { key, priority: snap.priority, exportVal: snap.exportVal() };
          }));
          const orderedKeys: Array<string | null> = [];
          (await get(query(target, orderByPriority()))).forEach((snap) => {
            orderedKeys.push(snap.key);
          });
          const boundedKeys: Array<string | null> = [];
          (await get(query(target, orderByPriority(), startAt(5), limitToFirst(2)))).forEach((snap) => {
            boundedKeys.push(snap.key);
          });
          const equalKeys: Array<string | null> = [];
          (await get(query(target, orderByPriority(), equalTo(5)))).forEach((snap) => {
            equalKeys.push(snap.key);
          });
          const plainForEachKeys: Array<string | null> = [];
          const parentSnapshot = await get(target);
          parentSnapshot.forEach((snap) => { plainForEachKeys.push(snap.key); });
          const defaultLimitedKeys: Array<string | null> = [];
          (await get(query(target, limitToFirst(2)))).forEach((snap) => {
            defaultLimitedKeys.push(snap.key);
          });
          const parentExportVal = parentSnapshot.exportVal();
          const parentToJSON = parentSnapshot.toJSON();
          const invalidPriorityBounds = {
            boolean: await captureInvocation(() =>
              query(target, orderByPriority(), startAt(false))),
            object: await captureInvocation(() =>
              query(target, orderByPriority(), startAt({ invalid: true } as unknown as null))),
            defaultBoolean: await captureInvocation(() => query(target, startAt(false))),
            defaultObject: await captureInvocation(() =>
              query(target, startAt({ invalid: true } as unknown as null))),
          };
          onChildMoved(query(target, orderByPriority()), (snap, previous) => moved.push([snap.key, previous]));
          onChildMoved(target, (snap, previous) => plainMoved.push([snap.key, previous]));
          onValue(query(target, orderByPriority()), () => { orderedValueDeliveries += 1; });
          await waitFor('priority listener initial readiness', () => orderedValueDeliveries === 1);
          await setPriority(child(target, 'a'), 0);
          await waitFor('priority movement readiness', () =>
            moved.length === 1 && plainMoved.length === 1 && orderedValueDeliveries === 2);
          const movedAfterReorder = [...moved];
          const plainMovedAfterReorder = [...plainMoved];
          const orderedValueDeliveriesAfterMove = orderedValueDeliveries;
          await setPriority(child(target, 'c'), 6);
          await waitFor('same-position priority listener readiness', () =>
            moved.length === 2 && plainMoved.length === 2 && orderedValueDeliveries === 3);
          const samePositionMoved = moved.slice(movedAfterReorder.length);
          const samePositionPlainMoved = plainMoved.slice(plainMovedAfterReorder.length);
          const orderedValueDeliveriesAfterSamePositionChange = orderedValueDeliveries;
          const afterMove = await get(child(target, 'a'));
          await update(target, { 'a/value': 4 });
          const afterUpdate = (await get(child(target, 'a'))).priority;
          await runTransaction(child(target, 'a'), (current) => ({
            value: ((current as { value?: number } | null)?.value ?? 0) + 1,
          }));
          const afterTransaction = (await get(child(target, 'a'))).priority;
          await set(child(target, 'b'), { value: 20 });
          const afterSet = (await get(child(target, 'b'))).priority;
          await setPriority(child(target, 'c'), null);
          const afterClear = await get(child(target, 'c'));
          return {
            before,
            orderedKeys,
            boundedKeys,
            equalKeys,
            plainForEachKeys,
            defaultLimitedKeys,
            parentExportVal,
            parentToJSON,
            invalidPriorityBounds,
            moved: movedAfterReorder,
            plainMoved: plainMovedAfterReorder,
            samePositionMoved,
            samePositionPlainMoved,
            allMoved: moved,
            allPlainMoved: plainMoved,
            orderedValueDeliveriesAfterMove,
            orderedValueDeliveriesAfterSamePositionChange,
            totalOrderedValueDeliveries: orderedValueDeliveries,
            afterMove: { priority: afterMove.priority, exportVal: afterMove.exportVal() },
            afterUpdate,
            afterTransaction,
            afterSet,
            afterClear: { priority: afterClear.priority, exportVal: afterClear.exportVal() },
            terminal: await adminRead(ctx, path),
          };
        } finally {
          off(target);
          await cleanup([() => client.close(), () => adminRemove(ctx, path)]);
        }
      }),
    },
    {
      name: 'rtdb-modular-concurrent-transforms',
      matrixRow: 'rtdb-modular#M37h, rtdb-modular#157, rtdb-modular#161',
      rowIds: ['rtdb-modular#M37h', 'rtdb-modular#157', 'rtdb-modular#161'],
      description:
        'Two-client concurrent increments and transactions preserve both updates, with transaction retry evidence and independent terminal reads.',
      observe: () => repeatStable(2, async (attempt) => {
        const path = scenarioPath(ctx, 'concurrent-transforms', attempt);
        const first = await createClient(ctx, `concurrent-transforms-${attempt}-first`);
        const second = await createClient(ctx, `concurrent-transforms-${attempt}-second`);
        try {
          const incrementPath = `${path}/increment`;
          await set(ref(first.db, incrementPath), 0);
          await Promise.all([
            update(ref(first.db, path), { increment: increment(2) }),
            update(ref(second.db, path), { increment: increment(3) }),
          ]);
          const transactionPath = `${path}/transaction`;
          await set(ref(first.db, transactionPath), 0);
          await Promise.all([get(ref(first.db, transactionPath)), get(ref(second.db, transactionPath))]);
          const firstArgs: unknown[] = [];
          const secondArgs: unknown[] = [];
          const results = await Promise.all([
            runTransaction(ref(first.db, transactionPath), (current) => {
              firstArgs.push(current);
              return ((current as number | null) ?? 0) + 1;
            }),
            runTransaction(ref(second.db, transactionPath), (current) => {
              secondArgs.push(current);
              return ((current as number | null) ?? 0) + 1;
            }),
          ]);
          return {
            incrementTerminal: await adminRead(ctx, incrementPath),
            transactionTerminal: await adminRead(ctx, transactionPath),
            committed: results.map((result) => result.committed),
            retryObserved: firstArgs.length > 1 || secondArgs.length > 1,
            invocationCountsSorted: [firstArgs.length, secondArgs.length].sort((a, b) => a - b),
            finalSnapshotsSorted: results.map((result) => result.snapshot.val()).sort(),
          };
        } finally {
          await cleanup([() => first.close(), () => second.close(), () => adminRemove(ctx, path)]);
        }
      }),
    },
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
          const constraintFactories = {
            orderByChild: orderByChild('value'),
            orderByKey: orderByKey(),
            orderByPriority: orderByPriority(),
            orderByValue: orderByValue(),
            startAt: startAt(1),
            startAfter: startAfter(1),
            endAt: endAt(1),
            endBefore: endBefore(1),
            equalTo: equalTo(1),
            limitToFirst: limitToFirst(1),
            limitToLast: limitToLast(1),
          };
          const constraint = constraintFactories.orderByKey;
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
            constraintFactories: Object.fromEntries(
              Object.entries(constraintFactories).map(([name, value]) => [
                name,
                prototypeShape(value, QueryConstraint),
              ]),
            ),
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
      matrixRow: 'rtdb-modular#100-105, rtdb-modular#174, rtdb-modular#M93',
      rowIds: [
        'rtdb-modular#100', 'rtdb-modular#101', 'rtdb-modular#102',
        'rtdb-modular#103', 'rtdb-modular#104', 'rtdb-modular#105',
        'rtdb-modular#174', 'rtdb-modular#M93',
      ],
      description:
        'Reference navigation/string shape, refFromURL validation, forged-reference failure timing, and a successful normal read control.',
      observe: () => repeatStable(2, async (attempt) => {
        const path = scenarioPath(ctx, 'reference-shape-url', attempt);
        const client = await createClient(ctx, `reference-shape-url-${attempt}`);
        const otherClient = await createClient(ctx, `reference-shape-url-other-${attempt}`);
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
          const constrained = query(nested, orderByValue(), startAt(1), endAt(2));
          const equivalent = query(nested, endAt(2), orderByValue(), startAt(1));
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
            queryIdentity: {
              referenceToJSON: referenceStringShape(nested.toJSON(), `${path}/parent/child`),
              queryToJSON: referenceStringShape(constrained.toJSON(), `${path}/parent/child`),
              sameReference: nested.isEqual(viaChild),
              defaultQueryEqualsReference: nested.isEqual(query(nested)),
              referenceEqualsDefaultQuery: query(nested).isEqual(nested),
              equivalentConstraintOrder: constrained.isEqual(equivalent),
              differentSpec: constrained.isEqual(query(nested, orderByValue(), startAt(2))),
              differentPath: nested.isEqual(ref(client.db, `${path}/other`)),
              differentApp: nested.isEqual(ref(otherClient.db, `${path}/parent/child`)),
              nullValue: nested.isEqual(null),
              nonQuery: nested.isEqual({} as never),
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
          await cleanup([() => client.close(), () => otherClient.close(), () => adminRemove(ctx, path)]);
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
      matrixRow: 'rtdb-modular#183, rtdb-modular#M92',
      rowIds: ['rtdb-modular#183', 'rtdb-modular#M92'],
      description:
        'Duplicate callback registration plus exact ref/query-view off() removal scope, with terminal state independently confirmed.',
      observe: () => repeatStable(2, async (attempt) => {
        const path = scenarioPath(ctx, 'off-duplicate-registration', attempt);
        const client = await createClient(ctx, `off-duplicate-registration-${attempt}`);
        try {
          const target = ref(client.db, path);
          await set(target, 0);
          const values: unknown[] = [];
          const controlValues: unknown[] = [];
          const callback = (snapshot: DataSnapshot) => values.push(snapshot.val());
          onValue(target, callback);
          onValue(target, callback);
          onValue(target, (snapshot) => controlValues.push(snapshot.val()));
          await waitFor('duplicate off initial readiness', () =>
            values.length === 2 && controlValues.at(-1) === 0);
          const afterInitial = [...values];
          await set(target, 1);
          await waitFor('duplicate off first write readiness', () =>
            values.length === 4 && controlValues.at(-1) === 1);
          const afterFirstWrite = [...values];
          off(target, 'value', callback);
          await set(target, 2);
          await waitFor('duplicate off first removal readiness', () =>
            values.length === 5 && controlValues.at(-1) === 2);
          const afterFirstOff = [...values];
          off(target, 'value', callback);
          await set(target, 3);
          await waitFor('duplicate off second removal readiness', () =>
            controlValues.at(-1) === 3);
          const queryTarget = ref(client.db, `${path}/query-scope`);
          await set(queryTarget, { a: { rank: 1 } });
          const defaultValues: unknown[] = [];
          const orderedValues: unknown[] = [];
          onValue(queryTarget, (snapshot) => defaultValues.push(snapshot.val()));
          onValue(query(queryTarget, orderByChild('rank')), (snapshot) => {
            orderedValues.push(snapshot.val());
          });
          await waitFor('query off initial readiness', () =>
            defaultValues.length === 1 && orderedValues.length === 1);
          off(query(queryTarget, orderByChild('rank')));
          await set(child(queryTarget, 'b'), { rank: 2 });
          await waitFor('query off exact-view readiness', () => defaultValues.length === 2);
          const afterQueryOff = {
            defaultCount: defaultValues.length,
            orderedCount: orderedValues.length,
          };
          const reorderedValues: unknown[] = [];
          const reorderedControl: unknown[] = [];
          onValue(query(queryTarget, orderByChild('rank'), startAt(1), endAt(3)), (snapshot) => {
            reorderedValues.push(snapshot.val());
          });
          onValue(queryTarget, (snapshot) => reorderedControl.push(snapshot.val()));
          await waitFor('reordered query off initial readiness', () =>
            reorderedValues.length === 1 && reorderedControl.length === 1);
          off(query(queryTarget, endAt(3), orderByChild('rank'), startAt(1)));
          await set(child(queryTarget, 'reordered'), { rank: 2 });
          await waitFor('reordered query off control readiness', () => reorderedControl.length === 2);
          const reorderedEquivalentStopped = reorderedValues.length === 1;
          const survivingQueryValues: unknown[] = [];
          onValue(query(queryTarget, orderByChild('rank')), (snapshot) => {
            survivingQueryValues.push(snapshot.val());
          });
          await waitFor('ref off query-survivor initial readiness', () =>
            survivingQueryValues.length === 1);
          off(queryTarget);
          const postRefOffControl: unknown[] = [];
          onValue(queryTarget, (snapshot) => postRefOffControl.push(snapshot.val()));
          await set(child(queryTarget, 'c'), { rank: 3 });
          await waitFor('ref off fresh-listener control readiness', () =>
            postRefOffControl.length === 2);
          const defaultTarget = ref(client.db, `${path}/default-equivalence`);
          await set(defaultTarget, 0);
          const referenceValues: unknown[] = [];
          onValue(defaultTarget, (snapshot) => referenceValues.push(snapshot.val()));
          await waitFor('default query equivalence initial readiness', () => referenceValues.length === 1);
          off(query(defaultTarget));
          const defaultControl: unknown[] = [];
          onValue(defaultTarget, (snapshot) => defaultControl.push(snapshot.val()));
          await set(defaultTarget, 1);
          await waitFor('default query equivalence control readiness', () => defaultControl.length === 2);
          return {
            afterInitial,
            afterFirstWrite,
            afterFirstOff,
            afterSecondOff: values,
            queryScope: {
              afterQueryOff,
              reorderedEquivalentStopped,
              defaultQueryStoppedReference: referenceValues.length === 1,
              constrainedStoppedByRefOff: survivingQueryValues.length === 1,
            },
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
