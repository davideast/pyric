import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getDatabase as getModularDatabase,
  limitToFirst,
  onChildAdded,
  onChildChanged,
  onChildMoved,
  onChildRemoved,
  orderByChild,
  query,
  ref as clientRef,
  sandbox as databaseSandbox,
  set as clientSet,
} from 'pyric/database';
import { initializeSandbox, type Sandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp, type PyricAdminApp } from '../../src/app/index.js';
import { getDatabase } from '../../src/database/index.js';
import {
  ADMIN_QUERY_PROBE_RULES,
  observeAdminQueryBoundsListenersAndContext,
} from '../../../conformance/probes/rtdb-modular/rtdb-modular-admin-query-bounds-listeners-and-context.ts';
import { sharedWorkerArm } from './arms.js';

const OBS_DIR = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'conformance',
  'observations',
  'rtdb-modular',
);

function load(stemOrFile: string): Record<string, unknown> {
  let filename = `${stemOrFile}.json`;
  if (stemOrFile.endsWith('.json')) {
    filename = stemOrFile;
  }
  const parsed = JSON.parse(readFileSync(join(OBS_DIR, filename), 'utf8')) as {
    behavior: Record<string, unknown>;
  };
  return parsed.behavior;
}

interface QueryArm {
  readonly app: PyricAdminApp;
  readonly host: Sandbox;
}

let armSeq = 0;

const ARMS: ReadonlyArray<{ name: string; make: () => QueryArm }> = [
  {
    name: 'in-process',
    make() {
      armSeq += 1;
      const projectId = `demo-admin-query-cdd-${armSeq}`;
      const host = initializeSandbox({ projectId });
      const app = initializeApp(
        {
          sandbox: host,
          projectId,
          databaseURL: `https://${projectId}-default-rtdb.firebaseio.com`,
        },
        `admin-query-local-${armSeq}`,
      );
      return { app, host };
    },
  },
  {
    name: 'remote (SharedWorker bridge)',
    make() {
      const { app, host } = sharedWorkerArm();
      return { app, host };
    },
  },
];

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe.each(ARMS)('RTDB admin query bounds, listeners, and context oracle capture [$name]', ({ make }) => {
  it('rtdb-modular-admin-query-bounds-listeners-and-context (rtdb-admin#5)', async () => {
    const { app, host } = make();
    const basePath = '/pyric_oracle/rtdb_admin_query';
    databaseSandbox.setRules(getModularDatabase(host), {
      rules: {
        '.read': true,
        '.write': true,
        pyric_oracle: {
          rtdb_admin_query: ADMIN_QUERY_PROBE_RULES,
        },
      },
    });
    const adminDb = getDatabase(app);
    const expected = load('rtdb-modular-admin-query-bounds-listeners-and-context');
    const actual = await observeAdminQueryBoundsListenersAndContext(
      adminDb as unknown as Parameters<typeof observeAdminQueryBoundsListenersAndContext>[0],
      basePath,
      async (rankedSubpath) => {
        await adminDb.ref(`${basePath}/${rankedSubpath}`).set({
          k1: { label: 'one', '.priority': 30 },
          k2: { label: 'two', '.priority': 10 },
          k3: { label: 'no-prio' },
          k4: { label: 'str-prio', '.priority': 'high' },
        });
      },
    );
    expect(actual as unknown).toEqual(expected);
  });
});

describe('Modular RTDB two-phase limited window self-eviction parity', () => {
  it('emits child_moved and child_changed before child_removed and child_added when an in-window child mutates past a sibling', async () => {
    const sandbox = initializeSandbox({ projectId: 'demo-mod-window-evict' });
    const db = getModularDatabase(sandbox);
    databaseSandbox.setDefaultPolicy(db, 'allow');

    const itemsRef = clientRef(db, 'users/u1/items');
    await clientSet(itemsRef, {
      d: { rank: 0 },
      a: { rank: 1 },
      c: { rank: 3 },
      b: { rank: 4 },
    });

    const topTwo = query(itemsRef, orderByChild('rank'), limitToFirst(2));
    const events: Array<{ event: string; key: string | null; prevKey: string | null; val: unknown }> = [];
    const unsubs = [
      onChildAdded(topTwo, (s, prev) => events.push({ event: 'child_added', key: s.key, prevKey: prev, val: s.val() })),
      onChildChanged(topTwo, (s, prev) => events.push({ event: 'child_changed', key: s.key, prevKey: prev, val: s.val() })),
      onChildMoved(topTwo, (s, prev) => events.push({ event: 'child_moved', key: s.key, prevKey: prev, val: s.val() })),
      onChildRemoved(topTwo, (s, prev) => events.push({ event: 'child_removed', key: s.key, prevKey: prev, val: s.val() })),
    ];

    events.length = 0;
    await clientSet(clientRef(db, 'users/u1/items/a/rank'), 9);

    expect(events).toEqual([
      { event: 'child_moved', key: 'a', prevKey: 'd', val: { rank: 9 } },
      { event: 'child_changed', key: 'a', prevKey: 'd', val: { rank: 9 } },
      { event: 'child_removed', key: 'a', prevKey: null, val: { rank: 9 } },
      { event: 'child_added', key: 'c', prevKey: 'd', val: { rank: 3 } },
    ]);

    for (const unsub of unsubs) {
      unsub();
    }
  });
});
