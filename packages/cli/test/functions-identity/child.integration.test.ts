import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GoogleAuthProvider } from 'pyric/auth';
import { mintCustomToken } from 'pyric/sandbox/internal';
import { buildChildEnv, registerModuleUrl } from '../../src/cli/sandbox-runner.js';
import type { FunctionsChildEvent } from '../../src/functions/child-protocol.js';
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
  signInWithCredential,
  signInWithCustomToken,
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

interface RecordedBlockingAudit {
  onInitRan: boolean;
  eventType: string;
  authType: string;
  resourceName: string;
  uid: string | null;
  email: string | null;
  isNewUser: boolean | null;
  providerId: string | null;
  credentialIdToken?: string;
  credentialAccessToken?: string;
  credentialRefreshToken?: string;
}

describe('isolated CJS Functions Identity child against live HostedRuntime', () => {
  const tempDirs = trackTempDirs('pyric-fn-identity-hosted-');
  let fixtureDir = '';
  let hosted: HostedNodeServer | undefined;
  let observer: RemoteSandbox | undefined;
  let activeChild: FunctionsChildHandle | undefined;
  let readyPayload: Awaited<FunctionsChildHandle['ready']> | undefined;
  const events: FunctionsChildEvent[] = [];
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

  beforeAll(async () => {
    if (!existsSync(childModule)) {
      throw new Error(`Functions child is not built: ${childModule}`);
    }
    fixtureDir = tempDirs.makeTempDir();
    mkdirSync(join(fixtureDir, 'public'), { recursive: true });
    mkdirSync(join(fixtureDir, 'functions/node_modules'), { recursive: true });
    writeFileSync(join(fixtureDir, 'public/index.html'), '<!doctype html><body>hosted</body>');
    writeFileSync(
      join(fixtureDir, 'firebase.json'),
      JSON.stringify({ hosting: { public: 'public' } }),
    );
    writeFileSync(
      join(fixtureDir, 'functions/package.json'),
      JSON.stringify({ name: 'identity-fn-cjs', private: true, type: 'commonjs' }),
    );
    writeFileSync(
      join(fixtureDir, 'functions/index.js'),
      [
        "const { initializeApp, getApps } = require('firebase-admin/app');",
        "const { getAuth } = require('firebase-admin/auth');",
        "const { getDatabase } = require('firebase-admin/database');",
        "const { onInit } = require('firebase-functions/v2/core');",
        "const { onValueCreated } = require('firebase-functions/v2/database');",
        "const { beforeUserCreated, beforeUserSignedIn, beforeEmailSent, beforeSmsSent, HttpsError } = require('firebase-functions/v2/identity');",
        '',
        'let initExecuted = false;',
        'onInit(() => {',
        '  if (getApps().length === 0) initializeApp();',
        '  initExecuted = true;',
        '});',
        '',
        'exports.gateSignUp = beforeUserCreated(',
        '  { idToken: true, accessToken: true, refreshToken: false },',
        '  async (event) => {',
        '    const email = event.data && event.data.email ? event.data.email : null;',
        '    const uid = event.data ? event.data.uid : null;',
        "    await getDatabase().ref('audits/' + (uid || 'none')).set({",
        '      onInitRan: initExecuted,',
        '      eventType: event.eventType,',
        '      authType: event.authType,',
        '      resourceName: event.resource.name,',
        '      uid,',
        '      email,',
        '      isNewUser: event.additionalUserInfo ? event.additionalUserInfo.isNewUser : null,',
        '      providerId: event.additionalUserInfo ? (event.additionalUserInfo.providerId || null) : null,',
        '      credentialIdToken: event.credential ? (event.credential.idToken || null) : null,',
        '      credentialAccessToken: event.credential ? (event.credential.accessToken || null) : null,',
        '      credentialRefreshToken: event.credential ? (event.credential.refreshToken || null) : null,',
        '    });',
        "    if (email && email.endsWith('@denied.test')) {",
        "      throw new HttpsError('permission-denied', 'Domain denied.test is blocked');",
        '    }',
        "    if (email && email.endsWith('@invalid.test')) {",
        "      throw new HttpsError('invalid-argument', 'Email rejected by policy');",
        '    }',
        "    if (email && email.endsWith('@precondition.test')) {",
        "      throw new HttpsError('failed-precondition', 'Invite required');",
        '    }',
        "    if (email && email.endsWith('@badclaims.test')) {",
        '      return {',
        "        customClaims: { sub: 'forbidden-subject-override' },",
        '      };',
        '    }',
        "    if (email && email.endsWith('@autoban.test')) {",
        '      return {',
        "        displayName: 'Quarantined Account',",
        '        disabled: true,',
        "        customClaims: { status: 'quarantined' },",
        '      };',
        '    }',
        "    if (event.eventType.endsWith(':anonymous')) {",
        '      return {',
        "        displayName: 'Guest Explorer',",
        "        customClaims: { tier: 'guest' },",
        '      };',
        '    }',
        '    return {',
        "      displayName: email ? ('Member ' + email.split('@')[0]) : ('Custom ' + uid),",
        '      emailVerified: true,',
        "      photoURL: 'https://example.com/avatars/' + uid + '.png',",
        "      customClaims: { role: 'member', onboardedBy: 'beforeUserCreated' },",
        "      recaptchaActionOverride: 'ALLOW',",
        '    };',
        '  },',
        ');',
        '',
        'exports.adminSeedFromChild = onValueCreated(',
        "  '/adminCreateCommands/{cmdId}',",
        '  async (event) => {',
        '    if (getApps().length === 0) initializeApp();',
        '    const cmd = event.data.val();',
        '    const created = await getAuth().createUser({',
        '      uid: cmd.uid,',
        '      email: cmd.email,',
        '      password: cmd.password,',
        '      displayName: cmd.displayName,',
        '    });',
        "    await getDatabase().ref('adminCreateReceipts/' + cmd.uid).set({",
        '      uid: created.uid,',
        '      email: created.email,',
        '      displayName: created.displayName,',
        '    });',
        '  },',
        ');',
        '',
        'exports.omittedBeforeCreate = beforeUserCreated({ omit: true }, () => undefined);',
        'exports.pendingSignIn = beforeUserSignedIn(() => undefined);',
        'exports.pendingEmail = beforeEmailSent(() => undefined);',
        'exports.pendingSms = beforeSmsSent(() => undefined);',
      ].join('\n'),
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
    await setFirestoreRules(
      setupClient.firestore,
      [
        "rules_version = '2';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        '    match /memberOnly/{docId} {',
        "      allow read, write: if request.auth != null && request.auth.token.role == 'member' && request.auth.token.email_verified == true;",
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );

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
      onEvent: (event) => events.push(event),
    });
    readyPayload = await activeChild.ready;
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

  test('discovers all 4 active identity blocking triggers and reports omitted exports', () => {
    expect(readyPayload).toEqual({
      triggerCount: 5,
      unsupportedTriggers: [
        {
          exportName: 'omittedBeforeCreate',
          eventType:
            'providers/cloud.auth/eventTypes/user.beforeCreate (omitted from emulation)',
        },
      ],
    });
  });

  test('blocks email/password sign-up on HttpsError before persisting any user record', async () => {
    for (const [email, expectedStatus, expectedMessage] of [
      ['mallory@denied.test', 'PERMISSION_DENIED', 'Domain denied.test is blocked'],
      ['bad@invalid.test', 'INVALID_ARGUMENT', 'Email rejected by policy'],
      ['noinvite@precondition.test', 'FAILED_PRECONDITION', 'Invite required'],
    ] as const) {
      const client = await makeClientSession();
      let caught: (Error & { code?: string }) | undefined;
      try {
        await createUserWithEmailAndPassword(client.auth, email, 'secret123');
      } catch (err) {
        caught = err as Error & { code?: string };
      }
      expect(caught?.code).toBe('auth/internal-error');
      expect(caught?.message).toContain(expectedStatus);
      expect(caught?.message).toContain(expectedMessage);
      expect(client.auth.currentUser).toBeNull();
    }
    const checkClient = await makeClientSession();
    expect(await listUsers(checkClient.auth)).toEqual([]);
  });

  test('applies BeforeCreateResponse mutations to user record, ID token claims, and Firestore rules', async () => {
    if (!observer) throw new Error('observer missing');
    const adaClient = await makeClientSession();
    const adaCred = await createUserWithEmailAndPassword(
      adaClient.auth,
      'ada@allowed.test',
      'secret123',
    );
    expect(adaCred.user.displayName).toBe('Member ada');
    expect(adaCred.user.emailVerified).toBe(true);
    expect(adaCred.user.photoURL).toBe(
      `https://example.com/avatars/${adaCred.user.uid}.png`,
    );
    const adaTokenResult = await adaCred.user.getIdTokenResult();
    expect(adaTokenResult.claims).toMatchObject({
      role: 'member',
      onboardedBy: 'beforeUserCreated',
      email_verified: true,
      name: 'Member ada',
      picture: `https://example.com/avatars/${adaCred.user.uid}.png`,
    });

    await setDoc(doc(adaClient.firestore, 'memberOnly', adaCred.user.uid), {
      verifiedMember: true,
    });
    const memberSnap = await getDoc(doc(adaClient.firestore, 'memberOnly', adaCred.user.uid));
    expect(memberSnap.exists()).toBe(true);
    expect(memberSnap.data()).toEqual({ verifiedMember: true });

    const adaAudit = (await observer.rtdb.get(
      `audits/${adaCred.user.uid}`,
    )) as RecordedBlockingAudit;
    expect(adaAudit).toEqual({
      onInitRan: true,
      eventType: 'providers/cloud.auth/eventTypes/user.beforeCreate:password',
      authType: 'USER',
      resourceName: 'projects/demo-project',
      uid: adaCred.user.uid,
      email: 'ada@allowed.test',
      isNewUser: true,
      providerId: 'password',
    });
    await signOut(adaClient.auth);
  });

  test('persists disabled: true user record while rejecting session issuance with auth/user-disabled', async () => {
    const bannedClient = await makeClientSession();
    let bannedErr: (Error & { code?: string }) | undefined;
    try {
      await createUserWithEmailAndPassword(
        bannedClient.auth,
        'quarantine@autoban.test',
        'secret123',
      );
    } catch (err) {
      bannedErr = err as Error & { code?: string };
    }
    expect(bannedErr?.code).toBe('auth/user-disabled');
    const storedBanned = (await listUsers(bannedClient.auth)).find(
      (u) => u.email === 'quarantine@autoban.test',
    );
    expect(storedBanned).toMatchObject({
      displayName: 'Quarantined Account',
      disabled: true,
      customClaims: { status: 'quarantined' },
    });
  });

  test('triggers beforeUserCreated once per new anonymous user', async () => {
    const anonClient = await makeClientSession();
    const anonCred1 = await signInAnonymously(anonClient.auth);
    expect(anonCred1.user.isAnonymous).toBe(true);
    expect(anonCred1.user.displayName).toBe('Guest Explorer');
    const anonToken = await anonCred1.user.getIdTokenResult();
    expect(anonToken.claims.tier).toBe('guest');
    const anonCred2 = await signInAnonymously(anonClient.auth);
    expect(anonCred2.user.uid).toBe(anonCred1.user.uid);
  });

  test('gates OAuth credential tokens by BlockingOptions and rejects blocked staged federated sign-up', async () => {
    if (!observer) throw new Error('observer missing');
    const oauthClient = await makeClientSession();
    await setProviderConfig(oauthClient.auth, 'google.com', true);
    const oidcJwt = makeTestOidcJwt({
      sub: 'google-uid-77',
      email: 'grace@allowed.test',
      email_verified: false,
      name: 'Original Google Name',
    });
    const oauthResult = (await oauthClient.conn.channel.op({
      method: 'auth.signInWithCredential',
      credential: {
        providerId: 'google.com',
        signInMethod: 'google.com',
        idToken: oidcJwt,
        accessToken: 'google-access-token-xyz',
        refreshToken: 'google-refresh-token-hidden',
      },
      tenantId: null,
    })) as { user: { uid: string; displayName: string | null } };
    expect(oauthResult.user.uid).toBe('google-uid-77');
    expect(oauthResult.user.displayName).toBe('Member grace');
    const oauthAudit = (await observer.rtdb.get('audits/google-uid-77')) as RecordedBlockingAudit;
    expect(oauthAudit).toMatchObject({
      eventType: 'providers/cloud.auth/eventTypes/user.beforeCreate:google.com',
      providerId: 'google.com',
      isNewUser: true,
      credentialIdToken: oidcJwt,
      credentialAccessToken: 'google-access-token-xyz',
    });
    expect(oauthAudit.credentialRefreshToken).toBeUndefined();

    const rejectedOAuthClient = await makeClientSession();
    stageSignInResult(rejectedOAuthClient.auth, {
      providerId: 'google.com',
      user: {
        uid: 'google-denied-uid',
        email: 'blocked-oauth@denied.test',
        displayName: 'Blocked OAuth',
        photoURL: null,
      },
    });
    let oauthDeniedErr: (Error & { code?: string }) | undefined;
    try {
      await signInWithCredential(rejectedOAuthClient.auth, GoogleAuthProvider.credential('tok'));
    } catch (err) {
      oauthDeniedErr = err as Error & { code?: string };
    }
    expect(oauthDeniedErr?.code).toBe('auth/internal-error');
    expect(
      (await listUsers(rejectedOAuthClient.auth)).find((u) => u.uid === 'google-denied-uid'),
    ).toBeUndefined();
  });

  test('runs beforeUserCreated on first-time signInWithEmailLink and signInWithCustomToken only', async () => {
    if (!observer) throw new Error('observer missing');
    const linkClient = await makeClientSession();
    await sendSignInLinkToEmail(linkClient.auth, 'linus@allowed.test', {
      url: 'https://example.com/finish',
      handleCodeInApp: true,
    });
    const mail = await takeAuthMail(linkClient.auth, 'linus@allowed.test');
    if (!mail) throw new Error('expected sign-in email link');
    const linkResult = await signInWithEmailLink(
      linkClient.auth,
      'linus@allowed.test',
      mail.link,
    );
    const linkAudit = (await observer.rtdb.get(
      `audits/${linkResult.user.uid}`,
    )) as RecordedBlockingAudit;
    expect(linkAudit).toMatchObject({
      eventType: 'providers/cloud.auth/eventTypes/user.beforeCreate:emailLink',
      providerId: 'password',
      isNewUser: true,
    });

    const customClient = await makeClientSession();
    const customTok = mintCustomToken({
      uid: 'custom-uid-99',
      claims: { sessionBoost: 1 },
      projectId: 'demo-project',
      nowMs: Date.now(),
    });
    const customRes = await signInWithCustomToken(customClient.auth, customTok);
    expect(customRes.user.displayName).toBe('Custom custom-uid-99');
    const customClaims = (await customRes.user.getIdTokenResult()).claims;
    expect(customClaims).toMatchObject({ role: 'member', sessionBoost: 1 });
    await observer.rtdb.remove('audits/custom-uid-99');
    const customClient2 = await makeClientSession();
    await signInWithCustomToken(customClient2.auth, customTok);
    expect(await observer.rtdb.get('audits/custom-uid-99')).toBeNull();
  });

  test('bypasses beforeUserCreated for direct Admin createUser and child firebase-admin/auth createUser', async () => {
    if (!observer) throw new Error('observer missing');
    const adminClient = await makeClientSession();
    const directAdminCreated = await adminCreateUser(adminClient.auth, {
      uid: 'admin-bypass-1',
      email: 'vip@denied.test',
      password: 'secret123',
      displayName: 'Admin Direct',
    });
    expect(directAdminCreated.uid).toBe('admin-bypass-1');
    expect(directAdminCreated.displayName).toBe('Admin Direct');
    expect(await observer.rtdb.get('audits/admin-bypass-1')).toBeNull();

    await observer.rtdb.set('adminCreateCommands/cmd1', {
      uid: 'admin-bypass-child',
      email: 'child-vip@denied.test',
      password: 'secret123',
      displayName: 'Admin From Child',
    });
    const deadline = Date.now() + 10_000;
    let childAdminReceipt: unknown = null;
    while (Date.now() < deadline) {
      childAdminReceipt = await observer.rtdb.get('adminCreateReceipts/admin-bypass-child');
      if (childAdminReceipt !== null) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(childAdminReceipt).toEqual({
      uid: 'admin-bypass-child',
      email: 'child-vip@denied.test',
      displayName: 'Admin From Child',
    });
    expect(await observer.rtdb.get('audits/admin-bypass-child')).toBeNull();
  });

  test('scopes resource.name to tenants and rejects reserved customClaims without persisting user', async () => {
    if (!observer) throw new Error('observer missing');
    const tenantClient = await makeClientSession();
    tenantClient.auth.tenantId = 'tenant-acme';
    const tenantCred = await createUserWithEmailAndPassword(
      tenantClient.auth,
      'turing@allowed.test',
      'secret123',
    );
    expect(tenantCred.user.tenantId).toBe('tenant-acme');
    const tenantAudit = (await observer.rtdb.get(
      `audits/${tenantCred.user.uid}`,
    )) as RecordedBlockingAudit;
    expect(tenantAudit.resourceName).toBe('projects/demo-project/tenants/tenant-acme');

    const badClaimsClient = await makeClientSession();
    let badClaimsErr: (Error & { code?: string }) | undefined;
    try {
      await createUserWithEmailAndPassword(
        badClaimsClient.auth,
        'evil@badclaims.test',
        'secret123',
      );
    } catch (err) {
      badClaimsErr = err as Error & { code?: string };
    }
    expect(badClaimsErr?.code).toBe('auth/internal-error');
    expect(badClaimsErr?.message).toContain('INVALID_ARGUMENT');
    expect(
      (await listUsers(badClaimsClient.auth)).find((u) => u.email === 'evil@badclaims.test'),
    ).toBeUndefined();
    expect(
      events.some(
        (ev) =>
          ev.type === 'execution' &&
          ev.exportName === 'gateSignUp' &&
          ev.status === 'fulfilled',
      ),
    ).toBe(true);
    expect(
      events.some(
        (ev) =>
          ev.type === 'execution' &&
          ev.exportName === 'gateSignUp' &&
          ev.status === 'rejected',
      ),
    ).toBe(true);
  });
});
