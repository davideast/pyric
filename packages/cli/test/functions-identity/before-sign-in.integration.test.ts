import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mintCustomToken } from 'pyric/sandbox/internal';
import { buildChildEnv, registerModuleUrl } from '../../src/cli/sandbox-runner.js';
import { spawnFunctionsChild, type FunctionsChildHandle } from '../../src/functions/spawn.js';
import { connectRemoteSandbox, type RemoteSandbox } from '../../src/remote/index.js';
import {
  adminCreateUser,
  createUserWithEmailAndPassword,
  doc,
  getAuth as getClientAuth,
  getDoc,
  listUsers,
  sendSignInLinkToEmail,
  setDoc,
  setFirestoreRules,
  setProviderConfig,
  signInAnonymously,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signInWithEmailLink,
  signOut,
  stageSignInResult,
  takeAuthMail,
  type ClientDb,
} from '../../src/serve/worker/client.js';
import { trackTempDirs } from '../use-temp-dirs.js';
import {
  childModule,
  createChannelClientPort,
  makeTestOidcJwt,
  repoRoot,
  startNodeHostedRuntime,
  type HostedNodeServer,
} from './hosted-harness.js';

interface RecordedSignInAudit {
  onInitRan: boolean;
  eventType: string;
  authType: string;
  resourceName: string;
  uid: string | null;
  email: string | null;
  displayNameSeen: string | null;
  customClaimsSeen: Record<string, unknown> | null;
  isNewUser: boolean | null;
  providerId: string | null;
  credentialIdToken: string | null;
  credentialAccessToken: string | null;
  credentialRefreshToken: string | null;
}

