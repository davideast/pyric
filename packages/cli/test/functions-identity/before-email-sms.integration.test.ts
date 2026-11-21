import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildChildEnv, registerModuleUrl } from '../../src/cli/sandbox-runner.js';
import { spawnFunctionsChild, type FunctionsChildHandle } from '../../src/functions/spawn.js';
import { connectRemoteSandbox, type RemoteSandbox } from '../../src/remote/index.js';
import {
  adminCreateUser,
  applyActionCode,
  confirmPasswordReset,
  createUserWithEmailAndPassword,
  getAuth as getClientAuth,
  listUsers,
  sendAuthSmsVerification,
  sendEmailVerification,
  sendPasswordResetEmail,
  sendSignInLinkToEmail,
  signInWithEmailAndPassword,
  signInWithEmailLink,
  takeAuthMail,
  takeAuthSms,
  verifyBeforeUpdateEmail,
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

interface EmailAuditEntry {
  onInitRan: boolean;
  eventType: string;
  authType: string;
  resourceName: string;
  emailType: string | null;
  email: string | null;
  hasData: boolean;
}

interface SmsAuditEntry {
  onInitRan: boolean;
  eventType: string;
  authType: string;
  resourceName: string;
  smsType: string | null;
  phoneNumber: string | null;
  hasData: boolean;
}

describe('isolated CJS and ESM beforeEmailSent and beforeSmsSent against live HostedRuntime', () => {
  const tempDirs = trackTempDirs('pyric-fn-identity-email-sms-');
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
    };
  }

  beforeAll(async () => {
    if (!existsSync(childModule)) {
      throw new Error(`Functions child is not built: ${childModule}`);
    }
    fixtureDir = tempDirs.makeTempDir();
    mkdirSync(join(fixtureDir, 'public'), { recursive: true });
    mkdirSync(join(fixtureDir, 'functions-cjs/node_modules'), { recursive: true });
    mkdirSync(join(fixtureDir, 'functions-esm/node_modules'), { recursive: true });
    writeFileSync(join(fixtureDir, 'public/index.html'), '<!doctype html><body>email-sms</body>');
    writeFileSync(
      join(fixtureDir, 'firebase.json'),
      JSON.stringify({ hosting: { public: 'public' } }),
    );
    writeFileSync(
      join(fixtureDir, 'functions-cjs/package.json'),
      JSON.stringify({ name: 'identity-email-sms-cjs', private: true, type: 'commonjs' }),
    );
    writeFileSync(
      join(fixtureDir, 'functions-cjs/index.js'),
      [
        "const { initializeApp, getApps } = require('firebase-admin/app');",
        "const { getDatabase } = require('firebase-admin/database');",
        "const { onInit } = require('firebase-functions/v2/core');",
        "const { beforeEmailSent, beforeSmsSent, HttpsError } = require('firebase-functions/v2/identity');",
        '',
        'let initExecuted = false;',
        'let emailSeq = 0;',
        'let smsSeq = 0;',
        'onInit(() => {',
        '  if (getApps().length === 0) initializeApp();',
        '  initExecuted = true;',
        '});',
        '',
        'exports.guardEmail = beforeEmailSent(async (event) => {',
        '  const idx = ++emailSeq;',
        '  const email = event.additionalUserInfo && event.additionalUserInfo.email ? event.additionalUserInfo.email : null;',
        "  await getDatabase().ref('emailAudits/' + idx).set({",
        '    onInitRan: initExecuted,',
        '    eventType: event.eventType,',
        '    authType: event.authType,',
        '    resourceName: event.resource.name,',
        '    emailType: event.emailType || null,',
        '    email,',
        '    hasData: event.data !== undefined,',
        '  });',
        "  await getDatabase().ref('latestEmailAudit').set({",
        '    seq: idx,',
        '    onInitRan: initExecuted,',
        '    eventType: event.eventType,',
        '    authType: event.authType,',
        '    resourceName: event.resource.name,',
        '    emailType: event.emailType || null,',
        '    email,',
        '    hasData: event.data !== undefined,',
        '  });',
        "  if (email && email.endsWith('@denied.test')) {",
        "    throw new HttpsError('permission-denied', 'Email delivery denied for ' + email);",
        '  }',
        "  if (email && email.endsWith('@ratelimit.test')) {",
        "    throw new HttpsError('resource-exhausted', 'Email quota exceeded');",
        '  }',
        "  if (email && email.endsWith('@badrecaptcha.test')) {",
        "    return { recaptchaActionOverride: 'NOT_VALID' };",
        '  }',
        "  return { recaptchaActionOverride: 'ALLOW' };",
        '});',
        '',
        'exports.guardSms = beforeSmsSent(async (event) => {',
        '  const idx = ++smsSeq;',
        '  const phone = event.additionalUserInfo && event.additionalUserInfo.phoneNumber ? event.additionalUserInfo.phoneNumber : null;',
        "  await getDatabase().ref('latestSmsAudit').set({",
        '    seq: idx,',
        '    onInitRan: initExecuted,',
        '    eventType: event.eventType,',
        '    authType: event.authType,',
        '    resourceName: event.resource.name,',
        '    smsType: event.smsType || null,',
        '    phoneNumber: phone,',
        '    hasData: event.data !== undefined,',
        '  });',
        "  if (phone && phone.startsWith('+1555999')) {",
        "    throw new HttpsError('permission-denied', 'High-risk SMS prefix blocked');",
        '  }',
        "  if (phone === '+15558880000') {",
        "    return { recaptchaActionOverride: 'BLOCK' };",
        '  }',
        "  return { recaptchaActionOverride: 'ALLOW' };",
        '});',
      ].join('\n'),
    );

    writeFileSync(
      join(fixtureDir, 'functions-esm/package.json'),
      JSON.stringify({
        name: 'identity-email-sms-esm',
        private: true,
        type: 'module',
        main: 'index.js',
      }),
    );
    writeFileSync(
      join(fixtureDir, 'functions-esm/index.js'),
      [
        "import { initializeApp, getApps } from 'firebase-admin/app';",
        "import { beforeEmailSent, beforeSmsSent, HttpsError } from 'firebase-functions/v2/identity';",
        '',
        'await Promise.resolve();',
        'if (getApps().length === 0) initializeApp();',
        '',
        'export const esmEmailGuard = beforeEmailSent((event) => {',
        "  if (event.additionalUserInfo?.email?.endsWith('@esm-deny.test')) {",
        "    throw new HttpsError('permission-denied', 'ESM blocked email');",
        '  }',
        "  return { recaptchaActionOverride: 'ALLOW' };",
        '});',
        '',
        'export const esmSmsGuard = beforeSmsSent((event) => {',
        "  if (event.additionalUserInfo?.phoneNumber?.startsWith('+1555777')) {",
        "    throw new HttpsError('resource-exhausted', 'ESM blocked SMS');",
        '  }',
        "  return { recaptchaActionOverride: 'ALLOW' };",
        '});',
      ].join('\n'),
    );

    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(fixtureDir, 'functions-cjs/node_modules/firebase-functions'),
    );
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(fixtureDir, 'functions-esm/node_modules/firebase-functions'),
    );

    hosted = await startNodeHostedRuntime(fixtureDir, 'demo-project');
    observer = await connectRemoteSandbox({
      cwd: fixtureDir,
      url: hosted.url,
      sessionToken: hosted.sessionToken,
    });

    activeChild = spawnFunctionsChild({
      cwd: join(fixtureDir, 'functions-cjs'),
      entry: join(fixtureDir, 'functions-cjs/index.js'),
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
    const ready = await activeChild.ready;
    expect(ready).toEqual({
      triggerCount: 2,
      unsupportedTriggers: [],
    });
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

  test('gates sendPasswordResetEmail with silent enumeration protection and pre-outbox HttpsError blocking', async () => {
    if (!observer) throw new Error('observer missing');
    const client = await makeClientSession();
    await adminCreateUser(client.auth, {
      uid: 'reset-allowed-u1',
      email: 'ada@allowed.test',
      password: 'oldPassword123',
    });
    await adminCreateUser(client.auth, {
      uid: 'reset-denied-u1',
      email: 'mallory@denied.test',
      password: 'oldPassword123',
    });

    // Unknown user resolves silently without firing beforeEmailSent or producing mail.
    await sendPasswordResetEmail(client.auth, 'nobody@denied.test');
    expect(await observer.rtdb.get('latestEmailAudit')).toBeNull();
    expect(await takeAuthMail(client.auth)).toBeNull();

    // Known user blocked by HttpsError produces zero outbox mail.
    let deniedErr: (Error & { code?: string }) | undefined;
    try {
      await sendPasswordResetEmail(client.auth, 'mallory@denied.test');
    } catch (err) {
      deniedErr = err as Error & { code?: string };
    }
    expect(deniedErr?.code).toBe('auth/internal-error');
    expect(deniedErr?.message).toContain('PERMISSION_DENIED');
    expect(await takeAuthMail(client.auth)).toBeNull();
    const deniedAudit = (await observer.rtdb.get('latestEmailAudit')) as EmailAuditEntry;
    expect(deniedAudit).toMatchObject({
      onInitRan: true,
      eventType: 'providers/cloud.auth/eventTypes/user.beforeSendEmail',
      authType: 'USER',
      resourceName: 'projects/demo-project',
      emailType: 'PASSWORD_RESET',
      email: 'mallory@denied.test',
      hasData: false,
    });

    // Allowed known user receives reset mail and completes confirmPasswordReset.
    await sendPasswordResetEmail(client.auth, 'ada@allowed.test');
    const resetMail = await takeAuthMail(client.auth, 'ada@allowed.test');
    if (!resetMail) throw new Error('expected password reset mail');
    await confirmPasswordReset(client.auth, resetMail.code, 'newPassword456');
    const signedIn = await signInWithEmailAndPassword(
      client.auth,
      'ada@allowed.test',
      'newPassword456',
    );
    expect(signedIn.user.uid).toBe('reset-allowed-u1');
  });

  test('gates sendSignInLinkToEmail with UNAUTHENTICATED vs USER authType, tenant resource.name, and quota rejection', async () => {
    if (!observer) throw new Error('observer missing');
    const linkSettings = { url: 'https://example.com/finish', handleCodeInApp: true };
    const client = await makeClientSession();

    // Brand-new email -> UNAUTHENTICATED.
    await sendSignInLinkToEmail(client.auth, 'newcomer@allowed.test', linkSettings);
    const newAudit = (await observer.rtdb.get('latestEmailAudit')) as EmailAuditEntry;
    expect(newAudit).toMatchObject({
      authType: 'UNAUTHENTICATED',
      emailType: 'EMAIL_SIGN_IN',
      email: 'newcomer@allowed.test',
      hasData: false,
    });
    const newMail = await takeAuthMail(client.auth, 'newcomer@allowed.test');
    if (!newMail) throw new Error('expected sign-in link mail');
    const linkCred = await signInWithEmailLink(client.auth, 'newcomer@allowed.test', newMail.link);
    expect(linkCred.user.email).toBe('newcomer@allowed.test');

    // Existing account -> USER.
    await sendSignInLinkToEmail(client.auth, 'newcomer@allowed.test', linkSettings);
    const existingAudit = (await observer.rtdb.get('latestEmailAudit')) as EmailAuditEntry;
    expect(existingAudit).toMatchObject({
      authType: 'USER',
      emailType: 'EMAIL_SIGN_IN',
      email: 'newcomer@allowed.test',
      hasData: false,
    });
    expect(await takeAuthMail(client.auth, 'newcomer@allowed.test')).not.toBeNull();

    // Tenant-scoped sign-in link -> resource.name carries tenant, and rejection blocks outbox.
    const tenantClient = await makeClientSession();
    tenantClient.auth.tenantId = 'tenant-alpha';
    await sendSignInLinkToEmail(tenantClient.auth, 'tenant-user@allowed.test', linkSettings);
    const tenantAudit = (await observer.rtdb.get('latestEmailAudit')) as EmailAuditEntry;
    expect(tenantAudit.resourceName).toBe('projects/demo-project/tenants/tenant-alpha');
    expect(await takeAuthMail(tenantClient.auth, 'tenant-user@allowed.test')).not.toBeNull();

    let quotaErr: (Error & { code?: string }) | undefined;
    try {
      await sendSignInLinkToEmail(client.auth, 'burst@ratelimit.test', linkSettings);
    } catch (err) {
      quotaErr = err as Error & { code?: string };
    }
    expect(quotaErr?.code).toBe('auth/internal-error');
    expect(quotaErr?.message).toContain('RESOURCE_EXHAUSTED');
    expect(await takeAuthMail(client.auth)).toBeNull();

    // Invalid recaptchaActionOverride fails closed with INVALID_ARGUMENT before writing mail.
    let badRecaptchaErr: (Error & { code?: string }) | undefined;
    try {
      await sendSignInLinkToEmail(client.auth, 'broken@badrecaptcha.test', linkSettings);
    } catch (err) {
      badRecaptchaErr = err as Error & { code?: string };
    }
    expect(badRecaptchaErr?.code).toBe('auth/internal-error');
    expect(badRecaptchaErr?.message).toContain('INVALID_ARGUMENT');
    expect(await takeAuthMail(client.auth)).toBeNull();
  });

  test('gates sendEmailVerification and verifyBeforeUpdateEmail for signed-in sessions', async () => {
    if (!observer) throw new Error('observer missing');
    const deniedClient = await makeClientSession();
    const deniedUserCred = await createUserWithEmailAndPassword(
      deniedClient.auth,
      'unverified@denied.test',
      'secret123',
    );
    let verifyBlockErr: (Error & { code?: string }) | undefined;
    try {
      await sendEmailVerification(deniedUserCred.user);
    } catch (err) {
      verifyBlockErr = err as Error & { code?: string };
    }
    expect(verifyBlockErr?.code).toBe('auth/internal-error');
    expect(await takeAuthMail(deniedClient.auth)).toBeNull();

    const okClient = await makeClientSession();
    const okCred = await createUserWithEmailAndPassword(
      okClient.auth,
      'verify-me@allowed.test',
      'secret123',
    );
    await sendEmailVerification(okCred.user);
    const verifyAudit = (await observer.rtdb.get('latestEmailAudit')) as EmailAuditEntry;
    expect(verifyAudit).toMatchObject({
      authType: 'USER',
      emailType: 'VERIFY_EMAIL',
      email: 'verify-me@allowed.test',
      hasData: false,
    });
    const verifyMail = await takeAuthMail(okClient.auth, 'verify-me@allowed.test');
    if (!verifyMail) throw new Error('expected verify mail');
    await applyActionCode(okClient.auth, verifyMail.code);

    // verifyBeforeUpdateEmail: blocked target address leaves account email and outbox untouched.
    let changeDeniedErr: (Error & { code?: string }) | undefined;
    try {
      await verifyBeforeUpdateEmail(okCred.user, 'moved@denied.test');
    } catch (err) {
      changeDeniedErr = err as Error & { code?: string };
    }
    expect(changeDeniedErr?.code).toBe('auth/internal-error');
    expect(await takeAuthMail(okClient.auth)).toBeNull();

    // Allowed verifyBeforeUpdateEmail emits VERIFY_AND_CHANGE_EMAIL with newEmail and updates on redeem.
    await verifyBeforeUpdateEmail(okCred.user, 'moved@allowed.test');
    const changeAudit = (await observer.rtdb.get('latestEmailAudit')) as EmailAuditEntry;
    expect(changeAudit).toMatchObject({
      authType: 'USER',
      emailType: 'VERIFY_AND_CHANGE_EMAIL',
      email: 'moved@allowed.test',
      hasData: false,
    });
    const changeMail = await takeAuthMail(okClient.auth, 'moved@allowed.test');
    if (!changeMail) throw new Error('expected change-email mail');
    await applyActionCode(okClient.auth, changeMail.code);
    const updated = (await listUsers(okClient.auth)).find((u) => u.uid === okCred.user.uid);
    expect(updated?.email).toBe('moved@allowed.test');
  });

  test('gates beforeSmsSent across SIGN_IN_OR_SIGN_UP, MULTI_FACTOR_SIGN_IN, and MULTI_FACTOR_ENROLLMENT', async () => {
    if (!observer) throw new Error('observer missing');
    const client = await makeClientSession();

    // Blocked prefix produces zero queued SMS in smsOutbox.
    let smsDeniedErr: (Error & { code?: string }) | undefined;
    try {
      await sendAuthSmsVerification(client.auth, {
        phoneNumber: '+15559990001',
        smsType: 'SIGN_IN_OR_SIGN_UP',
      });
    } catch (err) {
      smsDeniedErr = err as Error & { code?: string };
    }
    expect(smsDeniedErr?.code).toBe('auth/internal-error');
    expect(smsDeniedErr?.message).toContain('PERMISSION_DENIED');
    expect(await takeAuthSms(client.auth)).toBeNull();

    // Brand-new phone number -> UNAUTHENTICATED + recaptchaActionOverride: 'ALLOW'.
    const sentUnauth = await sendAuthSmsVerification(client.auth, {
      phoneNumber: '+15550101001',
      smsType: 'SIGN_IN_OR_SIGN_UP',
    });
    expect(sentUnauth.recaptchaActionOverride).toBe('ALLOW');
    const unauthAudit = (await observer.rtdb.get('latestSmsAudit')) as SmsAuditEntry;
    expect(unauthAudit).toMatchObject({
      onInitRan: true,
      eventType: 'providers/cloud.auth/eventTypes/user.beforeSendSms',
      authType: 'UNAUTHENTICATED',
      resourceName: 'projects/demo-project',
      smsType: 'SIGN_IN_OR_SIGN_UP',
      phoneNumber: '+15550101001',
      hasData: false,
    });
    expect((await takeAuthSms(client.auth, '+15550101001'))?.verificationId).toBe(
      sentUnauth.verificationId,
    );

    // Existing phone account -> USER on SIGN_IN_OR_SIGN_UP and MULTI_FACTOR_SIGN_IN, plus recaptchaActionOverride: 'BLOCK'.
    await adminCreateUser(client.auth, {
      uid: 'sms-user-1',
      email: 'sms-user@allowed.test',
      password: 'secret123',
      phoneNumber: '+15558880000',
    });
    const mfaSignInSms = await sendAuthSmsVerification(client.auth, {
      phoneNumber: '+15558880000',
      smsType: 'MULTI_FACTOR_SIGN_IN',
    });
    expect(mfaSignInSms.recaptchaActionOverride).toBe('BLOCK');
    const mfaSignInAudit = (await observer.rtdb.get('latestSmsAudit')) as SmsAuditEntry;
    expect(mfaSignInAudit).toMatchObject({
      authType: 'USER',
      smsType: 'MULTI_FACTOR_SIGN_IN',
      phoneNumber: '+15558880000',
      hasData: false,
    });
    expect(await takeAuthSms(client.auth, '+15558880000')).not.toBeNull();

    // Signed-in tenant user enrolling MFA phone -> resolves port session uid and tenant resource.name.
    const tenantSmsClient = await makeClientSession();
    tenantSmsClient.auth.tenantId = 'tenant-sms';
    const tenantUserCred = await createUserWithEmailAndPassword(
      tenantSmsClient.auth,
      'mfa-enroll@allowed.test',
      'secret123',
    );
    const enrollSms = await sendAuthSmsVerification(tenantSmsClient.auth, {
      phoneNumber: '+15550109999',
      smsType: 'MULTI_FACTOR_ENROLLMENT',
    });
    expect(enrollSms.uid).toBe(tenantUserCred.user.uid);
    const enrollAudit = (await observer.rtdb.get('latestSmsAudit')) as SmsAuditEntry;
    expect(enrollAudit).toMatchObject({
      authType: 'USER',
      resourceName: 'projects/demo-project/tenants/tenant-sms',
      smsType: 'MULTI_FACTOR_ENROLLMENT',
      phoneNumber: '+15550109999',
      hasData: false,
    });
    expect(await takeAuthSms(tenantSmsClient.auth, '+15550109999')).not.toBeNull();
  });

  test('executes ESM beforeEmailSent and beforeSmsSent child with top-level await and clean hot-swap', async () => {
    if (!hosted) throw new Error('hosted missing');
    if (activeChild) {
      const stopCode = await activeChild.stop();
      activeChild = undefined;
      expect(stopCode).toBe(0);
    }

    activeChild = spawnFunctionsChild({
      cwd: join(fixtureDir, 'functions-esm'),
      entry: join(fixtureDir, 'functions-esm/index.js'),
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
    const esmReady = await activeChild.ready;
    expect(esmReady).toEqual({
      triggerCount: 2,
      unsupportedTriggers: [],
    });

    const esmClient = await makeClientSession();
    const linkSettings = { url: 'https://example.com/esm', handleCodeInApp: true };
    let esmEmailErr: (Error & { code?: string }) | undefined;
    try {
      await sendSignInLinkToEmail(esmClient.auth, 'blocked@esm-deny.test', linkSettings);
    } catch (err) {
      esmEmailErr = err as Error & { code?: string };
    }
    expect(esmEmailErr?.code).toBe('auth/internal-error');
    expect(esmEmailErr?.message).toContain('ESM blocked email');
    expect(await takeAuthMail(esmClient.auth)).toBeNull();

    await sendSignInLinkToEmail(esmClient.auth, 'allowed@esm-ok.test', linkSettings);
    expect(await takeAuthMail(esmClient.auth, 'allowed@esm-ok.test')).not.toBeNull();

    let esmSmsErr: (Error & { code?: string }) | undefined;
    try {
      await sendAuthSmsVerification(esmClient.auth, {
        phoneNumber: '+15557770001',
        smsType: 'SIGN_IN_OR_SIGN_UP',
      });
    } catch (err) {
      esmSmsErr = err as Error & { code?: string };
    }
    expect(esmSmsErr?.code).toBe('auth/internal-error');
    expect(esmSmsErr?.message).toContain('ESM blocked SMS');
    expect(await takeAuthSms(esmClient.auth)).toBeNull();

    const okSms = await sendAuthSmsVerification(esmClient.auth, {
      phoneNumber: '+15552220001',
      smsType: 'SIGN_IN_OR_SIGN_UP',
    });
    expect(okSms.recaptchaActionOverride).toBe('ALLOW');
    expect(await takeAuthSms(esmClient.auth, '+15552220001')).not.toBeNull();
  }, 30_000);
});
