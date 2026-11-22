import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildChildEnv, registerModuleUrl } from '../../src/cli/sandbox-runner.js';
import type { FunctionsChildEvent } from '../../src/functions/child-protocol.js';
import { spawnFunctionsChild, type FunctionsChildHandle } from '../../src/functions/spawn.js';
import { connectRemoteSandbox, type RemoteSandbox } from '../../src/remote/index.js';
import {
  createUserWithEmailAndPassword,
  getAuth as getClientAuth,
  listUsers,
  sendAuthSmsVerification,
  sendPasswordResetEmail,
  signOut,
  takeAuthMail,
  takeAuthSms,
  type ClientDb,
} from '../../src/serve/worker/client.js';
import { trackTempDirs } from '../use-temp-dirs.js';
import {
  childModule,
  createChannelClientPort,
  repoRoot,
  startNodeHostedRuntime,
  type HostedNodeServer,
} from './hosted-harness.js';

describe('live child timeoutSeconds DEADLINE_EXCEEDED, uncaught error survival, and crash respawn against HostedRuntime', () => {
  const tempDirs = trackTempDirs('pyric-fn-identity-timeout-crash-');
  let fixtureDir = '';
  let hosted: HostedNodeServer | undefined;
  let observer: RemoteSandbox | undefined;
  let activeChild: FunctionsChildHandle | undefined;
  const clientConnections: RemoteSandbox[] = [];

  async function makeClientSession() {
    if (!hosted) throw new Error('hosted runtime not initialized');
    const conn = await connectRemoteSandbox({
      cwd: fixtureDir,
      url: hosted.url,
      sessionToken: hosted.sessionToken,
    });
    clientConnections.push(conn);
    const port = createChannelClientPort(conn);
    const db: ClientDb = { __kind: 'client-db', type: 'firestore', port };
    return { conn, port, auth: getClientAuth(db) };
  }

  async function stopActiveChild(): Promise<number | undefined> {
    const current = activeChild;
    activeChild = undefined;
    if (!current) return undefined;
    return current.stop();
  }

  function spawnCjsChild(events: FunctionsChildEvent[] = []): FunctionsChildHandle {
    if (!hosted) throw new Error('hosted runtime not initialized');
    const handle = spawnFunctionsChild({
      cwd: join(fixtureDir, 'functions-cjs'),
      entry: join(fixtureDir, 'functions-cjs/index.js'),
      env: buildChildEnv(process.env, {
        serveUrl: hosted.url,
        registerUrl: registerModuleUrl(),
        instanceId: hosted.instanceId,
        sessionToken: hosted.sessionToken,
      }),
      instance: 'demo-project-default-rtdb',
      location: 'us-central1',
      projectId: 'demo-project',
      childModuleUrl: pathToFileURL(childModule),
      onEvent(ev) {
        events.push(ev);
      },
    });
    activeChild = handle;
    return handle;
  }

  async function waitForRtdbValue(path: string, timeoutMs = 8_000): Promise<unknown> {
    if (!observer) throw new Error('observer not initialized');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await observer.rtdb.get(path);
      if (value !== null && value !== undefined) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for RTDB path ${path}`);
  }

  beforeAll(async () => {
    if (!existsSync(childModule)) {
      throw new Error(`Functions child is not built: ${childModule}`);
    }
    fixtureDir = tempDirs.makeTempDir();
    mkdirSync(join(fixtureDir, 'public'), { recursive: true });
    mkdirSync(join(fixtureDir, 'functions-cjs/node_modules'), { recursive: true });
    writeFileSync(join(fixtureDir, 'public/index.html'), '<!doctype html><body>timeout</body>');
    writeFileSync(
      join(fixtureDir, 'firebase.json'),
      JSON.stringify({ hosting: { public: 'public' } }),
    );
    writeFileSync(
      join(fixtureDir, 'functions-cjs/package.json'),
      JSON.stringify({ name: 'identity-timeout-crash-cjs', private: true, type: 'commonjs' }),
    );
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(fixtureDir, 'functions-cjs/node_modules/firebase-functions'),
    );
    symlinkSync(
      join(repoRoot, 'packages/pyric-admin'),
      join(fixtureDir, 'functions-cjs/node_modules/firebase-admin'),
    );

    hosted = await startNodeHostedRuntime(fixtureDir, 'demo-project');
    observer = await connectRemoteSandbox({
      cwd: fixtureDir,
      url: hosted.url,
      sessionToken: hosted.sessionToken,
    });
  }, 30_000);

  afterAll(async () => {
    await stopActiveChild();
    for (const conn of clientConnections) {
      conn.close();
    }
    observer?.close();
    await hosted?.stop();
    tempDirs.cleanupTempDirs();
  }, 15_000);

  test('enforces per-trigger timeoutSeconds (DEADLINE_EXCEEDED) across all 4 triggers without leaking state or hanging stop()', async () => {
    writeFileSync(
      join(fixtureDir, 'functions-cjs/index.js'),
      [
        "const { setGlobalOptions } = require('firebase-functions/v2/options');",
        "const { beforeUserCreated, beforeUserSignedIn, beforeEmailSent, beforeSmsSent } = require('firebase-functions/v2/identity');",
        '',
        'setGlobalOptions({ timeoutSeconds: 0.08 });',
        '',
        'exports.guardCreate = beforeUserCreated(async (event) => {',
        '  if ((event.data.email || "").startsWith("stall-create@")) {',
        '    await new Promise(() => {});',
        '  }',
        '  return { displayName: "Fast Create" };',
        '});',
        '',
        'exports.guardSignIn = beforeUserSignedIn({ timeoutSeconds: 0.08 }, async (event) => {',
        '  if ((event.data.email || "").startsWith("stall-signin@")) {',
        '    await new Promise(() => {});',
        '  }',
        '  return { sessionClaims: { fast: true } };',
        '});',
        '',
        'exports.guardEmail = beforeEmailSent({ timeoutSeconds: 0.08 }, async (event) => {',
        '  const email = event.additionalUserInfo ? event.additionalUserInfo.email : "";',
        '  if (email.startsWith("stall-mail@")) {',
        '    await new Promise(() => {});',
        '  }',
        '  return { recaptchaActionOverride: "ALLOW" };',
        '});',
        '',
        'exports.guardSms = beforeSmsSent({ timeoutSeconds: 0.08 }, async (event) => {',
        '  const phone = event.additionalUserInfo ? event.additionalUserInfo.phoneNumber : "";',
        '  if (phone === "+15550107777") {',
        '    await new Promise(() => {});',
        '  }',
        '  return { recaptchaActionOverride: "ALLOW" };',
        '});',
      ].join('\n'),
    );

    const events: FunctionsChildEvent[] = [];
    const child = spawnCjsChild(events);
    await child.ready;

    const session = await makeClientSession();
    const fastUser = await createUserWithEmailAndPassword(
      session.auth,
      'stall-mail@example.com',
      'password123',
    );
    expect(fastUser.user.displayName).toBe('Fast Create');
    await signOut(session.auth);

    let createTimeoutErr: Error | undefined;
    try {
      await createUserWithEmailAndPassword(
        session.auth,
        'stall-create@example.com',
        'password123',
      );
    } catch (err) {
      createTimeoutErr = err as Error;
    }
    expect(createTimeoutErr?.message).toContain('DEADLINE_EXCEEDED');
    expect((await listUsers(session.auth)).some((u) => u.email === 'stall-create@example.com')).toBe(
      false,
    );

    let signInTimeoutErr: Error | undefined;
    try {
      await createUserWithEmailAndPassword(
        session.auth,
        'stall-signin@example.com',
        'password123',
      );
    } catch (err) {
      signInTimeoutErr = err as Error;
    }
    expect(signInTimeoutErr?.message).toContain('DEADLINE_EXCEEDED');
    expect(session.auth.currentUser).toBeNull();

    let emailTimeoutErr: Error | undefined;
    try {
      await sendPasswordResetEmail(session.auth, 'stall-mail@example.com');
    } catch (err) {
      emailTimeoutErr = err as Error;
    }
    expect(emailTimeoutErr?.message).toContain('DEADLINE_EXCEEDED');
    expect(await takeAuthMail(session.auth, 'stall-mail@example.com')).toBeNull();

    let smsTimeoutErr: Error | undefined;
    try {
      await sendAuthSmsVerification(session.auth, {
        phoneNumber: '+15550107777',
        smsType: 'SIGN_IN_OR_SIGN_UP',
      });
    } catch (err) {
      smsTimeoutErr = err as Error;
    }
    expect(smsTimeoutErr?.message).toContain('DEADLINE_EXCEEDED');
    expect(await takeAuthSms(session.auth, '+15550107777')).toBeNull();

    const okFollowUp = await createUserWithEmailAndPassword(
      session.auth,
      'after-timeout-ok@example.com',
      'password123',
    );
    expect(okFollowUp.user.displayName).toBe('Fast Create');

    const rejectedEvents = events.filter(
      (ev): ev is Extract<FunctionsChildEvent, { type: 'execution' }> =>
        ev.type === 'execution' && ev.status === 'rejected',
    );
    expect(rejectedEvents.length).toBeGreaterThanOrEqual(4);

    const stopStarted = Date.now();
    const exitCode = await stopActiveChild();
    expect(exitCode).toBe(0);
    expect(Date.now() - stopStarted).toBeLessThan(2_500);
  }, 20_000);

  test('fails closed with INTERNAL on uncaught handler errors while keeping live child healthy', async () => {
    writeFileSync(
      join(fixtureDir, 'functions-cjs/index.js'),
      [
        "const { beforeUserCreated, beforeEmailSent } = require('firebase-functions/v2/identity');",
        '',
        'exports.crashyCreate = beforeUserCreated(async (event) => {',
        '  if ((event.data.email || "").startsWith("throw-typeerror@")) {',
        '    throw new TypeError("unexpected null dereference");',
        '  }',
        '  return { displayName: "Healthy Create" };',
        '});',
        '',
        'exports.crashyEmail = beforeEmailSent(async (event) => {',
        '  const email = event.additionalUserInfo ? event.additionalUserInfo.email : "";',
        '  if (email.startsWith("throw-email@")) {',
        '    return Promise.reject(new RangeError("email template crash"));',
        '  }',
        '  return {};',
        '});',
      ].join('\n'),
    );

    const child = spawnCjsChild();
    await child.ready;

    const session = await makeClientSession();
    let createCrashErr: Error | undefined;
    try {
      await createUserWithEmailAndPassword(
        session.auth,
        'throw-typeerror@example.com',
        'password123',
      );
    } catch (err) {
      createCrashErr = err as Error;
    }
    expect(createCrashErr?.message).toContain('INTERNAL');
    expect((await listUsers(session.auth)).some((u) => u.email === 'throw-typeerror@example.com')).toBe(
      false,
    );

    const survivor = await createUserWithEmailAndPassword(
      session.auth,
      'throw-email@example.com',
      'password123',
    );
    expect(survivor.user.displayName).toBe('Healthy Create');

    let emailCrashErr: Error | undefined;
    try {
      await sendPasswordResetEmail(session.auth, 'throw-email@example.com');
    } catch (err) {
      emailCrashErr = err as Error;
    }
    expect(emailCrashErr?.message).toContain('INTERNAL');
    expect(await takeAuthMail(session.auth, 'throw-email@example.com')).toBeNull();

    expect(await stopActiveChild()).toBe(0);
  }, 20_000);

  test('fails closed with UNAVAILABLE on mid-call child crash and recovers cleanly on respawn', async () => {
    writeFileSync(
      join(fixtureDir, 'functions-cjs/index.js'),
      [
        "const { initializeApp, getApps } = require('firebase-admin/app');",
        "const { getDatabase } = require('firebase-admin/database');",
        "const { beforeUserCreated } = require('firebase-functions/v2/identity');",
        '',
        'exports.hangForKill = beforeUserCreated(async (event) => {',
        '  if (getApps().length === 0) initializeApp();',
        '  if ((event.data.email || "").startsWith("crash-midflight@")) {',
        '    await getDatabase().ref("crashLatch/entered").set(true);',
        '    await new Promise(() => {});',
        '  }',
        '  return { displayName: "Generation 1" };',
        '});',
      ].join('\n'),
    );

    const doomedChild = spawnCjsChild();
    await doomedChild.ready;

    const session = await makeClientSession();
    // Attach the rejection handler immediately: once the child is killed, the
    // host can deliver UNAVAILABLE over the socket before the child process
    // `close` event resolves `doomedChild.exited`.
    const midFlightSignUpOutcome: Promise<
      { ok: true } | { ok: false; error: unknown }
    > = createUserWithEmailAndPassword(
      session.auth,
      'crash-midflight@example.com',
      'password123',
    ).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await waitForRtdbValue('crashLatch/entered');

    doomedChild.child.kill('SIGKILL');
    const [, outcome] = await Promise.all([doomedChild.exited, midFlightSignUpOutcome]);
    activeChild = undefined;

    let disconnectErr: (Error & { code?: string }) | undefined;
    if (!outcome.ok && outcome.error instanceof Error) {
      disconnectErr = outcome.error as Error & { code?: string };
    }
    expect(outcome.ok).toBe(false);
    expect(disconnectErr?.code).toBe('auth/internal-error');
    expect(disconnectErr?.message).toContain('UNAVAILABLE');
    expect(
      (await listUsers(session.auth)).some((u) => u.email === 'crash-midflight@example.com'),
    ).toBe(false);

    writeFileSync(
      join(fixtureDir, 'functions-cjs/index.js'),
      [
        "const { beforeUserCreated, beforeUserSignedIn } = require('firebase-functions/v2/identity');",
        'exports.recoveredCreate = beforeUserCreated(() => ({',
        '  displayName: "Generation 2 Recovered",',
        '  customClaims: { gen: 2 },',
        '}));',
        'exports.recoveredSignIn = beforeUserSignedIn(() => ({',
        '  sessionClaims: { reconnected: true },',
        '}));',
      ].join('\n'),
    );

    const replacement = spawnCjsChild();
    await replacement.ready;

    const recovered = await createUserWithEmailAndPassword(
      session.auth,
      'crash-midflight@example.com',
      'password123',
    );
    expect(recovered.user.displayName).toBe('Generation 2 Recovered');
    const recToken = await recovered.user.getIdTokenResult();
    expect(recToken.claims.gen).toBe(2);
    expect(recToken.claims.reconnected).toBe(true);

    expect(await stopActiveChild()).toBe(0);
  }, 20_000);
});
