/**
 * A local probe world: one Pyric sandbox with the app's rules installed,
 * seeded state restored through the canonical `SandboxSnapshot` pipeline,
 * and one SDK handle per actor, so an owner's setup and a peer's probe run
 * against shared data. Everything is in-process; nothing leaves the machine.
 */
// `firestore/instances.ts`, `database/instances.ts`, and `storage/service.ts`
// check `instanceof SandboxImpl` / `SandboxContextImpl` against `pyric/sandbox`,
// so `initializeSandbox` and internal snapshot helpers share that module identity.
import {
  initializeSandbox,
  type AuthState,
  type LocalSandbox,
  type SandboxContext,
} from 'pyric/sandbox';
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  decodeSnapshotMapForEnv,
  encodeSnapshotMap,
  getInternalEnv,
  restoreSandboxSnapshot,
  type EncodedMap,
  type SandboxSnapshot,
  type SnapshotStorageObject,
  type SnapshotUserRecord,
} from 'pyric/sandbox/internal';
import { getAdminStorageSandbox } from 'pyric/storage/internal';
import {
  get,
  getAdminDatabase,
  getDatabase,
  increment as rtdbIncrement,
  ref,
  remove,
  serverTimestamp as rtdbServerTimestamp,
  set,
  update,
  type Database,
} from 'pyric/database';
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
  type Firestore,
} from 'pyric/firestore';
import { Reference as RulesReference } from 'pyric/rules/internal';
import { lowerModularRulesInMemory } from '../rules/rules-ast-utils.js';
import { isSentinel } from './fixtures.js';
import type { ProbeActor, ProbeStep, StepResult } from './types.js';
import {
  executeWorldStorageStep,
  nextProbeWorldStorageDbName,
  populateWorldStorageRules,
  type WorldStorageRules,
} from './world-storage.js';

export interface WorldRules {
  firestore?: string;
  rtdb?: unknown;
  storage?: WorldStorageRules;
}

export interface WorldState {
  rtdb?: unknown;
  firestore?: Record<string, Record<string, unknown>>;
  storage?: readonly SnapshotStorageObject[];
  snapshot?: SandboxSnapshot;
}

interface Handles {
  rtdb?: Database;
  firestore?: Firestore;
}

const DENIED = /permission[-_ ]?denied|unauthorized/i;

function isRulesJson(value: unknown): value is { rules: Record<string, unknown> } {
  if (!value || typeof value !== 'object') return false;
  if (!Object.hasOwn(value, 'rules')) return false;
  const inner = (value as { rules?: unknown }).rules;
  return Boolean(inner && typeof inner === 'object' && !Array.isArray(inner));
}

function defineOwnWorldField<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function normalizeLegacyDocuments(
  documents: Record<string, Record<string, unknown>>,
): Record<string, EncodedMap> {
  const encoded: Record<string, EncodedMap> = {};
  for (const [rawPath, docData] of Object.entries(documents)) {
    const cleanPath = rawPath.replace(/^\/+|\/+$/g, '');
    if (cleanPath.length === 0) continue;
    defineOwnWorldField(encoded, cleanPath, encodeSnapshotMap(docData));
  }
  return encoded;
}

