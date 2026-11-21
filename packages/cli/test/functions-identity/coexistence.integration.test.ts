import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildChildEnv, registerModuleUrl } from '../../src/cli/sandbox-runner.js';
import type { FunctionsChildEvent } from '../../src/functions/child-protocol.js';
import {
  createFunctionsDevelopmentRuntime,
  createHttpFunctionsPeerReadiness,
} from '../../src/functions/development-runtime.js';
import { spawnFunctionsChild, type FunctionsChildHandle } from '../../src/functions/spawn.js';
import { connectRemoteSandbox, type RemoteSandbox } from '../../src/remote/index.js';
import {
  createUserWithEmailAndPassword,
  getAuth as getClientAuth,
  sendAuthSmsVerification,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
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

describe('4-trigger CJS and ESM Identity blocking co-existence and reload lifecycle against HostedRuntime', () => {
  const tempDirs = trackTempDirs('pyric-fn-identity-coexist-');
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

  function spawnFixtureChild(
    subdir: 'functions-cjs' | 'functions-esm',
    entryFile: string,
    events: FunctionsChildEvent[] = [],
  ): FunctionsChildHandle {
    if (!hosted) throw new Error('hosted runtime not initialized');
    const handle = spawnFunctionsChild({
      cwd: join(fixtureDir, subdir),
      entry: join(fixtureDir, subdir, entryFile),
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
    mkdirSync(join(fixtureDir, 'functions-esm/node_modules'), { recursive: true });
    writeFileSync(join(fixtureDir, 'public/index.html'), '<!doctype html><body>coexist</body>');
    writeFileSync(
      join(fixtureDir, 'firebase.json'),
      JSON.stringify({ hosting: { public: 'public' } }),
    );
    writeFileSync(
      join(fixtureDir, 'functions-cjs/package.json'),
      JSON.stringify({ name: 'identity-coexist-cjs', private: true, type: 'commonjs' }),
    );
    writeFileSync(
      join(fixtureDir, 'functions-esm/package.json'),
      JSON.stringify({ name: 'identity-coexist-esm', private: true, type: 'module' }),
    );
    for (const dir of ['functions-cjs', 'functions-esm']) {
      symlinkSync(
        join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
        join(fixtureDir, dir, 'node_modules/firebase-functions'),
      );
      symlinkSync(
        join(repoRoot, 'packages/pyric-admin'),
        join(fixtureDir, dir, 'node_modules/firebase-admin'),
      );
    }

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

  test('co-exists all 4 CJS blocking triggers in one codebase with shared onInit, chaining, and outboxes', async () => {
    writeFileSync(
      join(fixtureDir, 'functions-cjs/index.js'),
      [
        "const { initializeApp, getApps } = require('firebase-admin/app');",
        "const { getDatabase } = require('firebase-admin/database');",
        "const { onInit } = require('firebase-functions/v2/core');",
        "const { beforeUserCreated, beforeUserSignedIn, beforeEmailSent, beforeSmsSent, HttpsError } = require('firebase-functions/v2/identity');",
        '',
        'let sharedBanner = "unset";',
        'onInit(() => {',
        '  if (getApps().length === 0) initializeApp();',
        '  sharedBanner = "init-ready";',
        '});',
        '',
        'exports.onCreateGuard = beforeUserCreated(async (event) => {',
        '  await getDatabase().ref("coexistCjs/create").set({ banner: sharedBanner, uid: event.data.uid });',
        '  return { displayName: "CJS Coexist", customClaims: { tier: "pro" } };',
        '});',
        '',
        'exports.onSignInGuard = beforeUserSignedIn(async (event) => {',
        '  const firstLogin = event.data.metadata.lastSignInTime === null;',
        '  await getDatabase().ref("coexistCjs/signIn").set({',
        '    banner: sharedBanner,',
        '    tierSeen: event.data.customClaims ? event.data.customClaims.tier : null,',
        '    firstLogin,',
        '  });',
        '  if (firstLogin) {',
        '    return { sessionClaims: { onboardingPass: true } };',
        '  }',
        '  return {};',
        '});',
        '',
        'exports.onEmailGuard = beforeEmailSent(async (event) => {',
        '  const email = event.additionalUserInfo ? event.additionalUserInfo.email : "";',
        '  if (email.startsWith("deny-mail@")) {',
        '    throw new HttpsError("permission-denied", "Email blocked by 4-trigger suite");',
        '  }',
        '  return { recaptchaActionOverride: "ALLOW" };',
        '});',
        '',
        'exports.onSmsGuard = beforeSmsSent(async (event) => {',
        '  const phone = event.additionalUserInfo ? event.additionalUserInfo.phoneNumber : "";',
        '  if (phone === "+15550109999") {',
        '    throw new HttpsError("resource-exhausted", "SMS blocked by 4-trigger suite");',
        '  }',
        '  return { recaptchaActionOverride: "ALLOW" };',
        '});',
      ].join('\n'),
    );

    const events: FunctionsChildEvent[] = [];
    const child = spawnFixtureChild('functions-cjs', 'index.js', events);
    const ready = await child.ready;
    expect(ready.triggerCount).toBe(4);
    expect(ready.unsupportedTriggers).toEqual([]);

    const session = await makeClientSession();
    const created = await createUserWithEmailAndPassword(
      session.auth,
      'coexist-cjs@example.com',
      'password123',
    );
    expect(created.user.displayName).toBe('CJS Coexist');
    const firstToken = await created.user.getIdTokenResult();
    expect(firstToken.claims.tier).toBe('pro');
    expect(firstToken.claims.onboardingPass).toBe(true);

    expect(await waitForRtdbValue('coexistCjs/create')).toEqual({
      banner: 'init-ready',
      uid: created.user.uid,
    });
    expect(await waitForRtdbValue('coexistCjs/signIn')).toEqual({
      banner: 'init-ready',
      tierSeen: 'pro',
      firstLogin: true,
    });

    await sendEmailVerification(created.user);
    const verifMail = await takeAuthMail(session.auth, 'coexist-cjs@example.com');
    expect(verifMail?.operation).toBe('VERIFY_EMAIL');

    await signOut(session.auth);
    const relogin = await signInWithEmailAndPassword(
      session.auth,
      'coexist-cjs@example.com',
      'password123',
    );
    const secondToken = await relogin.user.getIdTokenResult();
    expect(secondToken.claims.tier).toBe('pro');
    expect(secondToken.claims.onboardingPass).toBeUndefined();

    const anonSms = await sendAuthSmsVerification(session.auth, {
      phoneNumber: '+15550109901',
      smsType: 'SIGN_IN_OR_SIGN_UP',
    });
    expect(anonSms.recaptchaActionOverride).toBe('ALLOW');
    expect((await takeAuthSms(session.auth, '+15550109901'))?.code).toBe(anonSms.code);

    const mfaSms = await sendAuthSmsVerification(session.auth, {
      phoneNumber: '+15550109902',
      smsType: 'MULTI_FACTOR_ENROLLMENT',
      uid: created.user.uid,
    });
    expect((await takeAuthSms(session.auth, '+15550109902'))?.code).toBe(mfaSms.code);

    let smsBlockedErr: Error | undefined;
    try {
      await sendAuthSmsVerification(session.auth, {
        phoneNumber: '+15550109999',
        smsType: 'SIGN_IN_OR_SIGN_UP',
      });
    } catch (err) {
      smsBlockedErr = err as Error;
    }
    expect(smsBlockedErr?.message).toContain('RESOURCE_EXHAUSTED');
    expect(await takeAuthSms(session.auth)).toBeNull();

    const smsSubjects = events
      .filter(
        (ev): ev is Extract<FunctionsChildEvent, { type: 'execution' }> =>
          ev.type === 'execution' && ev.exportName === 'onSmsGuard',
      )
      .map((ev) => ev.ref);
    expect(smsSubjects).toContain('auth/sms/+15550109901');
    expect(smsSubjects).toContain(`auth/users/${created.user.uid}`);

    expect(await stopActiveChild()).toBe(0);
  }, 20_000);

  test('co-exists all 4 ESM blocking triggers (.mjs) in one codebase with shared onInit', async () => {
    writeFileSync(
      join(fixtureDir, 'functions-esm/index.mjs'),
      [
        "import { initializeApp, getApps } from 'firebase-admin/app';",
        "import { onInit } from 'firebase-functions/v2/core';",
        "import { beforeUserCreated, beforeUserSignedIn, beforeEmailSent, beforeSmsSent } from 'firebase-functions/v2/identity';",
        '',
        'let esmInitTag = "cold";',
        'onInit(() => {',
        '  if (getApps().length === 0) initializeApp();',
        '  esmInitTag = "esm-warm";',
        '});',
        '',
        'export const esmCreate = beforeUserCreated(() => ({',
        '  displayName: `ESM:${esmInitTag}`,',
        '  customClaims: { runtime: "esm" },',
        '}));',
        'export const esmSignIn = beforeUserSignedIn(() => ({',
        '  sessionClaims: { initTag: esmInitTag },',
        '}));',
        'export const esmEmail = beforeEmailSent(() => ({ recaptchaActionOverride: "ALLOW" }));',
        'export const esmSms = beforeSmsSent(() => ({ recaptchaActionOverride: "BLOCK" }));',
      ].join('\n'),
    );

    const child = spawnFixtureChild('functions-esm', 'index.mjs');
    const ready = await child.ready;
    expect(ready.triggerCount).toBe(4);
    expect(ready.unsupportedTriggers).toEqual([]);

    const session = await makeClientSession();
    const cred = await createUserWithEmailAndPassword(
      session.auth,
      'coexist-esm@example.com',
      'password123',
    );
    expect(cred.user.displayName).toBe('ESM:esm-warm');
    const tokenRes = await cred.user.getIdTokenResult();
    expect(tokenRes.claims.runtime).toBe('esm');
    expect(tokenRes.claims.initTag).toBe('esm-warm');

    await sendPasswordResetEmail(session.auth, 'coexist-esm@example.com');
    expect((await takeAuthMail(session.auth, 'coexist-esm@example.com'))?.operation).toBe(
      'PASSWORD_RESET',
    );

    const sms = await sendAuthSmsVerification(session.auth, {
      phoneNumber: '+15550108801',
      smsType: 'SIGN_IN_OR_SIGN_UP',
    });
    expect(sms.recaptchaActionOverride).toBe('BLOCK');
    expect((await takeAuthSms(session.auth, '+15550108801'))?.recaptchaActionOverride).toBe(
      'BLOCK',
    );

    expect(await stopActiveChild()).toBe(0);
  }, 20_000);

  test('reloads and closes FunctionsDevelopmentRuntime with all 4 triggers leaving zero leaked child processes', async () => {
    if (!hosted) throw new Error('hosted runtime not initialized');
    writeFileSync(
      join(fixtureDir, 'functions-cjs/index.js'),
      [
        "const { beforeUserCreated, beforeUserSignedIn, beforeEmailSent, beforeSmsSent } = require('firebase-functions/v2/identity');",
        'exports.c1 = beforeUserCreated(() => ({ displayName: "DevRuntime V1" }));',
        'exports.c2 = beforeUserSignedIn(() => ({ sessionClaims: { v: 1 } }));',
        'exports.c3 = beforeEmailSent(() => ({}));',
        'exports.c4 = beforeSmsSent(() => ({}));',
      ].join('\n'),
    );

    const devRuntime = createFunctionsDevelopmentRuntime({
      sourceDir: join(fixtureDir, 'functions-cjs'),
      entry: join(fixtureDir, 'functions-cjs/index.js'),
      baseEnv: process.env,
      serveUrl: hosted.url,
      registerUrl: registerModuleUrl(),
      hostInstanceId: hosted.instanceId,
      sessionToken: hosted.sessionToken,
      instance: 'demo-project-default-rtdb',
      location: 'us-central1',
      projectId: 'demo-project',
      childModuleUrl: pathToFileURL(childModule),
      readiness: createHttpFunctionsPeerReadiness(hosted.url),
    });

    const started = await devRuntime.start();
    expect(started.kind).toBe('ready');
    if (started.kind === 'ready') {
      expect(started.ready.triggerCount).toBe(4);
    }

    writeFileSync(
      join(fixtureDir, 'functions-cjs/index.js'),
      [
        "const { beforeUserCreated, beforeUserSignedIn, beforeEmailSent, beforeSmsSent } = require('firebase-functions/v2/identity');",
        'exports.c1 = beforeUserCreated(() => ({ displayName: "DevRuntime V2" }));',
        'exports.c2 = beforeUserSignedIn(() => ({ sessionClaims: { v: 2 } }));',
        'exports.c3 = beforeEmailSent(() => ({}));',
        'exports.c4 = beforeSmsSent(() => ({}));',
      ].join('\n'),
    );

    const reloaded = await devRuntime.reload();
    expect(reloaded.kind).toBe('ready');

    const session = await makeClientSession();
    const cred = await createUserWithEmailAndPassword(
      session.auth,
      'dev-reload@example.com',
      'password123',
    );
    expect(cred.user.displayName).toBe('DevRuntime V2');
    const token = await cred.user.getIdTokenResult();
    expect(token.claims.v).toBe(2);

    await devRuntime.close();

    const psOut = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    const leaked = psOut
      .split('\n')
      .filter((line) => line.includes(fixtureDir) && line.includes('dist/functions/child.js'));
    expect(leaked).toEqual([]);
  }, 20_000);
});
