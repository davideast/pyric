/**
 * Runs one sequence against one plane and records what the application sees:
 * each step's result or error code, the ordered events of every listener, and
 * the final data of every instance.
 *
 * The interpreter calls only the `firebase/database` and `firebase/auth`
 * surface, so each plane hands it its own modules: `pyric/database` for the
 * in-page sandbox, and the served entries for the SharedWorker and Node hosts.
 */
import {
  INSTANCE_URLS,
  RULES_POOL,
  type JsonValue,
  type QuerySpec,
  type Sequence,
  type Step,
  type TransactionScript,
  type WriteValue,
} from './sequence.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFn = (...args: any[]) => any;

/** The `firebase/database` functions the interpreter calls. */
export interface DatabaseSurface {
  getDatabase: AnyFn; ref: AnyFn; set: AnyFn; update: AnyFn; push: AnyFn; remove: AnyFn;
  runTransaction: AnyFn; setPriority: AnyFn; setWithPriority: AnyFn; onDisconnect: AnyFn;
  goOffline: AnyFn; goOnline: AnyFn; get: AnyFn; query: AnyFn;
  onValue: AnyFn; onChildAdded: AnyFn; onChildChanged: AnyFn; onChildRemoved: AnyFn; onChildMoved: AnyFn;
  orderByKey: AnyFn; orderByValue: AnyFn; orderByPriority: AnyFn; orderByChild: AnyFn;
  startAt: AnyFn; startAfter: AnyFn; endAt: AnyFn; endBefore: AnyFn; equalTo: AnyFn;
  limitToFirst: AnyFn; limitToLast: AnyFn;
  serverTimestamp: AnyFn; increment: AnyFn;
}

/** The `firebase/auth` functions the interpreter calls. */
export interface AuthSurface {
  getAuth: AnyFn; signInWithCustomToken: AnyFn; signInAnonymously: AnyFn; signOut: AnyFn;
}

/** One plane, opened fresh for one sequence. */
export interface PlaneSession {
  database: DatabaseSurface;
  auth: AuthSurface;
  app: unknown;
  /** Deploy a ruleset to instance `db` as the plane's host deploys rules. */
  setRules(db: number, rules: { rules: Record<string, unknown> }): Promise<void>;
  /** The instance's whole tree, read past the rules. */
  dump(db: number): Promise<unknown>;
  /** Wait until every reply and event the last step caused has been delivered. */
  settle(): Promise<void>;
  close(): Promise<void>;
}

export type StepResult = { ok: unknown } | { error: string };

export interface Trace {
  seed: number;
  steps: StepResult[];
  events: Record<string, unknown[]>;
  data: unknown[];
  /** Anonymous uids, in the order the sequence minted them. */
  anonymous: string[];
  /** Push keys the sequence minted, in order. */
  pushed: string[];
}

/** What an application can read from an error: its `code`, if any, and its message. */
export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  const message = String((error as { message?: unknown })?.message ?? error);
  const codeText = code === undefined ? 'none' : String(code);
  return `code=${codeText}; ${message.slice(0, 200)}`;
}

function materialize(database: DatabaseSurface, value: WriteValue): unknown {
  if (Array.isArray(value)) return value.map((item) => materialize(database, item));
  if (value !== null && typeof value === 'object') {
    if (value['$ts'] === true) return database.serverTimestamp();
    if (typeof value['$inc'] === 'number') return database.increment(value['$inc']);
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = materialize(database, child);
    return out;
  }
  return value;
}

function constraints(database: DatabaseSurface, spec: QuerySpec): unknown[] {
  const out: unknown[] = [];
  const orderBy = spec.orderBy;
  if (orderBy === 'key') out.push(database.orderByKey());
  else if (orderBy === 'value') out.push(database.orderByValue());
  else if (orderBy === 'priority') out.push(database.orderByPriority());
  else out.push(database.orderByChild(orderBy.child));
  const bounds: Array<[keyof QuerySpec, AnyFn]> = [
    ['startAt', database.startAt], ['startAfter', database.startAfter],
    ['endAt', database.endAt], ['endBefore', database.endBefore], ['equalTo', database.equalTo],
  ];
  for (const [name, make] of bounds) {
    const bound = spec[name] as { value: JsonValue; key?: string } | undefined;
    if (bound === undefined) continue;
    out.push(bound.key === undefined ? make(bound.value) : make(bound.value, bound.key));
  }
  if (spec.limitToFirst !== undefined) out.push(database.limitToFirst(spec.limitToFirst));
  if (spec.limitToLast !== undefined) out.push(database.limitToLast(spec.limitToLast));
  return out;
}

function transactionUpdate(
  script: TransactionScript,
  contend: () => void,
): (current: unknown) => unknown {
  switch (script) {
    case 'increment': return (current) => (typeof current === 'number' ? current + 1 : 1);
    case 'abort': return () => undefined;
    case 'createOnly': return (current) => (current === null ? { created: true } : undefined);
    case 'replaceObject': return (current) => ({
      n: 7, prev: typeof current === 'number' || typeof current === 'string' ? current : null,
    });
    case 'delete': return () => null;
    case 'contend': {
      // Another writer changes the location while the transaction runs, once.
      let contended = false;
      return (current) => {
        if (!contended && current !== null) {
          contended = true;
          contend();
        }
        return typeof current === 'number' ? current + 1 : 1;
      };
    }
  }
}