function buildWorldSnapshot(rules: WorldRules, state: WorldState): SandboxSnapshot {
  const base = state.snapshot;

  const firestoreRules: Record<string, string> = Object.assign({}, base?.rules.firestore);
  for (const [dbKey, dbSource] of Object.entries(firestoreRules)) {
    if (typeof dbSource === 'string') {
      firestoreRules[dbKey] = lowerModularRulesInMemory(dbSource, {
        targetService: 'cloud.firestore',
      });
    }
  }
  if (rules.firestore !== undefined) {
    firestoreRules[DEFAULT_SNAPSHOT_RESOURCE] = lowerModularRulesInMemory(rules.firestore, {
      targetService: 'cloud.firestore',
    });
  }

  const rtdbRules: Record<string, string> = Object.assign({}, base?.rules.rtdb);
  if (typeof rules.rtdb === 'string') {
    rtdbRules[DEFAULT_SNAPSHOT_RESOURCE] = rules.rtdb;
  } else if (isRulesJson(rules.rtdb)) {
    rtdbRules[DEFAULT_SNAPSHOT_RESOURCE] = JSON.stringify(rules.rtdb);
  }

  const storageRules: Record<string, string> = Object.assign({}, base?.rules.storage);
  populateWorldStorageRules(storageRules, rules.storage);

  const snapshotRules: {
    firestore?: Record<string, string>;
    rtdb?: Record<string, string>;
    storage?: Record<string, string>;
  } = {};
  if (Object.keys(firestoreRules).length > 0) snapshotRules.firestore = firestoreRules;
  if (Object.keys(rtdbRules).length > 0) snapshotRules.rtdb = rtdbRules;
  if (Object.keys(storageRules).length > 0) snapshotRules.storage = storageRules;

  const firestore: Record<string, Readonly<Record<string, EncodedMap>>> = Object.assign(
    {},
    base?.firestore,
  );
  if (state.firestore !== undefined) {
    firestore[DEFAULT_SNAPSHOT_RESOURCE] = normalizeLegacyDocuments(state.firestore);
  } else if (!Object.hasOwn(firestore, DEFAULT_SNAPSHOT_RESOURCE)) {
    firestore[DEFAULT_SNAPSHOT_RESOURCE] = {};
  }

  const rtdb: Record<string, unknown> = Object.assign({}, base?.rtdb);
  if (state.rtdb !== undefined) {
    rtdb[DEFAULT_SNAPSHOT_RESOURCE] = state.rtdb;
  } else if (Boolean(rules.rtdb) && !Object.hasOwn(rtdb, DEFAULT_SNAPSHOT_RESOURCE)) {
    rtdb[DEFAULT_SNAPSHOT_RESOURCE] = {};
  }

  const storage: Record<string, readonly SnapshotStorageObject[]> = Object.assign(
    {},
    base?.storage,
  );
  if (state.storage !== undefined) {
    storage[DEFAULT_SNAPSHOT_RESOURCE] = state.storage;
  }

  const auth: SandboxSnapshot['auth'] =
    base?.auth.providers !== undefined
      ? { users: base.auth.users, providers: base.auth.providers }
      : { users: base?.auth.users ?? [] };

  return {
    version: 1,
    rules: snapshotRules,
    auth,
    firestore,
    rtdb,
    storage,
    ...(base?.storageConfig !== undefined ? { storageConfig: base.storageConfig } : {}),
  };
}

function buildActorAuth(
  actor: ProbeActor,
  snapshotUsers: readonly SnapshotUserRecord[],
): AuthState {
  const matched = snapshotUsers.find((user) => user.uid === actor.uid);
  let emailVerified = true;
  if (typeof actor.token.email_verified === 'boolean') {
    emailVerified = actor.token.email_verified;
  } else if (typeof matched?.emailVerified === 'boolean') {
    emailVerified = matched.emailVerified;
  }
  let email = actor.email;
  if (!email && matched?.email) email = matched.email;
  let name = actor.displayName;
  if (!name && matched?.displayName) name = matched.displayName;

  const token: Record<string, unknown> = {};
  if (matched?.customClaims !== undefined) {
    for (const key of Object.getOwnPropertyNames(matched.customClaims)) {
      defineOwnWorldField(
        token,
        key,
        Object.getOwnPropertyDescriptor(matched.customClaims, key)?.value,
      );
    }
  }
  for (const key of Object.getOwnPropertyNames(actor.token)) {
    defineOwnWorldField(
      token,
      key,
      Object.getOwnPropertyDescriptor(actor.token, key)?.value,
    );
  }
  defineOwnWorldField(token, 'email', email);
  defineOwnWorldField(token, 'email_verified', emailVerified);
  defineOwnWorldField(token, 'name', name);

  if (matched?.tenantId !== undefined || matched?.providerId !== undefined) {
    let existingFirebase: Record<string, unknown> = {};
    if (
      token.firebase !== null &&
      typeof token.firebase === 'object' &&
      !Array.isArray(token.firebase)
    ) {
      existingFirebase = token.firebase as Record<string, unknown>;
    }
    const firebaseClaim: Record<string, unknown> = { ...existingFirebase };
    if (matched.tenantId !== undefined && firebaseClaim.tenant === undefined) {
      firebaseClaim.tenant = matched.tenantId;
    }
    if (matched.providerId !== undefined && firebaseClaim.sign_in_provider === undefined) {
      firebaseClaim.sign_in_provider = matched.providerId;
    }
    token.firebase = firebaseClaim;
  }

  return { uid: actor.uid, token };
}

export class ProbeWorld {
  private readonly sandbox: LocalSandbox;
  private readonly handles = new Map<string, Handles>();
  private readonly actorContexts = new Map<string, SandboxContext>();
  private readonly disabledRoles = new Set<string>();
  private readonly admin: Handles = {};
  private readonly hasStorage: boolean;
  private readonly initOutcome: Promise<Error | null>;

