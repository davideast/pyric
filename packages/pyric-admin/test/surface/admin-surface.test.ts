/**
 * `pyric-admin` public surface against the installed `firebase-admin`.
 *
 * The expected names come from `firebase-admin`'s type declarations
 * (`upstream-surface.ts`); the actual ones from live `pyric-admin` modules
 * and objects, so a member is checked where a caller reaches it: a method on
 * a `File` handle `bucket.file()` returned, not a name in a `.d.ts`.
 *
 * Every upstream name is in exactly one state:
 *   - implemented: present on the `pyric-admin` module or object;
 *   - deferred: present as a not-implemented stub (`isDeferredApi`), which
 *     throws or rejects a `PyricDeferredApiError` naming the member;
 *   - allowlisted: absent, and listed in `surface-allowlist.ts` with a reason.
 *
 * Anything else is absent and would read as `undefined` at the call site, so
 * the check fails and names the entry point and member. An allowlist row for
 * a name that is now present, or that upstream no longer has, also fails, so
 * the allowlist only shrinks as the surface grows.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { initializeSandbox, type RemoteSandboxChannel } from 'pyric/sandbox';
import { isDeferredApi, PyricDeferredApiError } from 'pyric/app/internal';
import { createRemoteSandboxHandle } from '../../../cli/src/remote/index.js';

import * as rootEntry from '../../src/index.js';
import * as appEntry from '../../src/app/index.js';
import * as authEntry from '../../src/auth/index.js';
import * as databaseEntry from '../../src/database/index.js';
import * as firestoreEntry from '../../src/firestore/index.js';
import * as storageEntry from '../../src/storage/index.js';
import * as messagingEntry from '../../src/messaging/index.js';
import { ALLOWLIST } from './surface-allowlist.js';
import { firebaseAdminVersion, loadUpstreamSurface, type PathStep } from './upstream-surface.js';

/** Upstream entry points whose `pyric-admin` subpath is a deferred entry. */
const DEFERRED_ENTRIES = [
  'app-check',
  'data-connect',
  'eventarc',
  'extensions',
  'functions',
  'installations',
  'instance-id',
  'machine-learning',
  'phone-number-verification',
  'project-management',
  'remote-config',
  'security-rules',
] as const;

const MIRRORED_ENTRIES = ['.', 'app', 'auth', 'database', 'firestore', 'storage', 'messaging'] as const;

type Module = Record<string, unknown>;

/** The live handles one arm hands out. */
interface Arm {
  readonly name: 'local' | 'remote';
  readonly app: appEntry.PyricAdminApp;
}

/**
 * One object a caller reaches, checked against the upstream type `path`
 * reaches. `make` returns the live `pyric-admin` object on one arm.
 */
interface Probe {
  readonly entry: string;
  readonly owner: string;
  readonly path: readonly PathStep[];
  readonly make: (arm: Arm) => unknown;
  /** The probe reads data, so it runs on the local arm only. */
  readonly localOnly?: boolean;
}

const fs = (arm: Arm) => firestoreEntry.getFirestore(arm.app);
const db = (arm: Arm) => databaseEntry.getDatabase(arm.app) as unknown as {
  ref(path?: string): { get(): Promise<unknown> };
};