describe('isolated CJS beforeUserSignedIn child against live HostedRuntime', () => {
  const tempDirs = trackTempDirs('pyric-fn-identity-signin-');
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
    return {
      conn,
      port,
      auth: getClientAuth(db),
      firestore: db,
    };
  }

  function writeFunctionsEntry(options: {
    idToken: boolean;
    accessToken: boolean;
    refreshToken: boolean;
  }): void {
    writeFileSync(
      join(fixtureDir, 'functions/index.js'),
      [
        "const { initializeApp, getApps } = require('firebase-admin/app');",
        "const { getAuth } = require('firebase-admin/auth');",
        "const { getDatabase } = require('firebase-admin/database');",
        "const { onInit } = require('firebase-functions/v2/core');",
        "const { onValueCreated } = require('firebase-functions/v2/database');",
        "const { beforeUserCreated, beforeUserSignedIn, HttpsError } = require('firebase-functions/v2/identity');",
        '',
        'let initExecuted = false;',
        'onInit(() => {',
        '  if (getApps().length === 0) initializeApp();',
        '  initExecuted = true;',
        '});',
        '',
        'exports.prepareCreated = beforeUserCreated(async (event) => {',
        '  const email = event.data && event.data.email ? event.data.email : null;',
        '  const uid = event.data ? event.data.uid : null;',
        "  await getDatabase().ref('sequence/' + (uid || 'none') + '/create').set({",
        '    eventType: event.eventType,',
        '    isNewUser: event.additionalUserInfo ? event.additionalUserInfo.isNewUser : null,',
        '  });',
        '  return {',
        "    displayName: email ? ('Created:' + email.split('@')[0]) : ('CreatedAnon:' + uid),",
        "    customClaims: { onboarded: 'from-create' },",
        '  };',
        '});',
        '',
        'exports.gateSignIn = beforeUserSignedIn(',
        `  { idToken: ${String(options.idToken)}, accessToken: ${String(options.accessToken)}, refreshToken: ${String(options.refreshToken)} },`,
        '  async (event) => {',
        '    const data = event.data || {};',
        '    const email = data.email || null;',
        '    const uid = data.uid || null;',
        "    const modeSnap = await getDatabase().ref('signInMode/' + (uid || 'default')).get();",
        "    const emailModeSnap = email ? await getDatabase().ref('emailMode/' + email.replace(/[.@]/g, '_')).get() : null;",
        '    const mode = (modeSnap && modeSnap.exists() ? modeSnap.val() : null) || (emailModeSnap && emailModeSnap.exists() ? emailModeSnap.val() : null);',
        '',
        "    await getDatabase().ref('signInAudits/' + (uid || 'none')).set({",
        '      onInitRan: initExecuted,',
        '      eventType: event.eventType,',
        '      authType: event.authType,',
        '      resourceName: event.resource.name,',
        '      uid,',
        '      email,',
        '      displayNameSeen: data.displayName || null,',
        '      customClaimsSeen: data.customClaims || null,',
        '      isNewUser: event.additionalUserInfo ? event.additionalUserInfo.isNewUser : null,',
        '      providerId: event.additionalUserInfo ? (event.additionalUserInfo.providerId || null) : null,',
        '      credentialIdToken: event.credential ? (event.credential.idToken || null) : null,',
        '      credentialAccessToken: event.credential ? (event.credential.accessToken || null) : null,',
        '      credentialRefreshToken: event.credential ? (event.credential.refreshToken || null) : null,',
        '    });',
        '',
        "    if (mode === 'deny-permission') throw new HttpsError('permission-denied', 'Sign-in denied by security policy');",
        "    if (mode === 'deny-invalid') throw new HttpsError('invalid-argument', 'Invalid sign-in context');",
        "    if (mode === 'deny-precondition') throw new HttpsError('failed-precondition', 'MFA enrollment required');",
        "    if (mode === 'disable-user') return { displayName: 'Disabled During SignIn', disabled: true };",
        "    if (mode === 'reserved-session') return { sessionClaims: { firebase: { forged: true } } };",
        "    if (mode === 'oversized-combined') return { customClaims: { c1: 'a'.repeat(550) }, sessionClaims: { s1: 'b'.repeat(550) } };",
        "    if (mode === 'passthrough') return {};",
        "    if (mode === 'step-up') {",
        '      return {',
        "        displayName: 'Verified Member',",
        '        emailVerified: true,',
        "        photoURL: 'https://cdn.example.com/verified/' + uid + '.png',",
        "        customClaims: { role: 'member' },",
        "        sessionClaims: { stepUp: true, assurance: 'aal2' },",
        "        recaptchaActionOverride: 'ALLOW',",
        '      };',
        '    }',
        "    return { sessionClaims: { signedInVia: event.eventType.split(':').pop() || 'unknown' } };",
        '  },',
        ');',
        '',
        'exports.verifyTokenInAdmin = onValueCreated(',
        "  '/verifyRequests/{reqId}',",
        '  async (event) => {',
        '    if (getApps().length === 0) initializeApp();',
        '    const payload = event.data.val();',
        '    const decoded = await getAuth().verifyIdToken(payload.idToken);',
        '    const userRecord = await getAuth().getUser(payload.uid);',
        "    await getDatabase().ref('verifyResponses/' + event.params.reqId).set({",
        '      decodedRole: decoded.role || null,',
        '      decodedStepUp: decoded.stepUp === true,',
        '      decodedAssurance: decoded.assurance || null,',
        '      storedCustomClaims: userRecord.customClaims || null,',
        '    });',
        '  },',
        ');',
      ].join('\n'),
    );
  }

  async function restartChildWithOptions(options: {
    idToken: boolean;
    accessToken: boolean;
    refreshToken: boolean;
  }): Promise<void> {
    if (!hosted) throw new Error('hosted runtime not initialized');
    if (activeChild) {
      const code = await activeChild.stop();
      activeChild = undefined;
      expect(code).toBe(0);
    }
    writeFunctionsEntry(options);
    activeChild = spawnFunctionsChild({
      cwd: join(fixtureDir, 'functions'),
      entry: join(fixtureDir, 'functions/index.js'),
      childModuleUrl: pathToFileURL(childModule),
      env: buildChildEnv(process.env, {
        serveUrl: hosted.url,
        registerUrl: registerModuleUrl(),
        instanceId: hosted.instanceId,
        sessionToken: hosted.sessionToken,
      }),
      instance: 'demo-project-default-rtdb',
      projectId: 'demo-project',
      location: 'us-central1',
    });
    await activeChild.ready;
  }

  async function waitForRtdbValue<T>(path: string): Promise<T> {
    if (!observer) throw new Error('observer not initialized');
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const val = (await observer.rtdb.get(path)) as T | null;
      if (val !== null && val !== undefined) return val;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`Timed out waiting for RTDB value at ${path}`);
  }

  beforeAll(async () => {
    if (!existsSync(childModule)) {
      throw new Error(`Functions child is not built: ${childModule}`);
    }
    fixtureDir = tempDirs.makeTempDir();
    mkdirSync(join(fixtureDir, 'public'), { recursive: true });
    mkdirSync(join(fixtureDir, 'functions/node_modules'), { recursive: true });
    writeFileSync(join(fixtureDir, 'public/index.html'), '<!doctype html><body>signin</body>');
    writeFileSync(
      join(fixtureDir, 'firebase.json'),
      JSON.stringify({ hosting: { public: 'public' } }),
    );
    writeFileSync(
      join(fixtureDir, 'functions/package.json'),
      JSON.stringify({ name: 'identity-signin-cjs', private: true, type: 'commonjs' }),
    );
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(fixtureDir, 'functions/node_modules/firebase-functions'),
    );

    hosted = await startNodeHostedRuntime(fixtureDir, 'demo-project');
    observer = await connectRemoteSandbox({
      cwd: fixtureDir,
      url: hosted.url,
      sessionToken: hosted.sessionToken,
    });

    const setupClient = await makeClientSession();
    await setProviderConfig(setupClient.auth, 'google.com', true);
    await setFirestoreRules(
      setupClient.firestore,
      [
        "rules_version = '2';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        '    match /stepUpVault/{docId} {',
        "      allow read, write: if request.auth != null && request.auth.token.role == 'member' && request.auth.token.stepUp == true;",
        '    }',
        '    match /memberArea/{docId} {',
        "      allow read, write: if request.auth != null && request.auth.token.role == 'member';",
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );

    await restartChildWithOptions({ idToken: false, accessToken: true, refreshToken: false });
  }, 60_000);

  afterAll(async () => {
    if (activeChild) {
      const code = await activeChild.stop();
      activeChild = undefined;
      expect(code).toBe(0);
    }
    for (const conn of clientConnections) {
      conn.close();
    }
    clientConnections.length = 0;
    observer?.close();
    if (hosted) await hosted.stop();
    tempDirs.cleanupTempDirs();
  });

  test('chains beforeUserCreated -> beforeUserSignedIn on registration and blocks session if beforeUserSignedIn rejects', async () => {
    const client = await makeClientSession();
    const cred = await createUserWithEmailAndPassword(client.auth, 'lovelace@ok.test', 'secret123');
    const uid = cred.user.uid;
    expect(cred.user.displayName).toBe('Created:lovelace');
    const tokenResult = await cred.user.getIdTokenResult();
    expect(tokenResult.claims.onboarded).toBe('from-create');
    expect(tokenResult.claims.signedInVia).toBe('password');

    const audit = await waitForRtdbValue<RecordedSignInAudit>(`signInAudits/${uid}`);
    expect(audit).toMatchObject({
      onInitRan: true,
      eventType: 'providers/cloud.auth/eventTypes/user.beforeSignIn:password',
      authType: 'USER',
      resourceName: 'projects/demo-project',
      uid,
      email: 'lovelace@ok.test',
      displayNameSeen: 'Created:lovelace',
      customClaimsSeen: { onboarded: 'from-create' },
      isNewUser: false,
      providerId: 'password',
    });
    expect(audit.credentialIdToken).toBeUndefined();
    expect(audit.credentialAccessToken).toBeUndefined();
    expect(audit.credentialRefreshToken).toBeUndefined();

    // When beforeUserSignedIn throws HttpsError after beforeUserCreated succeeds, zero session is issued.
    await observer?.rtdb.set('emailMode/blocked_after_create_test', 'deny-permission');
    const blockedClient = await makeClientSession();
    let chainErr: (Error & { code?: string }) | undefined;
    try {
      await createUserWithEmailAndPassword(
        blockedClient.auth,
        'blocked@after.create.test',
        'secret123',
      );
    } catch (err) {
      chainErr = err as Error & { code?: string };
    }
    expect(chainErr?.code).toBe('auth/internal-error');
    expect(chainErr?.message).toContain('PERMISSION_DENIED');
    expect(blockedClient.auth.currentUser).toBeNull();
  });

  test('injects transient sessionClaims into ID token, refreshes, Rules, and Admin verifyIdToken without polluting persistent customClaims', async () => {
    const setup = await makeClientSession();
    await adminCreateUser(setup.auth, {
      uid: 'u-stepup-live',
      email: 'stepup@live.test',
      password: 'secret123',
      displayName: 'Before SignIn',
      emailVerified: false,
    });
    await observer?.rtdb.set('signInMode/u-stepup-live', 'step-up');

    // Session 1: receives both persistent customClaims (role: 'member') and transient sessionClaims (stepUp: true).
    const session1 = await makeClientSession();
    const cred1 = await signInWithEmailAndPassword(session1.auth, 'stepup@live.test', 'secret123');
    expect(cred1.user.displayName).toBe('Verified Member');
    expect(cred1.user.emailVerified).toBe(true);
    expect(cred1.user.photoURL).toBe('https://cdn.example.com/verified/u-stepup-live.png');

    const tok1Initial = await cred1.user.getIdTokenResult(false);
    expect(tok1Initial.claims.role).toBe('member');
    expect(tok1Initial.claims.stepUp).toBe(true);
    expect(tok1Initial.claims.assurance).toBe('aal2');

    // Forced refresh keeps sessionClaims alive on the active session.
    const tok1Refreshed = await cred1.user.getIdTokenResult(true);
    expect(tok1Refreshed.token).not.toBe(tok1Initial.token);
    expect(tok1Refreshed.claims.role).toBe('member');
    expect(tok1Refreshed.claims.stepUp).toBe(true);

    // Firestore Security Rules enforce both persistent role and transient stepUp.
    await setDoc(doc(session1.firestore, 'stepUpVault/secret1'), { granted: true });
    expect((await getDoc(doc(session1.firestore, 'stepUpVault/secret1'))).data()).toEqual({
      granted: true,
    });

    // Verify inside child process via firebase-admin/auth verifyIdToken() vs getUser().
    await observer?.rtdb.set('verifyRequests/req1', {
      uid: 'u-stepup-live',
      idToken: tok1Refreshed.token,
    });
    const adminCheck1 = await waitForRtdbValue<{
      decodedRole: string | null;
      decodedStepUp: boolean;
      decodedAssurance: string | null;
      storedCustomClaims: Record<string, unknown> | null;
    }>('verifyResponses/req1');
    expect(adminCheck1).toEqual({
      decodedRole: 'member',
      decodedStepUp: true,
      decodedAssurance: 'aal2',
      storedCustomClaims: { role: 'member' },
    });
    await signOut(session1.auth);

    // Session 2: beforeUserSignedIn returns {} -> persistent role: 'member' remains, transient stepUp is absent.
    await observer?.rtdb.set('signInMode/u-stepup-live', 'passthrough');
    const session2 = await makeClientSession();
    const cred2 = await signInWithEmailAndPassword(session2.auth, 'stepup@live.test', 'secret123');
    const tok2 = await cred2.user.getIdTokenResult(false);
    const tok2Refreshed = await cred2.user.getIdTokenResult(true);
    expect(tok2.claims.role).toBe('member');
    expect(tok2.claims.stepUp).toBeUndefined();
    expect(tok2Refreshed.claims.role).toBe('member');
    expect(tok2Refreshed.claims.stepUp).toBeUndefined();

    let stepUpDenied: (Error & { code?: string }) | undefined;
    try {
      await setDoc(doc(session2.firestore, 'stepUpVault/secret2'), { granted: false });
    } catch (err) {
      stepUpDenied = err as Error & { code?: string };
    }
    expect(stepUpDenied?.code).toBe('permission-denied');
    await setDoc(doc(session2.firestore, 'memberArea/doc1'), { memberOk: true });
    expect((await getDoc(doc(session2.firestore, 'memberArea/doc1'))).data()).toEqual({
      memberOk: true,
    });

    await observer?.rtdb.set('verifyRequests/req2', {
      uid: 'u-stepup-live',
      idToken: tok2Refreshed.token,
    });
    const adminCheck2 = await waitForRtdbValue<{
      decodedRole: string | null;
      decodedStepUp: boolean;
      decodedAssurance: string | null;
      storedCustomClaims: Record<string, unknown> | null;
    }>('verifyResponses/req2');
    expect(adminCheck2).toMatchObject({
      decodedRole: 'member',
      decodedStepUp: false,
      storedCustomClaims: { role: 'member' },
    });
    expect(adminCheck2.decodedAssurance).toBeUndefined();
  });

  test('triggers beforeUserSignedIn across anonymous, emailLink, customToken, staged OAuth, and strictly gates BlockingOptions tokens', async () => {
    // 1. Anonymous sign-in.
    const anonClient = await makeClientSession();
    const anonCred = await signInAnonymously(anonClient.auth);
    expect((await anonCred.user.getIdTokenResult()).claims.signedInVia).toBe('anonymous');
    const anonAudit = await waitForRtdbValue<RecordedSignInAudit>(
      `signInAudits/${anonCred.user.uid}`,
    );
    expect(anonAudit.eventType).toBe(
      'providers/cloud.auth/eventTypes/user.beforeSignIn:anonymous',
    );

    // 2. Existing user signInWithEmailLink + signInWithCustomToken.
    await adminCreateUser(anonClient.auth, {
      uid: 'u-methods-live',
      email: 'methods@live.test',
      password: 'secret123',
    });
    const linkClient = await makeClientSession();
    await sendSignInLinkToEmail(linkClient.auth, 'methods@live.test', {
      url: 'https://example.com/finish',
      handleCodeInApp: true,
    });
    const mail = await takeAuthMail(linkClient.auth, 'methods@live.test');
    if (!mail) throw new Error('expected sign-in link email');
    const linkCred = await signInWithEmailLink(linkClient.auth, 'methods@live.test', mail.link);
    expect((await linkCred.user.getIdTokenResult()).claims.signedInVia).toBe('emailLink');
    const linkAudit = await waitForRtdbValue<RecordedSignInAudit>('signInAudits/u-methods-live');
    expect(linkAudit.eventType).toBe(
      'providers/cloud.auth/eventTypes/user.beforeSignIn:emailLink',
    );
    expect(linkAudit.providerId).toBe('password');

    const customClient = await makeClientSession();
    const customToken = mintCustomToken({
      uid: 'u-methods-live',
      projectId: 'demo-project',
      claims: { customAttr: 'yes' },
      nowMs: Date.now(),
    });
    const customCred = await signInWithCustomToken(customClient.auth, customToken);
    const customTokenResult = await customCred.user.getIdTokenResult();
    expect(customTokenResult.claims.signedInVia).toBe('custom');
    expect(customTokenResult.claims.customAttr).toBe('yes');

    // 3. Staged OAuth sign-in via SharedWorker client (no raw tokens on browser wire).
    const stagedClient = await makeClientSession();
    stageSignInResult(stagedClient.auth, {
      user: { uid: 'u-methods-live', email: 'methods@live.test' },
      providerId: 'google.com',
    });
    await stagedClient.conn.channel.op({
      method: 'auth.acceptIdentity',
      identity: {
        uid: 'u-methods-live',
        email: 'methods@live.test',
        providerId: 'google.com',
      },
      tenantId: null,
    });

    // 4. OAuth OIDC credential gating #1: child started with { idToken: false, accessToken: true, refreshToken: false }.
    await adminCreateUser(anonClient.auth, {
      uid: 'u-oauth-gated',
      email: 'gated@live.test',
    });
    await observer?.rtdb.set('signInAudits/u-oauth-gated', null);
    const oidcJwt = makeTestOidcJwt({
      sub: 'u-oauth-gated',
      email: 'gated@live.test',
      name: 'Gated Google User',
    });
    const oauthClient1 = await makeClientSession();
    await oauthClient1.conn.channel.op({
      method: 'auth.signInWithCredential',
      credential: {
        providerId: 'google.com',
        signInMethod: 'google.com',
        idToken: oidcJwt,
        accessToken: 'access-tok-visible',
        refreshToken: 'refresh-tok-hidden',
      },
      tenantId: null,
    });
    const gatedAudit1 = await waitForRtdbValue<RecordedSignInAudit>('signInAudits/u-oauth-gated');
    expect(gatedAudit1.eventType).toBe(
      'providers/cloud.auth/eventTypes/user.beforeSignIn:google.com',
    );
    expect(gatedAudit1.credentialIdToken).toBeUndefined();
    expect(gatedAudit1.credentialAccessToken).toBe('access-tok-visible');
    expect(gatedAudit1.credentialRefreshToken).toBeUndefined();

    // 5. OAuth OIDC credential gating #2: restart child with { idToken: true, accessToken: false, refreshToken: true }.
    await restartChildWithOptions({ idToken: true, accessToken: false, refreshToken: true });
    await observer?.rtdb.set('signInAudits/u-oauth-gated', null);
    const oauthClient2 = await makeClientSession();
    await oauthClient2.conn.channel.op({
      method: 'auth.signInWithCredential',
      credential: {
        providerId: 'google.com',
        signInMethod: 'google.com',
        idToken: oidcJwt,
        accessToken: 'access-tok-now-hidden',
        refreshToken: 'refresh-tok-now-visible',
      },
      tenantId: null,
    });
    const gatedAudit2 = await waitForRtdbValue<RecordedSignInAudit>('signInAudits/u-oauth-gated');
    expect(gatedAudit2.credentialIdToken).toBe(oidcJwt);
    expect(gatedAudit2.credentialAccessToken).toBeUndefined();
    expect(gatedAudit2.credentialRefreshToken).toBe('refresh-tok-now-visible');
  }, 30_000);

  test('enforces HttpsError rejections, disabled: true persistence, reserved claims, and 1000-char combined limit without leaking sessions', async () => {
    const setup = await makeClientSession();
    await adminCreateUser(setup.auth, {
      uid: 'u-reject-live',
      email: 'reject@live.test',
      password: 'secret123',
      displayName: 'Untouched Display Name',
    });

    for (const [mode, expectedStatus, expectedMsg] of [
      ['deny-permission', 'PERMISSION_DENIED', 'Sign-in denied by security policy'],
      ['deny-invalid', 'INVALID_ARGUMENT', 'Invalid sign-in context'],
      ['deny-precondition', 'FAILED_PRECONDITION', 'MFA enrollment required'],
      ['reserved-session', 'INVALID_ARGUMENT', 'reserved and cannot be specified'],
      ['oversized-combined', 'INVALID_ARGUMENT', 'should not exceed 1000 characters combined'],
    ] as const) {
      await observer?.rtdb.set('signInMode/u-reject-live', mode);
      const client = await makeClientSession();
      let errSeen: (Error & { code?: string }) | undefined;
      try {
        await signInWithEmailAndPassword(client.auth, 'reject@live.test', 'secret123');
      } catch (err) {
        errSeen = err as Error & { code?: string };
      }
      expect(errSeen?.code).toBe('auth/internal-error');
      expect(errSeen?.message).toContain(expectedStatus);
      expect(errSeen?.message).toContain(expectedMsg);
      expect(client.auth.currentUser).toBeNull();
    }

    // Existing user record remains untouched across all 5 rejections.
    const unchanged = (await listUsers(setup.auth)).find((u) => u.uid === 'u-reject-live');
    expect(unchanged?.displayName).toBe('Untouched Display Name');
    expect(unchanged?.disabled).toBe(false);
    expect(unchanged?.customClaims).toEqual({});

    // Returning disabled: true persists disabled: true and throws auth/user-disabled.
    await observer?.rtdb.set('signInMode/u-reject-live', 'disable-user');
    const banClient = await makeClientSession();
    let banErr: (Error & { code?: string }) | undefined;
    try {
      await signInWithEmailAndPassword(banClient.auth, 'reject@live.test', 'secret123');
    } catch (err) {
      banErr = err as Error & { code?: string };
    }
    expect(banErr?.code).toBe('auth/user-disabled');
    expect(banClient.auth.currentUser).toBeNull();
    const afterBan = (await listUsers(setup.auth)).find((u) => u.uid === 'u-reject-live');
    expect(afterBan?.disabled).toBe(true);
    expect(afterBan?.displayName).toBe('Disabled During SignIn');
  });
});