  constructor(
    rules: WorldRules,
    actors: ProbeActor[],
    state: WorldState = {},
  ) {
    this.sandbox = initializeSandbox();
    const snapshot = buildWorldSnapshot(rules, state);
    const hasFirestore =
      Boolean(rules.firestore) ||
      Boolean(snapshot.rules.firestore?.[DEFAULT_SNAPSHOT_RESOURCE]);
    const hasRtdb =
      Boolean(rules.rtdb) ||
      Boolean(snapshot.rules.rtdb?.[DEFAULT_SNAPSHOT_RESOURCE]) ||
      Object.keys(snapshot.rtdb).length > 0;
    this.hasStorage =
      Boolean(rules.storage) ||
      Object.keys(snapshot.rules.storage ?? {}).length > 0 ||
      Object.keys(snapshot.storage).length > 0;

    if (hasRtdb) {
      this.admin.rtdb = getAdminDatabase(this.sandbox);
    }
    if (this.hasStorage) {
      getAdminStorageSandbox(this.sandbox, {
        dbName: nextProbeWorldStorageDbName(),
      });
    }

    for (const actor of actors) {
      const matchedUser = snapshot.auth.users.find((u) => u.uid === actor.uid);
      if (actor.disabled === true || matchedUser?.disabled === true) {
        this.disabledRoles.add(actor.role);
      }
      const ctx = this.sandbox.withAuth(buildActorAuth(actor, snapshot.auth.users));
      this.actorContexts.set(actor.role, ctx);
      const handles: Handles = {};
      if (hasRtdb) handles.rtdb = getDatabase(ctx);
      if (hasFirestore) handles.firestore = getFirestore(ctx);
      this.handles.set(actor.role, handles);
    }

    this.initOutcome = this.restoreInitialSnapshot(snapshot);
  }

  static async create(
    rules: WorldRules,
    actors: ProbeActor[],
    state: WorldState = {},
  ): Promise<ProbeWorld> {
    const world = new ProbeWorld(rules, actors, state);
    try {
      await world.ready();
      return world;
    } catch (error) {
      world.dispose();
      throw error;
    }
  }

  async ready(): Promise<void> {
    const error = await this.initOutcome;
    if (error !== null) throw error;
  }

  dispose(): void {
    this.sandbox.dispose();
  }

  /** Run one step and classify the result. */
  async run(step: ProbeStep): Promise<StepResult> {
    try {
      await this.ready();
      if (step.actor !== 'admin' && this.disabledRoles.has(step.actor)) {
        return { step, decision: 'error', message: 'auth/user-disabled' };
      }
      if (step.service === 'rtdb') await this.runRtdb(step);
      else if (step.service === 'storage') await this.runStorage(step);
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

  private async restoreInitialSnapshot(snapshot: SandboxSnapshot): Promise<Error | null> {
    try {
      const { refusals } = await restoreSandboxSnapshot(this.sandbox, snapshot);
      if (refusals.length > 0) {
        return new Error(refusals.join('; '));
      }
      return null;
    } catch (error) {
      if (error instanceof Error) return error;
      return new Error(String(error));
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
      const cleanPath = step.path.replace(/^\/+|\/+$/g, '');
      const plainData = toPlain(step.data);
      let plainRecord: Record<string, unknown> = {};
      if (plainData !== null && typeof plainData === 'object' && !Array.isArray(plainData)) {
        plainRecord = plainData as Record<string, unknown>;
      }
      getInternalEnv(this.sandbox).adminSetDocument(
        cleanPath,
        decodeSnapshotMapForEnv(encodeSnapshotMap(plainRecord)),
      );
      return;
    }
    const db = this.firestoreFor(step);
    const d = doc(db, step.path);
    const data = toFirestore(step.data, db) as Record<string, unknown>;
    if (step.method === 'delete' || step.method === 'remove') await deleteDoc(d);
    else if (step.method === 'update') await updateDoc(d, data);
    else if (step.method === 'get') await getDoc(d);
    else if (step.method === 'create') {
      const cleanPath = step.path.replace(/^\/+|\/+$/g, '');
      if (Object.hasOwn(getInternalEnv(this.sandbox).snapshot(), cleanPath)) {
        throw new Error(`Document already exists: ${cleanPath}`);
      }
      await setDoc(d, data);
    } else if (step.merge) await setDoc(d, data, { merge: true });
    else await setDoc(d, data);
  }

  private async runStorage(step: ProbeStep): Promise<void> {
    await executeWorldStorageStep(this.sandbox, this.actorContexts, this.hasStorage, step);
  }
}

function mapValues(v: unknown, f: (x: unknown) => unknown): unknown {
  if (isSentinel(v) || v instanceof RulesReference) return f(v);
  if (Array.isArray(v)) return v.map((x) => mapValues(x, f));
  if (v !== null && typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        defineOwnWorldField(out, k, mapValues(x, f));
      }
      return out;
    }
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

function toFirestore(v: unknown, db: Firestore): unknown {
  return mapValues(v, (s) => {
    if (s instanceof RulesReference) {
      const rawPath = s.path
        .replace(/^projects\/[^/]+\/databases\/[^/]+\/documents\//, '')
        .replace(/^\/+|\/+$/g, '');
      return doc(db, rawPath);
    }
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
