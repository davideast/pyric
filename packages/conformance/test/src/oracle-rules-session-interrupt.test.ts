import { describe, expect, test } from 'bun:test';
import { withSignalGuardedFirestoreRules } from '../../src/firestore-real-rules.ts';
import {
  OracleRulesSession,
  firestoreOracleTarget,
  rtdbOracleTarget,
  runWithOracleRulesRestored,
} from '../../src/oracle-rules-session.ts';
import { withGuardedProbeRtdbRules } from '../../src/oracle-run-rtdb-probes.ts';
import {
  createSignalRestoreCoordinator,
  restoreRtdbRulesWithRetry,
} from '../../src/oracle-signal-restore.ts';
import { storageStdlibSignalCoordinator } from '../../src/storage-stdlib-real-rules.ts';

const PROJECT = 'oracle-test';
const DATABASE_URL = 'https://pyric-oracle-rtdb-2.firebaseio.com';
const RTDB_ORIGINAL = '{"rules":{"items":{"$id":{".read":"auth != null"}}}}';
const FIRESTORE_ORIGINAL = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if request.auth != null;
    }
  }
}
`;

function deferred<T = void>() {
  let resolveFn: (value: T | PromiseLike<T>) => void = () => undefined;
  let rejectFn: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

describe('OracleRulesSession concurrent interrupt safety and baseline tracking (#1426)', () => {
  test('concurrent restoreAll calls share the in-flight restore promise instead of exiting early', async () => {
    let liveRtdb = RTDB_ORIGINAL;
    const putGate = deferred<void>();
    const putStarted = deferred<void>();
    let putCount = 0;

    const session = new OracleRulesSession({
      projectId: PROJECT,
      accessToken: async () => 'fb-token',
      fetch: async (url, init = {}) => {
        const method = init.method ?? 'GET';
        if (method === 'GET') {
          return new Response(liveRtdb, { status: 200 });
        }
        if (method === 'PUT') {
          putCount += 1;
          if (putCount === 2) {
            putStarted.resolve();
            await putGate.promise;
          }
          liveRtdb = String(init.body);
          return new Response(null, { status: 204 });
        }
        return new Response('unhandled', { status: 405 });
      },
    });

    const outcome = await session.deployRtdb(rtdbOracleTarget(DATABASE_URL, async () => 'rtdb-token'));
    expect(outcome).toBe('merged');
    expect(liveRtdb).toContain('pyric_oracle');
    expect(session.hasBaseline('rtdb')).toBe(true);

    // Start normal end-of-run restore; pause inside the restore PUT.
    const normalRestore = session.restoreAll();
    await putStarted.promise;

    // Simulate SIGINT #1 and SIGINT #2 arriving while restoreAll() is still mid-flight.
    let firstInterruptResolved = false;
    let secondInterruptResolved = false;
    const interruptOne = session.restoreAll().then(() => {
      firstInterruptResolved = true;
    });
    const interruptTwo = session.restoreAll().then(() => {
      secondInterruptResolved = true;
    });

    await Promise.resolve();
    expect(firstInterruptResolved).toBe(false);
    expect(secondInterruptResolved).toBe(false);
    expect(liveRtdb).toContain('pyric_oracle');

    putGate.resolve();
    await Promise.all([normalRestore, interruptOne, interruptTwo]);

    expect(firstInterruptResolved).toBe(true);
    expect(secondInterruptResolved).toBe(true);
    expect(liveRtdb).toBe(RTDB_ORIGINAL);
    expect(putCount).toBe(2);
    expect(session.restoredRtdb).toBe(true);
  });

  test('restoredRtdb stays false when RTDB rules were already configured or never deployed', async () => {
    const preMerged = JSON.stringify({
      rules: {
        items: { $id: { '.read': 'auth != null' } },
        pyric_oracle: {
          '.read': 'auth != null',
          '.write': 'auth != null',
          $run: { $probe: { list: { '.indexOn': ['pos', 'group'] } } },
        },
      },
    });

    const session = new OracleRulesSession({
      projectId: PROJECT,
      accessToken: async () => 'fb-token',
      fetch: async () => new Response(preMerged, { status: 200 }),
    });

    const outcome = await session.deployRtdb(rtdbOracleTarget(DATABASE_URL, async () => 'rtdb-token'));
    expect(outcome).toBe('already-configured');
    expect(session.hasBaseline('rtdb')).toBe(false);

    await session.restoreAll();
    expect(session.restoredRtdb).toBe(false);
  });

  test('in-probe rules guard runs before session baseline restore when interrupted mid-wait (#1426 item 2)', async () => {
    let liveRtdb = RTDB_ORIGINAL;
    const events: string[] = [];

    const session = new OracleRulesSession({
      projectId: PROJECT,
      accessToken: async () => 'fb-token',
      fetch: async (_url, init = {}) => {
        const method = init.method ?? 'GET';
        if (method === 'GET') return new Response(liveRtdb, { status: 200 });
        if (method === 'PUT') {
          liveRtdb = String(init.body);
          let tag = 'original';
          if (liveRtdb.includes('pyric_oracle')) {
            tag = 'merged';
          }
          events.push(`session-put:${tag}`);
          return new Response(null, { status: 204 });
        }
        return new Response('unhandled', { status: 405 });
      },
    });

    await session.deployRtdb(rtdbOracleTarget(DATABASE_URL, async () => 'rtdb-token'));
    const mergedSnapshot = liveRtdb;

    const unregister = session.registerProbeCleanup(async () => {
      events.push('probe-cleanup');
      liveRtdb = mergedSnapshot;
    });

    // Simulate probe writing its own temporary subtree over the merged rules, then SIGINT hitting restoreAll()
    liveRtdb = JSON.stringify({ rules: { ...JSON.parse(mergedSnapshot).rules, pyric_oracle_roundtrip_1: { '.read': false } } });

    await session.restoreAll();
    unregister();

    expect(events).toEqual([
      'session-put:merged',
      'probe-cleanup',
      'session-put:original',
    ]);
    expect(liveRtdb).toBe(RTDB_ORIGINAL);
    expect(session.isStopping).toBe(true);
  });

  test('tracks Firestore release restoration distinctly from RTDB restoration', async () => {
    const releases = new Map<string, string>([
      [`projects/${PROJECT}/releases/cloud.firestore`, `projects/${PROJECT}/rulesets/orig`],
    ]);
    const rulesets = new Map<string, string>([
      [`projects/${PROJECT}/rulesets/orig`, FIRESTORE_ORIGINAL],
    ]);
    const api = 'https://firebaserules.googleapis.com/v1/';

    const session = new OracleRulesSession({
      projectId: PROJECT,
      accessToken: async () => 'fb-token',
      fetch: async (url, init = {}) => {
        const method = init.method ?? 'GET';
        const path = url.replace(api, '');
        if (method === 'POST' && path === `projects/${PROJECT}/rulesets`) {
          const body = JSON.parse(String(init.body)) as { source: { files: { content: string }[] } };
          const name = `projects/${PROJECT}/rulesets/new-1`;
          rulesets.set(name, body.source.files[0]?.content ?? '');
          return new Response(JSON.stringify({ name }), { status: 200 });
        }
        if (path.startsWith(`projects/${PROJECT}/releases/`)) {
          const name = decodeURIComponent(path);
          if (method === 'GET') {
            return new Response(JSON.stringify({ name, rulesetName: releases.get(name) }), { status: 200 });
          }
          if (method === 'PATCH') {
            const body = JSON.parse(String(init.body)) as { release: { rulesetName: string } };
            releases.set(name, body.release.rulesetName);
            return new Response(JSON.stringify({ name, rulesetName: body.release.rulesetName }), { status: 200 });
          }
        }
        if (method === 'GET' && rulesets.has(path)) {
          return new Response(
            JSON.stringify({ name: path, source: { files: [{ name: 'firestore.rules', content: rulesets.get(path) }] } }),
            { status: 200 },
          );
        }
        return new Response('{}', { status: 404 });
      },
    });

    await runWithOracleRulesRestored(session, async () => {
      await session.deploy(firestoreOracleTarget());
      expect(session.hasBaseline('Firestore')).toBe(true);
      expect(session.hasBaseline('rtdb')).toBe(false);
    });

    expect(session.restoredRtdb).toBe(false);
    expect(session.restoredFirestoreOrStorage).toBe(true);
  });

  test('withGuardedProbeRtdbRules keeps cleanup registered and awaits in-flight probe PUT before session baseline restore', async () => {
    let liveRtdb = RTDB_ORIGINAL;
    const probeRestoreStarted = deferred<void>();
    const probeRestoreGate = deferred<void>();
    const putLog: string[] = [];

    const session = new OracleRulesSession({
      projectId: PROJECT,
      accessToken: async () => 'fb-token',
      fetch: async (_url, init = {}) => {
        const method = init.method ?? 'GET';
        if (method === 'GET') {
          return new Response(liveRtdb, { status: 200 });
        }
        if (method === 'PUT') {
          const bodyStr = String(init.body);
          liveRtdb = bodyStr;
          let label = 'session-original';
          if (bodyStr.includes('pyric_oracle')) {
            label = 'session-merged';
          }
          putLog.push(label);
          return new Response(null, { status: 204 });
        }
        return new Response('unhandled', { status: 405 });
      },
    });

    await session.deployRtdb(rtdbOracleTarget(DATABASE_URL, async () => 'rtdb-token'));
    const beforeRules = JSON.parse(liveRtdb).rules as Record<string, unknown>;

    let probePutCall = 0;
    const probeFetch: typeof fetch = (async (_input, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        return new Response(liveRtdb, { status: 200 });
      }
      probePutCall += 1;
      const bodyStr = String(init?.body ?? '');
      if (probePutCall === 2) {
        putLog.push('probe-restore-start');
        probeRestoreStarted.resolve();
        await probeRestoreGate.promise;
        liveRtdb = bodyStr;
        putLog.push('probe-restore-landed');
        return new Response(null, { status: 200 });
      }
      liveRtdb = bodyStr;
      putLog.push('probe-deploy-landed');
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const probePromise = withGuardedProbeRtdbRules({
      session,
      putUrl: `${DATABASE_URL}/.settings/rules.json?access_token=t&print=silent`,
      readUrl: `${DATABASE_URL}/.settings/rules.json?access_token=t`,
      beforeRules,
      nextRulesBody: { rules: { ...beforeRules, temp_probe: { '.read': false } } },
      fetchFn: probeFetch,
      body: async () => 'done',
    });

    // Wait until the probe body finishes and enters finally -> restoreOnce() PUT!
    await probeRestoreStarted.promise;

    // Now SIGINT hits session.restoreAll() while probe restoreOnce() PUT is still mid-flight!
    const interruptRestore = session.restoreAll();
    await Promise.resolve();
    // Session baseline restore MUST NOT have written RTDB_ORIGINAL yet while probe PUT is in flight!
    expect(putLog).not.toContain('session-original');

    probeRestoreGate.resolve();
    const [probeOutcome] = await Promise.all([probePromise, interruptRestore]);
    expect(probeOutcome).toEqual({
      result: 'done',
      restoreOk: true,
      restoreStatus: 200,
    });

    // Exact order: probe's merged rules land FIRST, session's RTDB_ORIGINAL lands LAST!
    expect(putLog).toEqual([
      'session-merged',
      'probe-deploy-landed',
      'probe-restore-start',
      'probe-restore-landed',
      'session-original',
    ]);
    expect(liveRtdb).toBe(RTDB_ORIGINAL);
  });

  test('createSignalRestoreCoordinator awaits in-flight deploy mutations before running cleanups and retries RTDB read-back', async () => {
    const order: string[] = [];
    const deployGate = deferred<void>();
    const coordinator = createSignalRestoreCoordinator('[test]');

    coordinator.registerCleanup(async () => {
      order.push('cleanup-ran');
    });

    const deployPromise = coordinator.trackMutation(
      (async () => {
        order.push('deploy-started');
        await deployGate.promise;
        order.push('deploy-settled');
      })(),
    );

    const restoreOne = coordinator.runRestore();
    const restoreTwo = coordinator.runRestore();
    await Promise.resolve();
    expect(order).toEqual(['deploy-started']);

    deployGate.resolve();
    await Promise.all([deployPromise, restoreOne, restoreTwo]);
    expect(order).toEqual(['deploy-started', 'deploy-settled', 'cleanup-ran']);

    let reads = 0;
    await restoreRtdbRulesWithRetry({
      beforeText: '{"rules":{}}',
      writeText: async () => {
        order.push('rtdb-put');
      },
      readText: async () => {
        reads += 1;
        if (reads === 1) return '{"rules":{"stale":true}}';
        return '{\n  "rules": {}\n}';
      },
    });
    expect(reads).toBe(2);
    expect(typeof withSignalGuardedFirestoreRules).toBe('function');
    expect(typeof storageStdlibSignalCoordinator.installSignals).toBe('function');
  });
});