const PROBES: readonly Probe[] = [
  // Root namespace: `admin.firestore.FieldValue`, `admin.credential.cert`, ...
  { entry: '.', owner: 'admin.auth', path: [{ static: 'auth' }], make: () => rootEntry.default.auth },
  { entry: '.', owner: 'admin.credential', path: [{ static: 'credential' }], make: () => rootEntry.default.credential },
  { entry: '.', owner: 'admin.database', path: [{ static: 'database' }], make: () => rootEntry.default.database },
  { entry: '.', owner: 'admin.firestore', path: [{ static: 'firestore' }], make: () => rootEntry.default.firestore },
  { entry: '.', owner: 'admin.messaging', path: [{ static: 'messaging' }], make: () => rootEntry.default.messaging },
  { entry: '.', owner: 'admin.storage', path: [{ static: 'storage' }], make: () => rootEntry.default.storage },

  { entry: 'app', owner: 'App', path: ['initializeApp'], make: (arm) => arm.app },

  { entry: 'auth', owner: 'Auth', path: ['getAuth'], make: (arm) => authEntry.getAuth(arm.app) },
  {
    entry: 'auth',
    owner: 'UserRecord',
    path: ['getAuth', { awaited: 'createUser' }],
    make: (arm) => authEntry.getAuth(arm.app).createUser({}),
    localOnly: true,
  },

  { entry: 'database', owner: 'Database', path: ['getDatabase'], make: (arm) => databaseEntry.getDatabase(arm.app) },
  { entry: 'database', owner: 'Reference', path: ['getDatabase', 'ref'], make: (arm) => db(arm).ref('surface') },
  {
    entry: 'database',
    owner: 'DataSnapshot',
    path: ['getDatabase', 'ref', { awaited: 'get' }],
    make: (arm) => db(arm).ref('surface').get(),
    localOnly: true,
  },
  { entry: 'database', owner: 'ServerValue', path: [{ static: 'ServerValue' }], make: () => databaseEntry.ServerValue },

  { entry: 'firestore', owner: 'Firestore', path: ['getFirestore'], make: fs },
  { entry: 'firestore', owner: 'CollectionReference', path: ['getFirestore', 'collection'], make: (arm) => fs(arm).collection('surface') },
  { entry: 'firestore', owner: 'DocumentReference', path: ['getFirestore', 'doc'], make: (arm) => fs(arm).doc('surface/doc') },
  {
    entry: 'firestore',
    owner: 'Query',
    path: ['getFirestore', 'collection', 'where'],
    make: (arm) => fs(arm).collection('surface').where('a', '==', 1),
  },
  {
    entry: 'firestore',
    owner: 'DocumentSnapshot',
    path: ['getFirestore', 'doc', { awaited: 'get' }],
    make: (arm) => fs(arm).doc('surface/doc').get(),
    localOnly: true,
  },
  {
    entry: 'firestore',
    owner: 'QuerySnapshot',
    path: ['getFirestore', 'collection', { awaited: 'get' }],
    make: (arm) => fs(arm).collection('surface').get(),
    localOnly: true,
  },
  { entry: 'firestore', owner: 'WriteBatch', path: ['getFirestore', 'batch'], make: (arm) => fs(arm).batch() },
  {
    entry: 'firestore',
    owner: 'Transaction',
    path: ['Transaction'],
    make: (arm) => fs(arm).runTransaction(async (tx) => tx),
    localOnly: true,
  },
  { entry: 'firestore', owner: 'FieldValue', path: [{ static: 'FieldValue' }], make: () => firestoreEntry.FieldValue },
  { entry: 'firestore', owner: 'FieldPath', path: [{ static: 'FieldPath' }], make: () => firestoreEntry.FieldPath },
  { entry: 'firestore', owner: 'Timestamp', path: [{ static: 'Timestamp' }], make: () => firestoreEntry.Timestamp },
  { entry: 'firestore', owner: 'Timestamp instance', path: ['Timestamp'], make: () => firestoreEntry.Timestamp.now() },

  { entry: 'storage', owner: 'Storage', path: ['getStorage'], make: (arm) => storageEntry.getStorage(arm.app) },
  { entry: 'storage', owner: 'Bucket', path: ['getStorage', 'bucket'], make: (arm) => storageEntry.getStorage(arm.app).bucket() },
  {
    entry: 'storage',
    owner: 'File',
    path: ['getStorage', 'bucket', 'file'],
    make: (arm) => storageEntry.getStorage(arm.app).bucket().file('surface.txt'),
  },

  { entry: 'messaging', owner: 'Messaging', path: ['getMessaging'], make: (arm) => messagingEntry.getMessaging(arm.app) },
];

const MIRRORED_MODULES: Record<(typeof MIRRORED_ENTRIES)[number], Module> = {
  '.': rootEntry as Module,
  app: appEntry as Module,
  auth: authEntry as Module,
  database: databaseEntry as Module,
  firestore: firestoreEntry as Module,
  storage: storageEntry as Module,
  messaging: messagingEntry as Module,
};

