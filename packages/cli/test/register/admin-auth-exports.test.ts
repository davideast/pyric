/**
 * Verifies that `firebase-admin/auth` and `firebase-admin` under
 * `node --import @pyric/cli/register` expose `FirebaseAuthError`,
 * `AuthClientErrorCode`, `Auth`, `BaseAuth`, `UserRecord`, `UserMetadata`, and
 * `UserInfo` across both ESM `import` and CommonJS `require` (`auth-admin#14`).
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const registerUrl = pathToFileURL(join(cliRoot, 'dist/register/index.js')).href;

const CHILD_SCRIPT = `
import { createRequire } from 'node:module';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import {
  Auth,
  AuthClientErrorCode,
  BaseAuth,
  FirebaseAuthError,
  UserInfo,
  UserMetadata,
  UserRecord,
  getAuth,
} from 'firebase-admin/auth';

const require = createRequire(import.meta.url);
const cjsAdmin = require('firebase-admin');
const cjsAuthMod = require('firebase-admin/auth');

const sandbox = initializeSandbox();
const localApp = initializeApp({ sandbox, projectId: 'demo-project' }, 'register-auth-local');
const ambientRemoteApp = initializeApp({ projectId: 'demo-project' }, 'register-auth-ambient');
try {
  const localAuth = getAuth(localApp);
  const ambientRemoteAuth = getAuth(ambientRemoteApp);

  const created = await localAuth.createUser({
    uid: 'user-register-1',
    email: 'alice@example.com',
    password: 'secret-password',
  });

  let missingErr = null;
  try {
    await localAuth.getUser('missing-register-uid');
  } catch (err) {
    missingErr = err;
  }

  let reservedClaimErr = null;
  try {
    await localAuth.setCustomUserClaims('user-register-1', { sub: 'forbidden' });
  } catch (err) {
    reservedClaimErr = err;
  }

  let remoteInvalidUidErr = null;
  try {
    await ambientRemoteAuth.getUser('');
  } catch (err) {
    remoteInvalidUidErr = err;
  }

  const constructed = new FirebaseAuthError(
    AuthClientErrorCode.USER_NOT_FOUND,
    'Explicit override.',
  );

  process.stdout.write(
    JSON.stringify({
      cjsAuthClassIdentical: cjsAdmin.auth.Auth === Auth && cjsAuthMod.Auth === Auth,
      cjsErrorIdentical: cjsAuthMod.FirebaseAuthError === FirebaseAuthError,
      cjsCodesIdentical: cjsAuthMod.AuthClientErrorCode === AuthClientErrorCode,
      localAuthIsAuth: localAuth instanceof Auth,
      localAuthIsBaseAuth: localAuth instanceof BaseAuth,
      ambientRemoteIsAuth: ambientRemoteAuth instanceof Auth,
      ambientRemoteIsBaseAuth: ambientRemoteAuth instanceof BaseAuth,
      recordIsUserRecord: created instanceof UserRecord,
      metadataIsUserMetadata: created.metadata instanceof UserMetadata,
      providerInfoIsUserInfo: created.providerData[0] instanceof UserInfo,
      missingIsFirebaseAuthError: missingErr instanceof FirebaseAuthError,
      missingCode: missingErr && missingErr.code,
      reservedIsFirebaseAuthError: reservedClaimErr instanceof FirebaseAuthError,
      reservedCode: reservedClaimErr && reservedClaimErr.code,
      remoteInvalidUidIsFirebaseAuthError: remoteInvalidUidErr instanceof FirebaseAuthError,
      remoteInvalidUidCode: remoteInvalidUidErr && remoteInvalidUidErr.code,
      constructedCode: constructed.code,
      constructedMessage: constructed.message,
    }) + '\\n',
  );
} finally {
  await deleteApp(localApp);
  await deleteApp(ambientRemoteApp);
  sandbox.dispose();
}
`;

describe('register swap: firebase-admin/auth runtime error and class exports', () => {
  it('exposes FirebaseAuthError, AuthClientErrorCode, and modeled nominal classes across ESM and CJS', () => {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PYRIC_SANDBOX: '1',
      NODE_OPTIONS: '',
    };
    const result = spawnSync(
      'node',
      ['--input-type=module', '--import', registerUrl, '-e', CHILD_SCRIPT],
      {
        cwd: repoRoot,
        env: childEnv,
        encoding: 'utf8',
      },
    );
    if (result.status !== 0) {
      throw new Error(
        `Registered node child failed (exit ${String(result.status)}):\n${result.stdout}\n${result.stderr}`,
      );
    }

    const lines = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{'));
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toBeDefined();
    if (lastLine === undefined) {
      throw new Error(`Expected JSON summary line in stdout:\n${result.stdout}`);
    }
    const summary = JSON.parse(lastLine) as Record<string, unknown>;
    expect(summary).toEqual({
      cjsAuthClassIdentical: true,
      cjsErrorIdentical: true,
      cjsCodesIdentical: true,
      localAuthIsAuth: true,
      localAuthIsBaseAuth: true,
      ambientRemoteIsAuth: true,
      ambientRemoteIsBaseAuth: true,
      recordIsUserRecord: true,
      metadataIsUserMetadata: true,
      providerInfoIsUserInfo: true,
      missingIsFirebaseAuthError: true,
      missingCode: 'auth/user-not-found',
      reservedIsFirebaseAuthError: true,
      reservedCode: 'auth/reserved-claim',
      remoteInvalidUidIsFirebaseAuthError: true,
      remoteInvalidUidCode: 'auth/invalid-uid',
      constructedCode: 'auth/user-not-found',
      constructedMessage: 'Explicit override.',
    });
  });
});
