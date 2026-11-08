/**
 * A local probe world: one Pyric sandbox with the app's rules installed,
 * seeded state, and one SDK handle per actor, so an owner's setup and a
 * peer's probe run against shared data. Everything is in-process; nothing
 * leaves the machine.
 */
// `firestore/instances.ts` and `database/instances.ts` check `instanceof SandboxContextImpl`
// against `pyric/sandbox`, so `initializeSandbox` must share that module identity.
import { initializeSandbox, type AuthState, type LocalSandbox } from 'pyric/sandbox';
import {
  get,
  getAdminDatabase,
  getDatabase,
  increment as rtdbIncrement,
  ref,
  remove,
  sandbox as rtdbSandbox,
  serverTimestamp as rtdbServerTimestamp,
  set,
  update,
  type Database,
} from '../../database/index.js';
import {
  arrayRemove,
  arrayUnion,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getFirestore,
  increment as fsIncrement,
  serverTimestamp as fsServerTimestamp,
  setDoc,
  updateDoc,
  type DocumentData,
  type Firestore,
} from '../../firestore/index.js';
import { seedDocuments, setRules, snapshotDocuments } from '../../firestore/sandbox-controls.js';
import { isSentinel } from './fixtures.js';
import type { ProbeActor, ProbeStep, StepResult } from './types.js';

export interface WorldRules {
  firestore?: string;
  rtdb?: unknown;
}

export interface WorldState {
  rtdb?: unknown;
  firestore?: Record<string, Record<string, unknown>>;
}

interface Handles {
  rtdb?: Database;
  firestore?: Firestore;
}

const DENIED = /permission[-_ ]denied/i;

function isRulesJson(value: unknown): value is { rules: Record<string, unknown> } {
  if (!value || typeof value !== 'object') return false;
  if (!Object.hasOwn(value, 'rules')) return false;
  const inner = (value as { rules?: unknown }).rules;
  return Boolean(inner && typeof inner === 'object' && !Array.isArray(inner));
}

function buildActorAuth(actor: ProbeActor): AuthState {
  const emailVerified = actor.token.email_verified ?? true;
  return {
    uid: actor.uid,
    token: {
      ...actor.token,
      email: actor.email,
      email_verified: emailVerified,
      name: actor.displayName,
    },
  };
}

export class ProbeWorld {
  private readonly sandbox: LocalSandbox;
  private readonly handles = new Map<string, Handles>();
  private readonly admin: Handles = {};

  constructor(
    private readonly rules: WorldRules,
    actors: ProbeActor[],
    state: WorldState = {},
  ) {
    this.sandbox = initializeSandbox();
    for (const actor of actors) {
      const ctx = this.sandbox.withAuth(buildActorAuth(actor));
      const handles: Handles = {};
      if (rules.rtdb) handles.rtdb = getDatabase(ctx);
      if (rules.firestore) handles.firestore = getFirestore(ctx);
      this.handles.set(actor.role, handles);
    }
    if (rules.rtdb) {
      const firstRtdb = [...this.handles.values()][0]?.rtdb;
      if (firstRtdb && isRulesJson(rules.rtdb)) {
        rtdbSandbox.setRules(firstRtdb, rules.rtdb);
      }
      this.admin.rtdb = getAdminDatabase(this.sandbox);
      rtdbSandbox.setData(this.admin.rtdb, { '/': state.rtdb ?? {} });
    }
    if (rules.firestore) {
      setRules(this.sandbox, rules.firestore);
      if (state.firestore) seedDocuments(this.sandbox, state.firestore);
    }
  }

  dispose(): void {
    this.sandbox.dispose();
  }

  /** Run one step and classify the result. */
  async run(step: ProbeStep): Promise<StepResult> {
    try {
      if (step.service === 'rtdb') await this.runRtdb(step);
      else await this.runFirestore(step);
      return { step, decision: 'allow' };
    } catch (e) {
      const code = String((e as { code?: unknown })?.code ?? '');
      let message = String(e);
      if (e instanceof Error) message = e.message;
      if (DENIED.test(code) || DENIED.test(message)) {
        return { step, decision: 'deny', message: message.slice(0, 200) };
      }
      return { step, decision: 'error', message: message.slice(0, 200) };
    }
  }

  private rtdbFor(step: ProbeStep): Database {
    let db = this.handles.get(step.actor)?.rtdb;
    if (step.actor === 'admin') db = this.admin.rtdb;
    if (!db) throw new Error('no Realtime Database rules in this world');
    return db;
  }

  private firestoreFor(step: ProbeStep): Firestore {
    let actorRole = step.actor;
    if (step.actor === 'admin') actorRole = 'owner';
    const db = this.handles.get(actorRole)?.firestore;
    if (!db) throw new Error('no Firestore rules in this world');
    return db;
  }

  private async runRtdb(step: ProbeStep): Promise<void> {
    const db = this.rtdbFor(step);
    const r = ref(db, step.path);
    const data = toRtdb(step.data);
    if (step.method === 'remove' || step.method === 'delete') await remove(r);
    else if (step.method === 'update') await update(r, data as Record<string, unknown>);
    else if (step.method === 'get') await get(r);
    else await set(r, data);
  }

  private async runFirestore(step: ProbeStep): Promise<void> {
    if (step.actor === 'admin') {
      if (step.method === 'delete' || step.method === 'remove') {
        throw new Error('admin delete is not modelled');
      }
      const existing = snapshotDocuments(this.sandbox);
      const nextDoc = toPlain(step.data) as DocumentData;
      seedDocuments(this.sandbox, { ...existing, [step.path]: nextDoc });
      return;
    }
    const db = this.firestoreFor(step);
    const d = doc(db, step.path);
    const data = toFirestore(step.data) as Record<string, unknown>;
    if (step.method === 'delete' || step.method === 'remove') await deleteDoc(d);
    else if (step.method === 'update') await updateDoc(d, data);
    else if (step.method === 'get') await getDoc(d);
    else if (step.merge) await setDoc(d, data, { merge: true });
    else await setDoc(d, data);
  }
}

function mapValues(v: unknown, f: (x: unknown) => unknown): unknown {
  if (isSentinel(v)) return f(v);
  if (Array.isArray(v)) return v.map((x) => mapValues(x, f));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapValues(x, f)]));
  }
  return v;
}

function toRtdb(v: unknown): unknown {
  return mapValues(v, (s) => {
    if (!isSentinel(s)) return s;
    if (s.__sentinel === 'serverTimestamp') return rtdbServerTimestamp();
    if (s.__sentinel === 'increment') return rtdbIncrement(s.by ?? 1);
    if (s.__sentinel === 'deleteField') return null;
    return [];
  });
}

function toFirestore(v: unknown): unknown {
  return mapValues(v, (s) => {
    if (!isSentinel(s)) return s;
    if (s.__sentinel === 'serverTimestamp') return fsServerTimestamp();
    if (s.__sentinel === 'increment') return fsIncrement(s.by ?? 1);
    if (s.__sentinel === 'arrayUnion') return arrayUnion('s-v');
    if (s.__sentinel === 'arrayRemove') return arrayRemove('s-v');
    return deleteField();
  });
}

/** Seed data can't carry SDK sentinels: timestamps become a number, increments their delta. */
function toPlain(v: unknown): unknown {
  return mapValues(v, (s) => {
    if (!isSentinel(s)) return s;
    if (s.__sentinel === 'serverTimestamp') return 1_700_000_000_000;
    if (s.__sentinel === 'increment') return s.by ?? 0;
    if (s.__sentinel === 'arrayUnion') return ['s-v'];
    return null;
  });
}

export { toPlain };