const TOP_LEVEL = '(exports)';

// ─── State of one name ──────────────────────────────────────────────────

type State = 'implemented' | 'deferred' | 'allowlisted' | 'missing';

/** The own-or-inherited property descriptor of `name`, without invoking getters. */
function descriptorOf(target: object, name: string): PropertyDescriptor | undefined {
  for (let current: object | null = target; current !== null; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) return descriptor;
  }
  return undefined;
}

function stateOf(target: object, name: string, allowlisted: boolean): State {
  const descriptor = descriptorOf(target, name);
  if (descriptor === undefined) return allowlisted ? 'allowlisted' : 'missing';
  if ('value' in descriptor && isDeferredApi(descriptor.value)) return 'deferred';
  return 'implemented';
}

const allowlistKey = (entry: string, owner: string, member: string) => `${entry}|${owner}|${member}`;

const ALLOWLISTED = new Map<string, string>();
for (const group of ALLOWLIST) {
  for (const member of group.members) {
    const key = allowlistKey(group.entry, group.owner, member);
    if (ALLOWLISTED.has(key)) throw new Error(`surface-allowlist.ts lists ${key} twice`);
    ALLOWLISTED.set(key, group.reason);
  }
}

// ─── Arms ───────────────────────────────────────────────────────────────

/** A channel no peer answers. The probes only construct handles, and the
 *  local-only probes are the ones that read data. */
const silentChannel: RemoteSandboxChannel = {
  op: () => Promise.reject(new Error('admin-surface: no peer')),
  subscribe: () => () => {},
};

let arms: Arm[] = [];

beforeAll(() => {
  const local = appEntry.initializeApp({ sandbox: initializeSandbox() }, 'admin-surface-local');
  const remote = appEntry.initializeApp(
    {
      sandbox: createRemoteSandboxHandle({ channel: silentChannel, serveUrl: 'http://localhost:0', close: () => {} }),
    },
    'admin-surface-remote',
  );
  arms = [
    { name: 'local', app: local },
    { name: 'remote', app: remote },
  ];
});

afterAll(async () => {
  await Promise.all(arms.map((arm) => appEntry.deleteApp(arm.app)));
});

// ─── The check ──────────────────────────────────────────────────────────

const upstream = loadUpstreamSurface([...MIRRORED_ENTRIES, ...DEFERRED_ENTRIES]);

/** The state of every visited name, by entry and then by label. A name
 *  checked on both arms keeps the worse of its two states. */
const SEVERITY: Record<State, number> = { implemented: 0, deferred: 1, allowlisted: 2, missing: 3 };
const tallies = new Map<string, Map<string, State>>();

/** Every allowlist key a check visited, so stale allowlist rows show up. */
const visited = new Set<string>();

const labelOf = (owner: string, name: string) => (owner === TOP_LEVEL ? name : `${owner}.${name}`);

function classify(entry: string, owner: string, target: object, names: Iterable<string>): string[] {
  const missing: string[] = [];
  let states = tallies.get(entry);
  if (!states) tallies.set(entry, (states = new Map()));
  for (const name of names) {
    const key = allowlistKey(entry, owner, name);
    visited.add(key);
    const state = stateOf(target, name, ALLOWLISTED.has(key));
    const label = labelOf(owner, name);
    const previous = states.get(label);
    if (previous === undefined || SEVERITY[state] > SEVERITY[previous]) states.set(label, state);
    if (state === 'missing') missing.push(label);
  }
  return missing;
}

