import { describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { get, getAdminDatabase, getDatabase, ref, sandbox as rtdbSandbox, set } from 'pyric/database';
import { getFirestore } from 'pyric/firestore';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import { databaseInstanceNamed } from 'pyric/sandbox/internal';
import { createSurfaceContext, renderSurface, type OperationResult } from '../../../cli/dist/bridge/surface/index.js';
import type { FirebaseJson } from '../../../cli/dist/cli/firebase-json.js';
import { loadProjectDatabaseRules } from '../../../cli/dist/serve/rules.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../cli/dist/serve/worker/host.js';
import { setDatabaseRules } from '../../../cli/dist/serve/worker/host/rules.js';
import type { InboundMessage, OutboundMessage, ResMessage } from '../../../cli/dist/serve/worker/protocol.js';
import { DATABASE_URL_INPUTS, createProbe } from '../../src/capture/rtdb-climb/database-url-instance.probe.ts';
import {
  MULTI_INSTANCE_OBSERVATION,
  MULTI_INSTANCE_RULES,
  captureMultiInstanceSdk,
} from '../../src/run-rules-rtdb.ts';
import {
  DEFAULT_INSTANCE,
  DEFAULT_RULES,
  LOCKED_RULES,
  NAMED_INSTANCE,
  PROJECT_ID,
  SECOND_RULES,
  isUrlFailure,
  makeTempProjectDir,
  multiObs,
  onTestCleanup,
  openHostedMultiInstance,
  outcomeOf,
  registerMultiInstanceCleanupHooks,
  urlObs,
} from './multi-instance-replay-support.ts';

registerMultiInstanceCleanupHooks();

describe('RTDB multi-instance and URL-instance capture replay across MI3 and MI5', () => {
  it('keeps database-url-instance and multi-instance capture metadata synced with the committed observations', async () => {
    const probe = createProbe({
      config: { projectId: PROJECT_ID, apiKey: 'unused' },
      runId: 'sync-check',
    } as never);
    expect(probe.name).toBe('rtdb-modular-database-url-instance');
    expect(probe.rowIds).toEqual(urlObs.rowIds);
    expect(Object.keys(urlObs.behavior.urls)).toEqual([...DATABASE_URL_INPUTS]);
    expect(urlObs.behavior.projectDefault.nameIsProjectIdDefaultRtdb).toBe(true);
    expect(MULTI_INSTANCE_OBSERVATION).toBe('rtdb-modular-multiple-instances');
    expect(multiObs.behavior.rules).toEqual(MULTI_INSTANCE_RULES);
    expect(await captureMultiInstanceSdk()).toEqual(multiObs.behavior.sdk);
  });

  it('MI3: firebase.json database array loads captured default and named rules and replays isolation across sandbox, SharedWorker, and Node host', async () => {
    const dir = makeTempProjectDir('pyric-mi3-');
    writeFileSync(join(dir, 'default.rules.json'), JSON.stringify(DEFAULT_RULES));
    writeFileSync(join(dir, 'second.rules.json'), JSON.stringify(SECOND_RULES));
    writeFileSync(
      join(dir, '.firebaserc'),
      JSON.stringify({
        projects: { default: PROJECT_ID },
        targets: {
          [PROJECT_ID]: {
            database: {
              'shard-target': [NAMED_INSTANCE],
            },
          },
        },
      }),
    );

    const firebaseJson: FirebaseJson = {
      database: [
        { instance: PROJECT_ID, rules: 'default.rules.json' },
        { target: 'shard-target', instance: 'ignored-when-target-wins', rules: 'second.rules.json' },
      ],
    };
    const loaded = await loadProjectDatabaseRules(dir, firebaseJson, { projectId: PROJECT_ID });
    expect(loaded.defaultInstance).toBe(DEFAULT_INSTANCE);
    expect(databaseInstanceNamed(DEFAULT_INSTANCE).url).toBe(urlObs.behavior.projectDefault.url);
    expect(loaded.instances.get(DEFAULT_INSTANCE)?.rules).toEqual(DEFAULT_RULES);
    expect(loaded.instances.get(NAMED_INSTANCE)?.rules).toEqual(SECOND_RULES);

    // 1. In-process sandbox
    const box = initializeSandbox({ projectId: PROJECT_ID });
    onTestCleanup(() => box.dispose());
    rtdbSandbox.setRules(getDatabase(box), DEFAULT_RULES);
    rtdbSandbox.setRules(getDatabase(box, `https://${NAMED_INSTANCE}.firebaseio.com`), SECOND_RULES);

    expect(await outcomeOf(set(ref(getDatabase(box.withAuth(null)), 'open/probe'), 'default'))).toBe(
      multiObs.behavior.signedOut.defaultWrite,
    );
    expect(
      await outcomeOf(
        set(ref(getDatabase(box.withAuth(null), `https://${NAMED_INSTANCE}.firebaseio.com`), 'open/probe'), 'second'),
      ),
    ).toBe(multiObs.behavior.signedOut.secondWrite);
    expect((await get(ref(getAdminDatabase(box, NAMED_INSTANCE), 'open/probe'))).val()).toBe(
      multiObs.behavior.isolation.secondWriteReadOnSecond,
    );
    expect((await get(ref(getAdminDatabase(box), 'open/probe'))).val()).toBe(
      multiObs.behavior.isolation.secondWriteReadOnDefault,
    );

    const alice = box.withAuth({ uid: 'alice' });
    const aliceSecond = getDatabase(alice, 'https://my-instance.europe-west1.firebasedatabase.app');
    expect(await outcomeOf(set(ref(getDatabase(alice), 'open/probe'), 'default'))).toBe(
      multiObs.behavior.signedIn.defaultWrite,
    );
    expect(await outcomeOf(set(ref(aliceSecond, 'users/alice'), 'own'))).toBe(
      multiObs.behavior.signedIn.secondOwnUserPath,
    );
    expect(await outcomeOf(set(ref(aliceSecond, 'users/bob'), 'other'))).toBe(
      multiObs.behavior.signedIn.secondOtherUserPath,
    );
    expect(await outcomeOf(get(ref(aliceSecond, 'closed')))).toBe(
      multiObs.behavior.signedIn.secondPathWithoutRules,
    );
    expect(await outcomeOf(get(ref(getDatabase(alice), 'users/alice')))).toBe(
      multiObs.behavior.signedIn.defaultReadOfSecondOnlyPath,
    );
    expect((await get(ref(getAdminDatabase(box), 'open/probe'))).val()).toBe(
      multiObs.behavior.isolationAfterBothWrites.defaultHolds,
    );
    expect((await get(ref(getAdminDatabase(box, NAMED_INSTANCE), 'open/probe'))).val()).toBe(
      multiObs.behavior.isolationAfterBothWrites.secondHolds,
    );
    expect((await get(ref(getAdminDatabase(box), 'users/alice'))).val()).toBe(
      multiObs.behavior.isolationAfterBothWrites.secondUserPathOnDefault,
    );

    // 2. SharedWorker host dispatch
    const workerSandbox = initializeSandbox({ projectId: PROJECT_ID });
    onTestCleanup(() => workerSandbox.dispose());
    await workerSandbox.enablePersistence({
      key: `mi3-worker-${Math.random()}`,
      injectedBackend: createMemoryBackend(),
    });
    const workerCtx: HostCtx = {
      db: getFirestore(workerSandbox),
      sandbox: workerSandbox,
      instanceId: 'mi3-worker',
      subs: new Map(),
      defaultRtdbInstance: DEFAULT_INSTANCE,
    };
    setDatabaseRules(workerCtx, undefined, DEFAULT_RULES);
    setDatabaseRules(workerCtx, NAMED_INSTANCE, SECOND_RULES);
    const workerOp = (msg: Record<string, unknown>): Promise<ResMessage> =>
      new Promise((resolve) => {
        const port: PortLike = {
          postMessage(out: OutboundMessage) {
            if (out.t === 'res') resolve(out);
          },
        };
        void handleMessage(workerCtx, port, { t: 'op', id: 'w-1', ...msg } as InboundMessage);
      });

    expect((await workerOp({ method: 'rtdb.set', path: 'open/probe', value: 'default' })).ok).toBe(false);
    expect(
      (await workerOp({ method: 'rtdb.set', instance: NAMED_INSTANCE, path: 'open/probe', value: 'second' })).ok,
    ).toBe(true);
    expect(
      (
        await workerOp({
          method: 'rtdb.set',
          instance: NAMED_INSTANCE,
          path: 'users/alice',
          value: 'own',
          actAs: { mode: 'as', uid: 'alice' },
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await workerOp({
          method: 'rtdb.set',
          instance: NAMED_INSTANCE,
          path: 'users/bob',
          value: 'other',
          actAs: { mode: 'as', uid: 'alice' },
        })
      ).ok,
    ).toBe(false);

    // 3. Node host (createHostedRuntime) + single-instance reload isolation
    const databaseInstances = {
      defaultInstance: loaded.defaultInstance,
      rules: {
        [DEFAULT_INSTANCE]: DEFAULT_RULES,
        [NAMED_INSTANCE]: SECOND_RULES,
      },
    };
    const hosted = await openHostedMultiInstance(dir, databaseInstances, false);
    onTestCleanup(() => hosted.runtime.close());

    expect((await hosted.request({ method: 'rtdb.set', path: 'open/probe', value: 'default' })).ok).toBe(false);
    expect(
      (await hosted.request({ method: 'rtdb.set', instance: NAMED_INSTANCE, path: 'open/probe', value: 'second' })).ok,
    ).toBe(true);
    await hosted.runtime.deployRules('database', JSON.stringify(LOCKED_RULES), NAMED_INSTANCE);
    expect(
      (await hosted.request({ method: 'rtdb.set', instance: NAMED_INSTANCE, path: 'open/probe', value: 'blocked' })).ok,
    ).toBe(false);
    expect(
      (
        await hosted.request({
          method: 'rtdb.set',
          path: 'open/probe',
          value: 'default',
          actAs: { mode: 'as', uid: 'alice' },
        })
      ).ok,
    ).toBe(true);
  });

  it('MI5: database service tool parses captured URL forms, enforces per-instance rules on sandbox and Node host, and refuses malformed URLs', async () => {
    const dir = makeTempProjectDir('pyric-mi5-');
    writeFileSync(join(dir, 'default.rules.json'), JSON.stringify(DEFAULT_RULES));
    writeFileSync(join(dir, 'second.rules.json'), JSON.stringify(SECOND_RULES));
    writeFileSync(join(dir, '.firebaserc'), JSON.stringify({ projects: { default: PROJECT_ID } }));
    writeFileSync(
      join(dir, 'firebase.json'),
      JSON.stringify({
        database: [
          { instance: DEFAULT_INSTANCE, rules: 'default.rules.json' },
          { instance: NAMED_INSTANCE, rules: 'second.rules.json' },
          { instance: 'db1', rules: 'second.rules.json' },
          { instance: 'DB1', rules: 'second.rules.json' },
          { instance: 'other', rules: 'second.rules.json' },
        ],
      }),
    );

    const box = initializeSandbox({ projectId: PROJECT_ID });
    onTestCleanup(() => box.dispose());
    rtdbSandbox.setRules(getDatabase(box), DEFAULT_RULES);
    for (const inst of [NAMED_INSTANCE, 'db1', 'http://localhost:9000/?ns=DB1', 'other']) {
      rtdbSandbox.setRules(getDatabase(box, inst), SECOND_RULES);
    }
    // firebase.json normalizes declared names to lowercase (`db1`), while `?ns=DB1` preserves case;
    // seeding `http://localhost:9000/?ns=DB1` exercises MI5's allowance for an undeclared held instance.
    await set(ref(getAdminDatabase(box, 'http://localhost:9000/?ns=DB1'), 'seed'), 1);
    const ctx = createSurfaceContext(box, dir);
    const surface = renderSurface(undefined);
    const dbTool = surface.tools.find((candidate) => candidate.name === 'database');
    const authTool = surface.tools.find((candidate) => candidate.name === 'auth');
    if (dbTool === undefined || authTool === undefined) {
      throw new Error('Expected database and auth tools on rendered surface');
    }
    const callDb = (method: string, args: Record<string, unknown>): Promise<OperationResult> =>
      dbTool.execute({ method, args }, ctx);

    for (const [input, expected] of Object.entries(urlObs.behavior.urls)) {
      if (isUrlFailure(expected)) {
        if (input !== NAMED_INSTANCE && input !== 'default') {
          const rejected = await callDb('get', { path: 'open/probe', instance: input });
          expect(rejected.ok).toBe(false);
          expect(rejected.summary).toContain(expected.error.trim());
        }
      } else if (expected.name.length > 0) {
        const res = await callDb('get', { path: 'open/probe', instance: input });
        expect({ input, ok: res.ok, summary: res.summary }).toEqual({ input, ok: true, summary: res.summary });
      }
    }

    const undeclared = await callDb('get', { path: 'open/probe', instance: 'undeclared-shard' });
    expect(undeclared.ok).toBe(false);
    expect(undeclared.summary).toContain('is not declared in firebase.json');

    expect((await authTool.execute({ method: 'createUser', args: { uid: 'alice', email: 'alice@example.com' } }, ctx)).ok).toBe(true);
    expect((await authTool.execute({ method: 'impersonate', args: { uid: 'alice' } }, ctx)).ok).toBe(true);
    expect((await callDb('set', { path: 'users/alice', value: 'own', instance: 'https://my-instance.firebaseio.com' })).ok).toBe(true);
    const deniedInProcess = await callDb('set', { path: 'users/bob', value: 'other', instance: NAMED_INSTANCE });
    expect(deniedInProcess.ok).toBe(false);
    expect(deniedInProcess.summary).toMatch(/PERMISSION_DENIED/);

    const hosted = await openHostedMultiInstance(
      dir,
      {
        defaultInstance: DEFAULT_INSTANCE,
        rules: { [DEFAULT_INSTANCE]: DEFAULT_RULES, [NAMED_INSTANCE]: SECOND_RULES },
      },
      false,
    );
    onTestCleanup(() => hosted.runtime.close());
    const conn = {};
    const runHosted = (key: string, args: Record<string, unknown>) =>
      hosted.runtime.runMethod(
        { instanceId: hosted.runtime.instanceId, projectDir: dir, key, args, allowProduction: false },
        conn,
      );

    const hostedWrite = await runHosted('database.set', {
      path: 'open/probe',
      value: 'second',
      instance: 'https://My-Instance.Europe-West1.Firebasedatabase.App/',
    });
    expect(hostedWrite.ok).toBe(true);
    expect(hostedWrite.summary).toBe(`Wrote open/probe on ${NAMED_INSTANCE}`);
    expect((await runHosted('database.get', { path: 'open/probe', instance: 'default' })).data).toEqual({
      exists: false,
      value: null,
    });
    expect((await runHosted('database.get', { path: 'open/probe', instance: PROJECT_ID })).data).toEqual({
      exists: false,
      value: null,
    });
    expect((await runHosted('auth.createUser', { uid: 'alice', email: 'alice@example.com' })).ok).toBe(true);
    expect((await runHosted('auth.impersonate', { uid: 'alice' })).ok).toBe(true);
    const hostedDenied = await runHosted('database.set', {
      path: 'users/bob',
      value: 'other',
      instance: NAMED_INSTANCE,
    });
    expect(hostedDenied.ok).toBe(false);
    expect(hostedDenied.summary).toMatch(/PERMISSION_DENIED/);
  });
});
