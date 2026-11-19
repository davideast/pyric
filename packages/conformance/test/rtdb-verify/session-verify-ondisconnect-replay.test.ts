import { describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getAdminDatabase,
  getDatabase,
  goOffline,
  onDisconnect,
  ref,
  sandbox as rtdbSandbox,
  serverTimestamp,
  set,
} from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';
import { buildLiveSessionCaptureFixture } from '../../../cli/dist/serve/session-capture-fixture.js';
import { parseVerifyFixture, verifyFixture } from '../../../cli/dist/verify/index.js';
import {
  ALLOW_ALL_RULES,
  DEFAULT_INSTANCE,
  LOCKED_RULES,
  PROJECT_ID,
  R28_PRESENCE_RULES,
  divergenceSummary,
  makeVerifyProjectDir,
  onDisconnectOpsObs,
  onDisconnectRulesObs,
  onVerifyTestCleanup,
  openHostedCaptureSession,
  openSharedWorkerCapture,
  outcomeAllowed,
  presenceTimingObs,
  registerVerifyReplayCleanupHooks,
} from './session-verify-replay-support.ts';

registerVerifyReplayCleanupHooks();

describe('pyric verify RTDB onDisconnect registration replay grounded in production captures (VR3)', () => {
  it('VR3: records allowed and denied onDisconnect registrations once at registration and replays them across all 3 planes', async () => {
    expect(onDisconnectRulesObs.behavior.registrationDenied.resolved).toBe(false);
    expect(onDisconnectRulesObs.behavior.registrationDenied.error.code).toBe('PERMISSION_DENIED');
    expect(onDisconnectRulesObs.behavior.registeredWhileAllowed.resolved).toBe(true);
    const capturedPriority = onDisconnectOpsObs.behavior.outcomes.setWithPriority['.priority'];
    expect(capturedPriority).toBe(7);
    expect(presenceTimingObs.behavior['a user marks themself online with the server time']).toBe('ALLOW');
    expect(presenceTimingObs.behavior['a user writes presence for someone else']).toBe('DENY');
    expect(presenceTimingObs.behavior['a user removes their presence']).toBe('ALLOW');

    const sessionRules = {
      rules: {
        ...R28_PRESENCE_RULES,
        rankedPresence: {
          $uid: {
            '.read': 'auth != null',
            '.write': `auth != null && auth.uid == $uid && newData.getPriority() == ${capturedPriority}`,
          },
        },
        presenceMeta: {
          $uid: {
            '.read': 'auth != null',
            '.write': 'auth != null && auth.uid == $uid',
          },
        },
      },
    };
    const wrongPriorityRules = {
      rules: {
        ...sessionRules.rules,
        rankedPresence: {
          $uid: {
            '.read': 'auth != null',
            '.write': 'auth != null && auth.uid == $uid && newData.getPriority() == 99',
          },
        },
      },
    };

    // 1. In-process sandbox + buildLiveSessionCaptureFixture + verifyFixture
    const box = initializeSandbox({ projectId: PROJECT_ID });
    onVerifyTestCleanup(() => box.dispose());
    const mainDb = getDatabase(box);
    const adminDb = getAdminDatabase(box);
    rtdbSandbox.setRules(mainDb, sessionRules);
    await set(ref(adminDb, 'status/alice'), { state: 'online', lastChanged: 1_000 });
    await set(ref(adminDb, 'presenceMeta/alice'), { keep: true });

    const aliceDb = getDatabase(box.withAuth({ uid: 'alice' }));
    expect(
      await outcomeAllowed(
        onDisconnect(ref(aliceDb, 'status/alice')).set({
          state: 'offline',
          lastChanged: serverTimestamp(),
        }),
      ),
    ).toBe(true);
    expect(
      await outcomeAllowed(
        onDisconnect(ref(aliceDb, 'rankedPresence/alice')).setWithPriority(
          { after: true },
          capturedPriority,
        ),
      ),
    ).toBe(true);
    expect(
      await outcomeAllowed(onDisconnect(ref(aliceDb, 'presenceMeta/alice')).update({ added: true })),
    ).toBe(true);
    expect(await outcomeAllowed(onDisconnect(ref(aliceDb, 'online/alice')).remove())).toBe(true);
    expect(
      await outcomeAllowed(
        onDisconnect(ref(aliceDb, 'status/bob')).set({
          state: 'offline',
          lastChanged: serverTimestamp(),
        }),
      ),
    ).toBe(false);

    goOffline(aliceDb);

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
    const regEvents = inProcFixture.events.filter(
      (ev) => ev.kind === 'operation' && typeof ev.method === 'string' && ev.method.startsWith('onDisconnect.'),
    );
    expect(
      regEvents.map(
        (ev) => `${ev.kind === 'operation' && ev.method}:${ev.kind === 'operation' && ev.result}`,
      ),
    ).toEqual([
      'onDisconnect.set:allow',
      'onDisconnect.set:allow',
      'onDisconnect.update:allow',
      'onDisconnect.remove:allow',
      'onDisconnect.set:deny',
    ]);

    expect((await verifyFixture(inProcFixture, { rules: { rtdb: sessionRules } })).ok).toBe(true);

    const prioMismatch = await verifyFixture(inProcFixture, { rules: { rtdb: wrongPriorityRules } });
    expect(prioMismatch.ok).toBe(false);
    expect(prioMismatch.services.rtdb?.divergences).toEqual([
      expect.objectContaining({
        kind: 'now-denied',
        method: 'onDisconnect.set',
        path: '/rankedPresence/alice',
      }),
      expect.objectContaining({
        kind: 'now-denied',
        method: 'set',
        path: '/rankedPresence/alice',
      }),
      expect.objectContaining({
        kind: 'state-drift',
        path: '/rankedPresence',
      }),
    ]);

    const lockedRes = await verifyFixture(inProcFixture, { rules: { rtdb: LOCKED_RULES } });
    const lockedOnDisconnectSummaries = divergenceSummary(lockedRes.services.rtdb?.divergences).filter(
      (entry) => entry.startsWith('now-denied:onDisconnect.'),
    );
    expect(lockedOnDisconnectSummaries).toEqual([
      'now-denied:onDisconnect.set',
      'now-denied:onDisconnect.set',
      'now-denied:onDisconnect.update',
      'now-denied:onDisconnect.remove',
    ]);

    const openedRes = await verifyFixture(inProcFixture, { rules: { rtdb: ALLOW_ALL_RULES } });
    expect(openedRes.services.rtdb?.divergences).toEqual([
      expect.objectContaining({ kind: 'now-allowed', method: 'onDisconnect.set', path: '/status/bob' }),
    ]);

    // 2. SharedWorker applyServeInit capture delivery + verifyFixture
    const worker = await openSharedWorkerCapture(sessionRules);
    expect(
      (
        await worker.sendOp({
          method: 'rtdb.onDisconnectSet',
          instance: undefined,
          connectionId: 'tab-1',
          path: 'rankedPresence/alice',
          value: { after: true },
          priority: capturedPriority,
          actAs: { mode: 'as', uid: 'alice' },
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await worker.sendOp({
          method: 'rtdb.onDisconnectUpdate',
          instance: undefined,
          connectionId: 'tab-1',
          path: 'presenceMeta/alice',
          values: { added: true },
          actAs: { mode: 'as', uid: 'alice' },
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await worker.sendOp({
          method: 'rtdb.onDisconnectRemove',
          instance: undefined,
          connectionId: 'tab-1',
          path: 'online/alice',
          actAs: { mode: 'as', uid: 'alice' },
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await worker.sendOp({
          method: 'rtdb.onDisconnectSet',
          instance: undefined,
          connectionId: 'tab-1',
          path: 'online/bob',
          value: false,
          actAs: { mode: 'as', uid: 'alice' },
        })
      ).ok,
    ).toBe(false);

    const workerFixture = await worker.flushFixture();
    expect((await verifyFixture(workerFixture, { rules: { rtdb: sessionRules } })).ok).toBe(true);
    const workerLocked = await verifyFixture(workerFixture, { rules: { rtdb: LOCKED_RULES } });
    expect(divergenceSummary(workerLocked.services.rtdb?.divergences)).toEqual([
      'now-denied:onDisconnect.set',
      'now-denied:onDisconnect.update',
      'now-denied:onDisconnect.remove',
    ]);
    const workerOpened = await verifyFixture(workerFixture, { rules: { rtdb: ALLOW_ALL_RULES } });
    expect(workerOpened.services.rtdb?.divergences).toEqual([
      expect.objectContaining({ kind: 'now-allowed', method: 'onDisconnect.set', path: '/online/bob' }),
    ]);

    // 3. Node host (.pyric/last-session.json) + runVerify CLI
    const dir = makeVerifyProjectDir('pyric-vr3-', sessionRules);
    writeFileSync(join(dir, 'locked.rules.json'), JSON.stringify(LOCKED_RULES));
    writeFileSync(join(dir, 'open.rules.json'), JSON.stringify(ALLOW_ALL_RULES));
    const hosted = await openHostedCaptureSession(dir, sessionRules);
    expect(
      (
        await hosted.sendOp({
          method: 'rtdb.onDisconnectSet',
          instance: undefined,
          connectionId: 'node-1',
          path: 'rankedPresence/alice',
          value: { after: true },
          priority: capturedPriority,
          actAs: { mode: 'as', uid: 'alice' },
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await hosted.sendOp({
          method: 'rtdb.onDisconnectUpdate',
          instance: undefined,
          connectionId: 'node-1',
          path: 'presenceMeta/alice',
          values: { added: true },
          actAs: { mode: 'as', uid: 'alice' },
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await hosted.sendOp({
          method: 'rtdb.onDisconnectRemove',
          instance: undefined,
          connectionId: 'node-1',
          path: 'online/alice',
          actAs: { mode: 'as', uid: 'alice' },
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await hosted.sendOp({
          method: 'rtdb.onDisconnectSet',
          instance: undefined,
          connectionId: 'node-1',
          path: 'online/bob',
          value: false,
          actAs: { mode: 'as', uid: 'alice' },
        })
      ).ok,
    ).toBe(false);

    const sessionPath = await hosted.closeAndGetSessionPath();
    const cleanCli = await hosted.runCliVerify(sessionPath, []);
    expect({ code: cleanCli.code, err: cleanCli.err }).toEqual({ code: 0, err: '' });
    const lockedCli = await hosted.runCliVerify(sessionPath, ['--rules', 'rtdb=locked.rules.json']);
    expect(lockedCli.code).toBe(1);
    expect(lockedCli.out).toContain('now-denied: onDisconnect.set /rankedPresence/alice');
    expect(lockedCli.out).toContain('now-denied: onDisconnect.update /presenceMeta/alice');
    expect(lockedCli.out).toContain('now-denied: onDisconnect.remove /online/alice');
    const openCli = await hosted.runCliVerify(sessionPath, ['--rules', 'rtdb=open.rules.json']);
    expect(openCli.code).toBe(1);
    expect(openCli.out).toContain('now-allowed: onDisconnect.set /online/bob');
  });
});
