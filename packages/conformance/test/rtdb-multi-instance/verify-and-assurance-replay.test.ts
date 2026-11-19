import { describe, expect, it, spyOn } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDatabase, ref, sandbox as rtdbSandbox, set } from 'pyric/database';
import { getFirestore } from 'pyric/firestore';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import { runAuthorizationCampaign } from '../../../cli/dist/assurance/runner.js';
import type { AuthorizationCampaignSpec } from '../../../cli/dist/assurance/types.js';
import { parseArgs } from '../../../cli/dist/cli/parse-args.js';
import { runVerify } from '../../../cli/dist/cli/verify.js';
import { buildLiveSessionCaptureFixture } from '../../../cli/dist/serve/session-capture-fixture.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../cli/dist/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../cli/dist/serve/worker/protocol.js';
import { applyServeInit } from '../../../cli/dist/serve/worker/serve-init.js';
import {
  capturedDefaultRtdbInstance,
  parseVerifyFixture,
  recordedRtdbInstances,
  verifyFixture,
} from '../../../cli/dist/verify/index.js';
import {
  DEFAULT_INSTANCE,
  DEFAULT_RULES,
  LOCKED_RULES,
  NAMED_INSTANCE,
  PROJECT_ID,
  SECOND_RULES,
  makeTempProjectDir,
  multiObs,
  onTestCleanup,
  openHostedMultiInstance,
  registerMultiInstanceCleanupHooks,
} from './multi-instance-replay-support.ts';

registerMultiInstanceCleanupHooks();

