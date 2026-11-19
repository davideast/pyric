import { describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  endAt,
  equalTo,
  get,
  getAdminDatabase,
  getDatabase,
  limitToFirst,
  onChildAdded,
  onChildChanged,
  onChildMoved,
  onChildRemoved,
  onValue,
  orderByChild,
  orderByKey,
  query,
  ref,
  remove,
  runTransaction,
  sandbox as rtdbSandbox,
  set,
  setPriority,
  setWithPriority,
  startAt,
  update,
} from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';
import { buildLiveSessionCaptureFixture } from '../../../cli/dist/serve/session-capture-fixture.js';
import { parseVerifyFixture, verifyFixture } from '../../../cli/dist/verify/index.js';
import {
  ALICE_ANON_LENS,
  ALLOW_ALL_RULES,
  CASCADE_BINDINGS_AUTH_RULES,
  DATA_NEWDATA_SNAPSHOT_RULES,
  DEFAULT_DENY_AND_RUNTIME_ERROR_RULES,
  DEFAULT_INSTANCE,
  PROJECT_ID,
  R30_QUERY_RULES,
  cascadeAuthObs,
  dataNewDataObs,
  defaultDenyObs,
  divergenceSummary,
  makeVerifyProjectDir,
  multiPathUpdateObs,
  onVerifyTestCleanup,
  openHostedCaptureSession,
  openSharedWorkerCapture,
  outcomeAllowed,
  queryIndexObs,
  queryRulesObs,
  registerVerifyReplayCleanupHooks,
  toWireQuery,
} from './session-verify-replay-support.ts';

registerVerifyReplayCleanupHooks();