describe(`pyric-admin surface against firebase-admin ${firebaseAdminVersion()}`, () => {
  for (const entry of MIRRORED_ENTRIES) {
    test(`'${entry}' exports every firebase-admin value export`, () => {
      const names = upstream.exports(entry);
      const missing = classify(entry, TOP_LEVEL, MIRRORED_MODULES[entry], names);
      if (entry === '.') {
        // `import admin from 'firebase-admin'` reads the same names off the default export.
        missing.push(...classify(entry, 'default', rootEntry.default, names));
      }
      expect(missing.map((name) => `pyric-admin/${entry}: ${name}`)).toEqual([]);
    });
  }

  for (const entry of DEFERRED_ENTRIES) {
    test(`'${entry}' exports every firebase-admin value export`, async () => {
      const mod = (await import(`pyric-admin/${entry}`)) as Module;
      const missing = classify(entry, TOP_LEVEL, mod, upstream.exports(entry));
      expect(missing.map((name) => `pyric-admin/${entry}: ${name}`)).toEqual([]);
    });
  }

  for (const probe of PROBES) {
    const names = [...upstream.members(probe.entry, probe.path).keys()];
    test(`'${probe.entry}' ${probe.owner} has every firebase-admin member`, async () => {
      const missing: string[] = [];
      for (const arm of arms) {
        if (probe.localOnly && arm.name === 'remote') continue;
        const target = (await probe.make(arm)) as object;
        expect(target, `${probe.owner} on the ${arm.name} arm`).toBeTruthy();
        missing.push(
          ...classify(probe.entry, probe.owner, target, names).map(
            (name) => `pyric-admin/${probe.entry}: ${name} (${arm.name} arm)`,
          ),
        );
      }
      expect(missing).toEqual([]);
    });
  }

  test('every deferred member fails the way its upstream form does, naming the member', async () => {
    const wrong: string[] = [];
    for (const probe of PROBES) {
      for (const arm of arms) {
        if (probe.localOnly && arm.name === 'remote') continue;
        const target = (await probe.make(arm)) as Record<string, (...args: unknown[]) => unknown>;
        for (const [name, kind] of upstream.members(probe.entry, probe.path)) {
          const descriptor = descriptorOf(target, name);
          if (!descriptor || !('value' in descriptor) || !isDeferredApi(descriptor.value)) continue;
          const label = `${probe.entry} ${probe.owner}.${name} (${arm.name} arm)`;
          let result: unknown;
          let thrown: unknown;
          try {
            result = target[name]!();
          } catch (error) {
            thrown = error;
          }
          if (kind === 'async') {
            if (!(result instanceof Promise)) {
              wrong.push(`${label}: upstream returns a promise, the stub does not reject one`);
              continue;
            }
            thrown = await result.then(() => undefined, (error: unknown) => error);
          } else if (result !== undefined) {
            wrong.push(`${label}: upstream returns synchronously, the stub does not throw`);
            continue;
          }
          // A method names its class; a deferred value on a namespace names itself.
          const symbol = kind === 'property' ? name : `${probe.owner}.${name}`;
          if (!(thrown instanceof PyricDeferredApiError) || !thrown.message.includes(`${symbol} is not implemented`)) {
            wrong.push(`${label}: does not fail with a PyricDeferredApiError naming ${symbol}`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  test('every allowlist row names an absent firebase-admin member', () => {
    // Runs after the checks above: bun runs the tests of a file in order.
    const notUpstream = [...ALLOWLISTED.keys()].filter((key) => !visited.has(key));
    const nowPresent = [...ALLOWLISTED.keys()].filter((key) => {
      const [entry, owner, name] = key.split('|') as [string, string, string];
      const state = tallies.get(entry)?.get(labelOf(owner, name));
      return state === 'implemented' || state === 'deferred';
    });
    expect({ notUpstream, nowPresent }).toEqual({ notUpstream: [], nowPresent: [] });
  });

  test('surface tally', () => {
    // PYRIC_ADMIN_SURFACE_REPORT=1 prints the state counts of every entry point.
    if (process.env.PYRIC_ADMIN_SURFACE_REPORT) {
      for (const [entry, states] of [...tallies].sort(([a], [b]) => a.localeCompare(b))) {
        const by = (state: State) => [...states].filter(([, s]) => s === state).map(([label]) => label);
        const missing = by('missing');
        console.log(
          `${entry}: implemented ${by('implemented').length}, deferred ${by('deferred').length}, ` +
            `allowlisted ${by('allowlisted').length}, missing ${missing.length}` +
            (missing.length ? `\n  missing: ${missing.join(', ')}` : ''),
        );
      }
    }
    expect(tallies.size).toBeGreaterThan(0);
  });
});