describe('RTDB multi-instance and URL-instance capture replay across MI6 and MI7', () => {
  it('MI6: pyric verify captures and replays multi-instance sessions across in-process, SharedWorker, and Node host by name and URL', async () => {
    const dir = makeTempProjectDir('pyric-mi6-');
    writeFileSync(join(dir, 'default.rules.json'), JSON.stringify(DEFAULT_RULES));
    writeFileSync(join(dir, 'second.rules.json'), JSON.stringify(SECOND_RULES));
    writeFileSync(join(dir, 'tightened.rules.json'), JSON.stringify(LOCKED_RULES));
    writeFileSync(join(dir, '.firebaserc'), JSON.stringify({ projects: { default: PROJECT_ID } }));
    writeFileSync(
      join(dir, 'firebase.json'),
      JSON.stringify({
        database: [
          { instance: DEFAULT_INSTANCE, rules: 'default.rules.json' },
          { instance: NAMED_INSTANCE, rules: 'second.rules.json' },
        ],
      }),
    );

    // 1. In-process live session capture
    const box = initializeSandbox({ projectId: PROJECT_ID });
    onTestCleanup(() => box.dispose());
    const mainDb = getDatabase(box);
    const secondDb = getDatabase(box, `https://${NAMED_INSTANCE}.firebaseio.com`);
    rtdbSandbox.setRules(mainDb, DEFAULT_RULES);
    rtdbSandbox.setRules(secondDb, SECOND_RULES);
    const alice = box.withAuth({ uid: 'alice' });
    await set(ref(getDatabase(alice), 'open/probe'), 'default');
    await set(ref(getDatabase(alice, `https://${NAMED_INSTANCE}.firebaseio.com`), 'users/alice'), 'own');
    const inProcessFixture = parseVerifyFixture(
      JSON.parse(
        JSON.stringify(
          buildLiveSessionCaptureFixture({
            sandbox: box,
            defaultDatabase: mainDb,
            defaultInstance: DEFAULT_INSTANCE,
            authState: { users: [], currentUser: null },
          }),
        ),
      ),
    );
    expect(capturedDefaultRtdbInstance(inProcessFixture)).toBe(DEFAULT_INSTANCE);
    expect(recordedRtdbInstances(inProcessFixture)).toEqual([NAMED_INSTANCE]);

    const cleanResult = await verifyFixture(inProcessFixture, {
      rules: { rtdb: DEFAULT_RULES, rtdbInstances: { [NAMED_INSTANCE]: SECOND_RULES } },
    });
    expect(cleanResult.ok).toBe(true);

    // 2. SharedWorker applyServeInit capture delivery
    const workerBox = initializeSandbox({ projectId: PROJECT_ID });
    onTestCleanup(() => workerBox.dispose());
    await workerBox.enablePersistence({
      key: `mi6-worker-${Math.random()}`,
      injectedBackend: createMemoryBackend(),
    });
    const workerCtx: HostCtx = {
      db: getFirestore(workerBox),
      sandbox: workerBox,
      instanceId: 'mi6-worker',
      subs: new Map(),
      defaultRtdbInstance: DEFAULT_INSTANCE,
    };
    const postedBodies: string[] = [];
    const initHandle = applyServeInit(
      workerCtx,
      {
        rules: null,
        rulesHash: null,
        databaseRules: DEFAULT_RULES,
        databaseRulesHash: null,
        databaseInstances: {
          defaultInstance: DEFAULT_INSTANCE,
          rules: { [DEFAULT_INSTANCE]: DEFAULT_RULES, [NAMED_INSTANCE]: SECOND_RULES },
        },
        storageRules: null,
        storageRulesHash: null,
        bridgeUrl: null,
        seed: null,
        capture: true,
      },
      {
        captureDebounceMs: 10,
        fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
          if (typeof init?.body === 'string') {
            postedBodies.push(init.body);
          }
          return new Response('ok', { status: 200 });
        }) as typeof fetch,
      },
    );
    onTestCleanup(() => initHandle.dispose());
    const workerRes = await new Promise<OutboundMessage>((resolve) => {
      const port: PortLike = {
        postMessage(out: OutboundMessage) {
          if (out.t === 'res') resolve(out);
        },
      };
      void handleMessage(workerCtx, port, {
        t: 'op',
        id: 'w-cap-1',
        method: 'rtdb.set',
        instance: NAMED_INSTANCE,
        path: 'users/alice',
        value: 'own',
        actAs: { mode: 'as', uid: 'alice' },
      } as InboundMessage);
    });
    expect(workerRes.t === 'res' && workerRes.ok).toBe(true);
    await workerCtx.captureFlush?.();
    expect(postedBodies.length).toBeGreaterThan(0);
    const workerFixture = parseVerifyFixture(JSON.parse(postedBodies[postedBodies.length - 1] ?? '{}'));
    expect(recordedRtdbInstances(workerFixture)).toEqual([NAMED_INSTANCE]);

    // 3. Node host (.pyric/last-session.json) + runVerify CLI --rules rtdb:<instance>= by name and URL
    const hosted = await openHostedMultiInstance(
      dir,
      {
        defaultInstance: DEFAULT_INSTANCE,
        rules: { [DEFAULT_INSTANCE]: DEFAULT_RULES, [NAMED_INSTANCE]: SECOND_RULES },
      },
      true,
    );
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
    expect(
      (
        await hosted.request({
          method: 'rtdb.set',
          instance: NAMED_INSTANCE,
          path: 'users/alice',
          value: 'own',
          actAs: { mode: 'as', uid: 'alice' },
        })
      ).ok,
    ).toBe(true);
    await hosted.waitForCaptureFlush();
    await hosted.runtime.close();

    const sessionPath = join(dir, '.pyric', 'last-session.json');
    const runCliVerify = async (extraArgv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        out.push(String(chunk));
        return true;
      });
      const stderrSpy = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        err.push(String(chunk));
        return true;
      });
      const prevCwd = process.cwd();
      process.chdir(dir);
      try {
        const code = await runVerify(parseArgs(['verify', sessionPath, ...extraArgv]));
        return { code, out: out.join(''), err: err.join('') };
      } finally {
        process.chdir(prevCwd);
        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
      }
    };

    const cleanCli = await runCliVerify([
      '--rules',
      `rtdb:${DEFAULT_INSTANCE}=default.rules.json`,
      '--rules',
      'rtdb:https://my-instance.europe-west1.firebasedatabase.app=second.rules.json',
    ]);
    expect({ code: cleanCli.code, err: cleanCli.err }).toEqual({ code: 0, err: cleanCli.err });

    const tightenedCli = await runCliVerify([
      '--rules',
      'rtdb=default.rules.json',
      '--rules',
      `rtdb:${NAMED_INSTANCE}=tightened.rules.json`,
    ]);
    expect(tightenedCli.code).toBe(1);
    expect(tightenedCli.out).toContain(NAMED_INSTANCE);

    const unusedInstanceCli = await runCliVerify(['--rules', 'rtdb:unused-shard=second.rules.json']);
    expect(unusedInstanceCli.code).not.toBe(0);
    expect(unusedInstanceCli.err).toContain('unused-shard');
  });

  it('MI7: pyric assurance isolates rules.rtdbInstances and state.rtdbInstances across captured URL forms and refuses undeclared instances', async () => {
    const spec: AuthorizationCampaignSpec = {
      schema: 'pyric.assurance.campaign.v1',
      id: 'oracle-rtdb-multi-instance-replay',
      target: {
        schema: 'pyric.assurance.target.v1',
        network: 'forbid',
        rules: {
          rtdb: DEFAULT_RULES,
          rtdbInstances: {
            [NAMED_INSTANCE]: SECOND_RULES,
          },
        },
        state: {
          rtdb: { open: { probe: 'default-seed' } },
          rtdbInstances: {
            'https://my-instance.firebaseio.com': {
              open: { probe: 'second-seed' },
              users: { alice: 'own-seed', bob: 'bob-seed' },
            },
          },
        },
      },
      actors: [
        { id: 'anon', acquisition: { kind: 'anonymous-request' } },
        { id: 'alice', acquisition: { kind: 'synthetic', uid: 'alice' } },
      ],
      invariants: [
        {
          id: 'inv-multi',
          statement: 'Default and named RTDB instances enforce captured rules independently',
          service: 'rtdb',
          expected: 'ALLOW',
          source: 'captured',
          confidence: 'authoritative',
        },
      ],
      probes: [
        {
          id: 'signed-out-second-instance',
          actorId: 'anon',
          invariantId: 'inv-multi',
          control: {
            service: 'rtdb',
            instance: 'https://my-instance.europe-west1.firebasedatabase.app',
            method: 'set',
            path: '/open/probe',
            data: 'entry',
          },
          mutation: {
            dimension: 'path',
            description: 'Second instance denies signed-out write outside open subtree',
            operation: {
              service: 'rtdb',
              instance: 'https://my-instance.europe-west1.firebasedatabase.app',
              method: 'set',
              path: '/users/alice',
              data: 'entry',
            },
          },
        },
        {
          id: 'signed-out-default-instance',
          actorId: 'anon',
          invariantId: 'inv-multi',
          control: {
            service: 'rtdb',
            instance: 'default',
            method: 'set',
            path: '/open/probe',
            data: 'entry',
          },
          mutation: {
            dimension: 'path',
            description: 'Default instance also denies signed-out write on other paths',
            operation: {
              service: 'rtdb',
              instance: 'default',
              method: 'set',
              path: '/users/alice',
              data: 'entry',
            },
          },
        },
        {
          id: 'signed-in-own-vs-other-on-second',
          actorId: 'alice',
          invariantId: 'inv-multi',
          control: {
            service: 'rtdb',
            instance: 'https://my-instance.firebaseio.com:443',
            method: 'set',
            path: '/users/alice',
            data: 'entry',
          },
          mutation: {
            dimension: 'path',
            description: 'Second instance denies writing another user path',
            operation: {
              service: 'rtdb',
              instance: 'https://my-instance.firebaseio.com:443',
              method: 'set',
              path: '/users/bob',
              data: 'entry',
            },
          },
        },
      ],
    };

    const report = await runAuthorizationCampaign(spec);
    const secondOutRes = report.results.find((item) => item.probeId === 'signed-out-second-instance');
    const defaultOutRes = report.results.find((item) => item.probeId === 'signed-out-default-instance');
    const signedInRes = report.results.find((item) => item.probeId === 'signed-in-own-vs-other-on-second');
    expect(secondOutRes?.control.decision).toBe(multiObs.behavior.signedOut.secondWrite);
    expect(defaultOutRes?.control.decision).toBe(multiObs.behavior.signedOut.defaultWrite);
    expect(signedInRes?.control.decision).toBe(multiObs.behavior.signedIn.secondOwnUserPath);
    expect(signedInRes?.mutation.decision).toBe(multiObs.behavior.signedIn.secondOtherUserPath);

    const badSpec: AuthorizationCampaignSpec = {
      ...spec,
      id: 'oracle-rtdb-undeclared-instance',
      probes: [
        {
          id: 'undeclared-probe',
          actorId: 'anon',
          invariantId: 'inv-multi',
          control: {
            service: 'rtdb',
            instance: 'missing-shard',
            method: 'get',
            path: '/open/probe',
          },
          mutation: {
            dimension: 'path',
            description: 'unused',
            operation: { service: 'rtdb', method: 'get', path: '/open/probe' },
          },
        },
      ],
    };
    let caughtError: Error | undefined;
    try {
      await runAuthorizationCampaign(badSpec);
    } catch (err) {
      if (err instanceof Error) {
        caughtError = err;
      }
    }
    expect(caughtError?.name).toBe('AssuranceInputError');
    expect(caughtError?.message).toContain('missing-shard');
  });
});