describe('pyric verify RTDB reads, listeners, and denials replay grounded in production captures (VR1, VR2)', () => {
  it('VR1: replays allowed RTDB gets and value/child query listeners (including unindexed listeners) while skipping admin reads across all 3 planes', async () => {
    expect(cascadeAuthObs.behavior.ancestorCascadeOverridesChildFalse.authedReadChildFalse.allowed).toBe(true);
    expect(cascadeAuthObs.behavior.pathVariableBindings.ownUidRead.allowed).toBe(true);
    expect(cascadeAuthObs.behavior.authNullVsBoundToken.unauthedOnAuthNullRead.allowed).toBe(true);
    expect(cascadeAuthObs.behavior.authNullVsBoundToken.authedAnonymousProviderRead.allowed).toBe(true);
    expect(queryRulesObs.behavior['orderByChild owner equalTo own uid is allowed']).toBe('ALLOW');
    expect(queryRulesObs.behavior['limitToFirst within the bound is allowed']).toBe('ALLOW');
    expect(queryRulesObs.behavior['orderByKey reads true under orderByKey']).toBe('ALLOW');
    expect(queryRulesObs.behavior['startAt and endAt read the range bounds']).toBe('ALLOW');
    const unindexedListenCase = queryIndexObs.behavior.results['unindexed:orderByChild-limitToFirst'];
    expect(unindexedListenCase?.get.timing).toBe('asynchronous-reject');
    expect(unindexedListenCase?.listen.event).toBe('value');
    expect(unindexedListenCase?.listenLogs.length).toBeGreaterThan(0);

    const sessionRules = {
      rules: {
        ...CASCADE_BINDINGS_AUTH_RULES,
        ...R30_QUERY_RULES,
        unindexedFeed: {
          '.read': "auth != null && query.orderByChild == 'pos' && query.limitToFirst <= 2",
        },
      },
    };
    const tightenedRules = {
      rules: {
        ...CASCADE_BINDINGS_AUTH_RULES,
        ...R30_QUERY_RULES,
        cascadingRead: { '.read': false, childFalse: { '.read': false } },
        items: {
          '.read': "query.orderByChild == 'owner' && query.equalTo == 'nobody'",
          '.indexOn': ['owner'],
        },
        unindexedFeed: { '.read': false },
      },
    };

    // 1. In-process sandbox + buildLiveSessionCaptureFixture + verifyFixture
    const box = initializeSandbox({ projectId: PROJECT_ID });
    onVerifyTestCleanup(() => box.dispose());
    const mainDb = getDatabase(box);
    const adminDb = getAdminDatabase(box);
    rtdbSandbox.setRules(mainDb, sessionRules);
    await set(ref(adminDb, 'cascadingRead/childFalse'), 'cascade-ok');
    await set(ref(adminDb, 'users/alice/profile'), { owner: 'alice' });
    await set(ref(adminDb, 'unauthedOnly'), 'guest-ok');
    await set(ref(adminDb, 'providerBound'), 'anon-ok');
    await set(ref(adminDb, 'items'), { a: { owner: 'alice' }, b: { owner: 'bob' } });
    await set(ref(adminDb, 'firstpage'), { k1: 1, k2: 2, k3: 3 });
    await set(ref(adminDb, 'bykey'), { b: 1, c: 2 });
    await set(ref(adminDb, 'range'), { b: 1, m: 2, z: 3 });
    await set(ref(adminDb, 'unindexedFeed'), { a: { pos: 2 }, b: { pos: 1 } });

    await get(ref(adminDb, 'users/alice/profile'));

    const aliceDb = getDatabase(
      box.withAuth({ uid: 'alice', token: { firebase: { sign_in_provider: 'anonymous' } } }),
    );
    const anonDb = getDatabase(box.withAuth(null));

    expect(await outcomeAllowed(get(ref(aliceDb, 'cascadingRead/childFalse')))).toBe(
      cascadeAuthObs.behavior.ancestorCascadeOverridesChildFalse.authedReadChildFalse.allowed,
    );
    expect(await outcomeAllowed(get(ref(aliceDb, 'users/alice/profile')))).toBe(
      cascadeAuthObs.behavior.pathVariableBindings.ownUidRead.allowed,
    );
    expect(await outcomeAllowed(get(ref(anonDb, 'unauthedOnly')))).toBe(
      cascadeAuthObs.behavior.authNullVsBoundToken.unauthedOnAuthNullRead.allowed,
    );
    expect(await outcomeAllowed(get(ref(aliceDb, 'providerBound')))).toBe(
      cascadeAuthObs.behavior.authNullVsBoundToken.authedAnonymousProviderRead.allowed,
    );
    expect(
      await outcomeAllowed(get(query(ref(aliceDb, 'items'), orderByChild('owner'), equalTo('alice')))),
    ).toBe(true);

    const unsubs = [
      onValue(query(ref(aliceDb, 'items'), orderByChild('owner'), equalTo('alice')), () => {}),
      onChildAdded(query(ref(aliceDb, 'firstpage'), limitToFirst(2)), () => {}),
      onChildChanged(query(ref(aliceDb, 'bykey'), orderByKey()), () => {}),
      onChildRemoved(query(ref(aliceDb, 'range'), orderByKey(), startAt('b'), endAt('m')), () => {}),
      onChildMoved(
        query(ref(aliceDb, 'unindexedFeed'), orderByChild('pos'), limitToFirst(2)),
        () => {},
      ),
    ];
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (const off of unsubs) {
      off();
    }

    const inProcFixture = parseVerifyFixture(
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
    const listenEvents = inProcFixture.events.filter(
      (ev) => ev.kind === 'operation' && ev.method === 'listen' && ev.result === 'allow',
    );
    expect(listenEvents).toHaveLength(5);
    for (const ev of listenEvents) {
      expect(ev.kind === 'operation' && ev.request?.query !== undefined).toBe(true);
    }

    const cleanInProc = await verifyFixture(inProcFixture, { rules: { rtdb: sessionRules } });
    expect({ ok: cleanInProc.ok, checked: cleanInProc.services.rtdb?.checkedEvents }).toEqual({
      ok: true,
      checked: 10,
    });

    const deniedInProc = await verifyFixture(inProcFixture, { rules: { rtdb: tightenedRules } });
    expect(deniedInProc.ok).toBe(false);
    expect(deniedInProc.services.rtdb?.divergences).toEqual([
      expect.objectContaining({ kind: 'now-denied', method: 'get', path: '/cascadingRead/childFalse' }),
      expect.objectContaining({ kind: 'now-denied', method: 'get', path: '/items' }),
      expect.objectContaining({ kind: 'now-denied', method: 'listen', path: '/items' }),
      expect.objectContaining({ kind: 'now-denied', method: 'listen', path: '/unindexedFeed' }),
    ]);

    // 2. SharedWorker applyServeInit capture delivery + verifyFixture
    const worker = await openSharedWorkerCapture(sessionRules);
    const ownerQueryWire = toWireQuery(query(ref(mainDb, 'items'), orderByChild('owner'), equalTo('alice')));
    const unindexedQueryWire = toWireQuery(
      query(ref(mainDb, 'unindexedFeed'), orderByChild('pos'), limitToFirst(2)),
    );
    expect(
      (
        await worker.sendOp({
          method: 'rtdb.set',
          instance: undefined,
          path: 'items',
          value: { a: { owner: 'alice' } },
          actAs: { mode: 'admin' },
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await worker.sendOp({
          method: 'rtdb.get',
          instance: undefined,
          path: 'items',
          actAs: { mode: 'admin' },
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await worker.sendOp({
          method: 'rtdb.get',
          instance: undefined,
          path: 'cascadingRead/childFalse',
          actAs: ALICE_ANON_LENS,
        })
      ).ok,
    ).toBe(true);
    const workerSub1 = await worker.subscribeRtdb({
      path: 'items',
      query: ownerQueryWire,
      event: 'child_added',
      actAs: ALICE_ANON_LENS,
    });
    const workerSub2 = await worker.subscribeRtdb({
      path: 'unindexedFeed',
      query: unindexedQueryWire,
      event: 'value',
      actAs: ALICE_ANON_LENS,
    });
    expect(workerSub1.allowed).toBe(true);
    expect(workerSub2.allowed).toBe(true);
    expect(workerSub2.warning).toContain('Using an unspecified index');
    workerSub1.unsubscribe();
    workerSub2.unsubscribe();

    const workerFixture = await worker.flushFixture();
    const cleanWorker = await verifyFixture(workerFixture, { rules: { rtdb: sessionRules } });
    expect({ ok: cleanWorker.ok, checked: cleanWorker.services.rtdb?.checkedEvents }).toEqual({
      ok: true,
      checked: 3,
    });
    const deniedWorker = await verifyFixture(workerFixture, { rules: { rtdb: tightenedRules } });
    expect(deniedWorker.services.rtdb?.divergences).toEqual([
      expect.objectContaining({ kind: 'now-denied', method: 'get', path: '/cascadingRead/childFalse' }),
      expect.objectContaining({ kind: 'now-denied', method: 'listen', path: '/items' }),
      expect.objectContaining({ kind: 'now-denied', method: 'listen', path: '/unindexedFeed' }),
    ]);

    // 3. Node host (.pyric/last-session.json) + runVerify CLI
    const dir = makeVerifyProjectDir('pyric-vr1-', sessionRules);
    writeFileSync(join(dir, 'tightened.rules.json'), JSON.stringify(tightenedRules));
    const hosted = await openHostedCaptureSession(dir, sessionRules);
    expect(
      (
        await hosted.sendOp({
          method: 'rtdb.set',
          instance: undefined,
          path: 'items',
          value: { a: { owner: 'alice' } },
          actAs: { mode: 'admin' },
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await hosted.sendOp({
          method: 'rtdb.get',
          instance: undefined,
          path: 'items',
          actAs: { mode: 'admin' },
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await hosted.sendOp({
          method: 'rtdb.get',
          instance: undefined,
          path: 'cascadingRead/childFalse',
          actAs: ALICE_ANON_LENS,
        })
      ).ok,
    ).toBe(true);
    const hostedSub1 = await hosted.subscribeRtdb({
      path: 'items',
      query: ownerQueryWire,
      event: 'child_added',
      actAs: ALICE_ANON_LENS,
    });
    const hostedSub2 = await hosted.subscribeRtdb({
      path: 'unindexedFeed',
      query: unindexedQueryWire,
      event: 'value',
      actAs: ALICE_ANON_LENS,
    });
    expect(hostedSub1.allowed && hostedSub2.allowed).toBe(true);
    hostedSub1.unsubscribe();
    hostedSub2.unsubscribe();

    const sessionPath = await hosted.closeAndGetSessionPath();
    const cleanCli = await hosted.runCliVerify(sessionPath, []);
    expect({ code: cleanCli.code, err: cleanCli.err }).toEqual({ code: 0, err: '' });
    const tightenedCli = await hosted.runCliVerify(sessionPath, ['--rules', 'rtdb=tightened.rules.json']);
    expect(tightenedCli.code).toBe(1);
    expect(tightenedCli.out).toContain('now-denied: get /cascadingRead/childFalse');
    expect(tightenedCli.out).toContain('now-denied: listen /items');
    expect(tightenedCli.out).toContain('now-denied: listen /unindexedFeed');
  });

  it('VR2: replays denied RTDB writes, multi-path updates, reads, and listeners against point-in-time state while skipping post-attach revocations across all 3 planes', async () => {
    expect(dataNewDataObs.behavior.createOnceLifecycle.overwriteExistingDenied.permissionDenied).toBe(
      true,
    );
    expect(dataNewDataObs.behavior.createOnceLifecycle.deleteExistingDenied.permissionDenied).toBe(true);
    expect(dataNewDataObs.behavior.monotonicDataVsNewData.lowerValueDenied.permissionDenied).toBe(true);
    expect(dataNewDataObs.behavior.parentAndChildNavigation.readWhileLockedDenied.permissionDenied).toBe(
      true,
    );
    expect(defaultDenyObs.behavior.defaultDenyWhenNoRuleForOperationExists.readOnRulelessBranchDenied.permissionDenied).toBe(
      true,
    );
    expect(defaultDenyObs.behavior.runtimeTypeErrorsFailClosedAsVerdicts.validateCallingBeginsWithOnNumberDenied.permissionDenied).toBe(
      true,
    );
    expect(multiPathUpdateObs.behavior.multiPathAtomicPartialDenialRollback.rejected).toBe(true);
    expect(multiPathUpdateObs.behavior.multiPathAtomicPartialDenialRollback.errorCode).toBe(
      'PERMISSION_DENIED',
    );

    const sessionRules = {
      rules: {
        ...DATA_NEWDATA_SNAPSHOT_RULES,
        ...DEFAULT_DENY_AND_RUNTIME_ERROR_RULES,
        vault: {
          config: { '.read': 'auth != null', '.write': 'auth != null' },
          box: DATA_NEWDATA_SNAPSHOT_RULES.vault.box,
        },
        atomicMixed: {
          allowedBranch: { '.write': 'auth != null' },
          blockedBranch: { '.write': false },
        },
        prioNode: {
          '.read': 'auth != null',
          '.write': 'newData.getPriority() == null',
        },
        boundedList: {
          '.read': 'query.limitToFirst <= 2',
        },
      },
    };
    const halfOpenAtomicRules = {
      rules: {
        ...sessionRules.rules,
        atomicMixed: {
          allowedBranch: { '.write': false },
          blockedBranch: { '.write': true },
        },
      },
    };

    // 1. In-process sandbox + buildLiveSessionCaptureFixture + verifyFixture
    const box = initializeSandbox({ projectId: PROJECT_ID });
    onVerifyTestCleanup(() => box.dispose());
    const mainDb = getDatabase(box);
    const adminDb = getAdminDatabase(box);
    rtdbSandbox.setRules(mainDb, sessionRules);
    await set(ref(adminDb, 'createOnce'), 'locked-seed');
    await set(ref(adminDb, 'counter/count'), 10);
    await set(ref(adminDb, 'vault/config'), { unlocked: true, expectedTag: 'v1' });
    await set(ref(adminDb, 'vault/box'), { tag: 'v1' });
    await set(ref(adminDb, 'atomicMixed'), { allowedBranch: { x: 1 }, blockedBranch: { y: 1 } });
    await set(ref(adminDb, 'prioNode'), 'plain');

    const aliceDb = getDatabase(box.withAuth({ uid: 'alice' }));

    let revokedErrorCount = 0;
    onValue(
      ref(aliceDb, 'vault/box'),
      () => {},
      () => {
        revokedErrorCount += 1;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await set(ref(aliceDb, 'vault/config/unlocked'), false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(revokedErrorCount).toBe(1);

    expect(await outcomeAllowed(set(ref(aliceDb, 'createOnce'), 'overwrite'))).toBe(false);
    expect(await outcomeAllowed(remove(ref(aliceDb, 'createOnce')))).toBe(false);
    await remove(ref(adminDb, 'createOnce'));

    expect(await outcomeAllowed(setWithPriority(ref(aliceDb, 'prioNode'), 'ranked', 5))).toBe(false);
    expect(await outcomeAllowed(setPriority(ref(aliceDb, 'prioNode'), 9))).toBe(false);
    expect(
      await outcomeAllowed(
        runTransaction(ref(aliceDb, 'counter/count'), () => 3, { applyLocally: false }),
      ),
    ).toBe(false);
    expect(
      await outcomeAllowed(
        update(ref(aliceDb, 'atomicMixed'), {
          'allowedBranch/x': 2,
          'blockedBranch/y': 2,
        }),
      ),
    ).toBe(false);
    expect(await outcomeAllowed(get(ref(aliceDb, 'noRulesBranch/leaf')))).toBe(false);
    let deniedValueErr = 0;
    onValue(
      ref(aliceDb, 'vault/box'),
      () => {},
      () => {
        deniedValueErr += 1;
      },
    );
    let deniedChildErr = 0;
    onChildAdded(
      query(ref(aliceDb, 'boundedList'), limitToFirst(10)),
      () => {},
      () => {
        deniedChildErr += 1;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deniedValueErr).toBe(1);
    expect(deniedChildErr).toBe(1);

    const inProcFixture = parseVerifyFixture(
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
    const updateDenial = inProcFixture.events.find(
      (ev) => ev.kind === 'operation' && ev.method === 'update' && ev.result === 'deny',
    );
    expect(
      updateDenial?.kind === 'operation' &&
        (updateDenial.detail as { rootPath?: unknown } | undefined)?.rootPath === '/atomicMixed',
    ).toBe(true);
    const revokedEvent = inProcFixture.events.find(
      (ev) =>
        ev.kind === 'operation' &&
        ev.method === 'listen' &&
        (ev.detail as { revoked?: unknown } | undefined)?.revoked === true,
    );
    expect(revokedEvent).toBeDefined();

    const cleanInProc = await verifyFixture(inProcFixture, { rules: { rtdb: sessionRules } });
    expect(cleanInProc.ok).toBe(true);
    expect(cleanInProc.services.rtdb?.divergences).toEqual([]);

    const halfOpenRes = await verifyFixture(inProcFixture, { rules: { rtdb: halfOpenAtomicRules } });
    expect(halfOpenRes.services.rtdb?.divergences).toEqual([]);

    const openedInProc = await verifyFixture(inProcFixture, { rules: { rtdb: ALLOW_ALL_RULES } });
    expect(openedInProc.ok).toBe(false);
    expect(divergenceSummary(openedInProc.services.rtdb?.divergences)).toEqual([
      'now-allowed:set',
      'now-allowed:remove',
      'now-allowed:set',
      'now-allowed:setPriority',
      'now-allowed:transaction',
      'now-allowed:update',
      'now-allowed:get',
      'now-allowed:listen',
      'now-allowed:listen',
    ]);

    // 2. SharedWorker applyServeInit capture delivery + verifyFixture
    const worker = await openSharedWorkerCapture(sessionRules);
    expect(
      (
        await worker.sendOp({
          method: 'rtdb.set',
          instance: undefined,
          path: 'createOnce',
          value: 'locked-seed',
          actAs: { mode: 'admin' },
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await worker.sendOp({
          method: 'rtdb.set',
          instance: undefined,
          path: 'createOnce',
          value: 'overwrite',
          actAs: { mode: 'as', uid: 'alice' },
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await worker.sendOp({
          method: 'rtdb.update',
          instance: undefined,
          path: 'atomicMixed',
          values: { 'allowedBranch/x': 2, 'blockedBranch/y': 2 },
          actAs: { mode: 'as', uid: 'alice' },
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await worker.sendOp({
          method: 'rtdb.remove',
          instance: undefined,
          path: 'createOnce',
          actAs: { mode: 'admin' },
        })
      ).ok,
    ).toBe(true);

    const workerFixture = await worker.flushFixture();
    expect((await verifyFixture(workerFixture, { rules: { rtdb: sessionRules } })).ok).toBe(true);
    const workerOpened = await verifyFixture(workerFixture, { rules: { rtdb: ALLOW_ALL_RULES } });
    expect(workerOpened.ok).toBe(false);
    expect(divergenceSummary(workerOpened.services.rtdb?.divergences)).toEqual([
      'now-allowed:set',
      'now-allowed:update',
    ]);

    // 3. Node host (.pyric/last-session.json) + runVerify CLI
    const dir = makeVerifyProjectDir('pyric-vr2-', sessionRules);
    writeFileSync(join(dir, 'open.rules.json'), JSON.stringify(ALLOW_ALL_RULES));
    const hosted = await openHostedCaptureSession(dir, sessionRules);
    expect(
      (
        await hosted.sendOp({
          method: 'rtdb.set',
          instance: undefined,
          path: 'createOnce',
          value: 'locked-seed',
          actAs: { mode: 'admin' },
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await hosted.sendOp({
          method: 'rtdb.set',
          instance: undefined,
          path: 'createOnce',
          value: 'overwrite',
          actAs: { mode: 'as', uid: 'alice' },
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await hosted.sendOp({
          method: 'rtdb.update',
          instance: undefined,
          path: 'atomicMixed',
          values: { 'allowedBranch/x': 2, 'blockedBranch/y': 2 },
          actAs: { mode: 'as', uid: 'alice' },
        })
      ).ok,
    ).toBe(false);
    const deniedSub = await hosted.subscribeRtdb({
      path: 'noRulesBranch/leaf',
      event: 'value',
      actAs: { mode: 'as', uid: 'alice' },
    });
    expect(deniedSub.allowed).toBe(false);

    const sessionPath = await hosted.closeAndGetSessionPath();
    const cleanCli = await hosted.runCliVerify(sessionPath, []);
    expect({ code: cleanCli.code, err: cleanCli.err }).toEqual({ code: 0, err: '' });
    const openCli = await hosted.runCliVerify(sessionPath, ['--rules', 'rtdb=open.rules.json']);
    expect(openCli.code).toBe(1);
    expect(openCli.out).toContain('now-allowed: set /createOnce');
    expect(openCli.out).toContain('now-allowed: update');
    expect(openCli.out).toContain('now-allowed: listen /noRulesBranch/leaf');
  });
});