export async function runSequence(sequence: Sequence, session: PlaneSession): Promise<Trace> {
  const { database, auth: authModule, app } = session;
  const auth = authModule.getAuth(app);
  const handles: unknown[] = [];
  for (let i = 0; i < sequence.instances; i++) {
    const url = INSTANCE_URLS[i];
    handles.push(url === undefined ? database.getDatabase(app) : database.getDatabase(app, url));
  }
  for (let i = 0; i < sequence.instances; i++) {
    await session.setRules(i, RULES_POOL[sequence.initialRules[i]!]!);
  }
  await session.settle();

  const steps: StepResult[] = [];
  const events: Record<string, unknown[]> = {};
  const listeners = new Map<number, () => void>();
  const anonymous: string[] = [];
  const pushed: string[] = [];
  let uid: string | null = null;

  const pathOf = (path: string) => path.replace('$me', uid ?? 'nobody');
  const refAt = (db: number, path: string) => database.ref(handles[db], pathOf(path) || undefined);
  const target = (db: number, path: string, spec?: QuerySpec) => {
    const reference = refAt(db, path);
    return spec === undefined ? reference : database.query(reference, ...constraints(database, spec));
  };

  async function run(step: Step): Promise<unknown> {
    switch (step.op) {
      case 'set': await database.set(refAt(step.db, step.path), materialize(database, step.value)); return null;
      case 'update': await database.update(refAt(step.db, step.path), materialize(database, step.values)); return null;
      case 'push': {
        const pushedRef = step.value === undefined
          ? database.push(refAt(step.db, step.path))
          : database.push(refAt(step.db, step.path), materialize(database, step.value));
        pushed.push(pushedRef.key);
        await pushedRef;
        return pushedRef.key;
      }
      case 'remove': await database.remove(refAt(step.db, step.path)); return null;
      case 'transaction': {
        const reference = refAt(step.db, step.path);
        const update = transactionUpdate(step.script, () => {
          void database.set(reference, 100).catch(() => undefined);
        });
        const result = await database.runTransaction(
          reference,
          update,
          step.applyLocally === undefined ? undefined : { applyLocally: step.applyLocally },
        );
        return { committed: result.committed, value: result.snapshot.exportVal() };
      }
      case 'setPriority': await database.setPriority(refAt(step.db, step.path), step.priority); return null;
      case 'setWithPriority':
        await database.setWithPriority(refAt(step.db, step.path), materialize(database, step.value), step.priority);
        return null;
      case 'onDisconnectSet': {
        const handle = database.onDisconnect(refAt(step.db, step.path));
        const value = materialize(database, step.value);
        if (step.priority === undefined) await handle.set(value);
        else await handle.setWithPriority(value, step.priority);
        return null;
      }
      case 'onDisconnectUpdate':
        await database.onDisconnect(refAt(step.db, step.path)).update(materialize(database, step.values));
        return null;
      case 'onDisconnectRemove': await database.onDisconnect(refAt(step.db, step.path)).remove(); return null;
      case 'onDisconnectCancel': await database.onDisconnect(refAt(step.db, step.path)).cancel(); return null;
      case 'reconnect':
        database.goOffline(handles[step.db]);
        await session.settle();
        database.goOnline(handles[step.db]);
        return null;
      case 'listen': {
        const log: unknown[] = [];
        events[`L${step.id} ${step.event} db${step.db} /${step.path}${step.query ? ` ${JSON.stringify(step.query)}` : ''}`] = log;
        const cancel = (error: unknown) => { log.push({ cancel: errorCode(error) }); };
        const subject = target(step.db, step.path, step.query);
        let unsubscribe: () => void;
        if (step.event === 'value') {
          unsubscribe = database.onValue(subject, (snapshot: any) => { log.push({ value: snapshot.exportVal() }); }, cancel);
        } else {
          const subscribe = {
            child_added: database.onChildAdded,
            child_changed: database.onChildChanged,
            child_removed: database.onChildRemoved,
            child_moved: database.onChildMoved,
          }[step.event];
          unsubscribe = subscribe(subject, (snapshot: any, previous?: string | null) => {
            log.push({ key: snapshot.key, value: snapshot.exportVal(), previous: previous ?? null });
          }, cancel);
        }
        listeners.set(step.id, unsubscribe);
        return null;
      }
      case 'unlisten': {
        listeners.get(step.id)?.();
        listeners.delete(step.id);
        return null;
      }
      case 'get': {
        const snapshot = await database.get(target(step.db, step.path, step.query));
        return snapshot.exportVal();
      }
      case 'signIn': {
        const token = JSON.stringify(step.claims === undefined ? { uid: step.uid } : { uid: step.uid, claims: step.claims });
        const credential = await authModule.signInWithCustomToken(auth, token);
        uid = credential.user.uid;
        return uid;
      }
      case 'signInAnonymously': {
        const credential = await authModule.signInAnonymously(auth);
        uid = credential.user.uid;
        anonymous.push(credential.user.uid);
        return uid;
      }
      case 'signOut': await authModule.signOut(auth); uid = null; return null;
      case 'refreshToken': {
        const user = auth.currentUser;
        if (!user) return 'signed out';
        await user.getIdToken(true);
        return 'refreshed';
      }
      case 'rules': await session.setRules(step.db, RULES_POOL[step.rules]!); return null;
    }
  }

  for (const step of sequence.steps) {
    try {
      steps.push({ ok: (await run(step)) ?? null });
    } catch (error) {
      steps.push({ error: errorCode(error) });
    }
    await session.settle();
  }

  const data: unknown[] = [];
  for (let i = 0; i < sequence.instances; i++) data.push(await session.dump(i));
  for (const unsubscribe of listeners.values()) unsubscribe();
  return { seed: sequence.seed, steps, events, data, anonymous, pushed };
}
