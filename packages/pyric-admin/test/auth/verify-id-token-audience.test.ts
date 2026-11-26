/**
 * Audience / projectId resolution for `pyric-admin/auth` `verifyIdToken` and
 * `createCustomToken`, plus fail-closed clock guards across local and remote
 * sandbox arms.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox, type RemoteSandboxChannel } from 'pyric/sandbox';
import {
  getClock,
  idTokenAudience,
  mintIdToken,
  SANDBOX_PROJECT_ID,
} from 'pyric/sandbox/internal';
import {
  createUserWithEmailAndPassword,
  getAuth as getClientAuth,
  sandbox as clientAuthSandbox,
  signInWithCustomToken,
} from 'pyric/auth';
import { initializeApp as initializeClientApp } from 'pyric/app';
import { bindAppRegistrySandbox, resetAppRegistryForTests } from 'pyric/app/internal';
import { createRemoteSandboxHandle } from '../../../cli/src/remote/index.js';
import { cert, deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getAuth } from '../../src/auth/index.js';
import { verifySandboxIdToken } from '../../src/auth/verify-token.js';

const ENV_KEYS = [
  'PYRIC_PROJECT',
  'GOOGLE_CLOUD_PROJECT',
  'GCLOUD_PROJECT',
  'FIREBASE_CONFIG',
] as const;

const originalCwd = process.cwd();
const originalEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) {
  originalEnv[key] = process.env[key];
}

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function clearProjectEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

function mintTokenFor(projectId: string, nowSec: number, extra: Record<string, unknown> = {}): string {
  return mintIdToken({
    ...idTokenAudience(projectId),
    sub: 'user-aud-1',
    user_id: 'user-aud-1',
    iat: nowSec,
    auth_time: nowSec,
    exp: nowSec + 3600,
    firebase: { identities: {}, sign_in_provider: 'password' },
    ...extra,
  });
}

function makeRemoteApp(appName: string, clockReply: () => unknown, projectId?: string) {
  const channel: RemoteSandboxChannel = {
    op: async (payload) => {
      if (payload.method === 'sandbox.clock') {
        return clockReply();
      }
      throw new Error(`Unexpected op: ${String(payload.method)}`);
    },
    subscribe: () => () => {},
  };
  const remote = createRemoteSandboxHandle({
    channel,
    serveUrl: 'http://localhost:0',
    close: () => {},
  });
  const options: { sandbox: typeof remote; projectId?: string } = { sandbox: remote };
  if (projectId !== undefined) {
    options.projectId = projectId;
  }
  const app = initializeApp(options, appName);
  return { app, auth: getAuth(app) };
}

afterEach(async () => {
  resetAppRegistryForTests();
  process.chdir(originalCwd);
  for (const key of ENV_KEYS) {
    const saved = originalEnv[key];
    if (saved === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved;
    }
  }
  await Promise.all(getApps().map((app) => deleteApp(app)));
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('verifyIdToken audience consistency with sandbox and pyric.json project config', () => {
  it('aligns in-process admin verifyIdToken and createCustomToken with sandbox Auth projectId', async () => {
    clearProjectEnv();
    const sandbox = initializeSandbox();
    const clientAuth = getClientAuth(sandbox);
    clientAuthSandbox.setProjectIdSource(clientAuth, () => 'real-sandbox-proj');

    const { user } = await createUserWithEmailAndPassword(clientAuth, 'ada@example.com', 'secret-pw');
    const clientToken = await user.getIdToken();

    const adminAuth = getAuth(initializeApp({ sandbox }, 'aligned-sandbox-project'));
    const decoded = await adminAuth.verifyIdToken(clientToken);
    expect(decoded.uid).toBe(user.uid);
    expect(decoded.aud).toBe('real-sandbox-proj');
    expect(decoded.iss).toBe('https://securetoken.google.com/real-sandbox-proj');

    // Cross-project and default pyric-sandbox tokens are strictly rejected.
    const nowSec = Math.floor(getClock(sandbox).now() / 1000);
    await expect(
      adminAuth.verifyIdToken(mintTokenFor(SANDBOX_PROJECT_ID, nowSec)),
    ).rejects.toMatchObject({ code: 'auth/argument-error' });
    await expect(
      adminAuth.verifyIdToken(mintTokenFor('other-proj', nowSec)),
    ).rejects.toMatchObject({ code: 'auth/argument-error' });

    // Custom token round-trip uses the same resolved projectId.
    const customToken = await adminAuth.createCustomToken('grace', { role: 'owner' });
    const exchanged = await signInWithCustomToken(clientAuth, customToken);
    const verifiedCustom = await adminAuth.verifyIdToken(await exchanged.user.getIdToken());
    expect(verifiedCustom.uid).toBe('grace');
    expect(verifiedCustom.aud).toBe('real-sandbox-proj');
  });

  it('aligns in-process admin verifyIdToken with a client FirebaseApp projectId on the same sandbox', async () => {
    clearProjectEnv();
    const sandbox = initializeSandbox();
    bindAppRegistrySandbox(sandbox);
    const clientApp = initializeClientApp({ projectId: 'client-app-real-proj' }, 'client-aud-app');
    const clientAuth = getClientAuth(clientApp);
    const { user } = await createUserWithEmailAndPassword(clientAuth, 'linus@example.com', 'secret-pw');
    const token = await user.getIdToken();

    const adminAuth = getAuth(initializeApp({ sandbox }, 'aligned-client-app-project'));
    const decoded = await adminAuth.verifyIdToken(token);
    expect(decoded.uid).toBe(user.uid);
    expect(decoded.aud).toBe('client-app-real-proj');

    const nowSec = Math.floor(getClock(sandbox).now() / 1000);
    await expect(
      adminAuth.verifyIdToken(mintTokenFor(SANDBOX_PROJECT_ID, nowSec)),
    ).rejects.toMatchObject({ code: 'auth/argument-error' });
  });

  it('resolves projectId from pyric.json (including ancestor dir and .firebaserc aliases) in local and remote arms', async () => {
    clearProjectEnv();
    const root = makeTempDir('pyric-aud-json-');
    const nested = join(root, 'apps', 'web');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, 'pyric.json'), JSON.stringify({ project: 'staging' }), 'utf8');
    writeFileSync(
      join(root, '.firebaserc'),
      JSON.stringify({ projects: { staging: 'staging-real-proj' } }),
      'utf8',
    );
    process.chdir(nested);

    const sandbox = initializeSandbox();
    const nowMs = getClock(sandbox).now();
    const nowSec = Math.floor(nowMs / 1000);
    const localAdmin = getAuth(initializeApp({ sandbox }, 'pyric-json-local'));
    const { auth: remoteAdmin } = makeRemoteApp('pyric-json-remote', () => ({ now: nowMs }));

    const validToken = mintTokenFor('staging-real-proj', nowSec);
    const sandboxToken = mintTokenFor(SANDBOX_PROJECT_ID, nowSec);
    const otherToken = mintTokenFor('wrong-proj', nowSec);

    for (const admin of [localAdmin, remoteAdmin]) {
      const decoded = await admin.verifyIdToken(validToken);
      expect(decoded.aud).toBe('staging-real-proj');
      await expect(admin.verifyIdToken(sandboxToken)).rejects.toMatchObject({
        code: 'auth/argument-error',
      });
      await expect(admin.verifyIdToken(otherToken)).rejects.toMatchObject({
        code: 'auth/argument-error',
      });
    }
  });

  it('prefers PYRIC_PROJECT over pyric.json and resolves .firebaserc aliases', async () => {
    clearProjectEnv();
    const root = makeTempDir('pyric-aud-env-');
    writeFileSync(join(root, 'pyric.json'), JSON.stringify({ project: 'from-file-proj' }), 'utf8');
    writeFileSync(
      join(root, '.firebaserc'),
      JSON.stringify({ projects: { prod: 'env-resolved-proj' } }),
      'utf8',
    );
    process.chdir(root);
    process.env.PYRIC_PROJECT = 'prod';

    const sandbox = initializeSandbox();
    const nowSec = Math.floor(getClock(sandbox).now() / 1000);
    const admin = getAuth(initializeApp({ sandbox }, 'pyric-env-override'));

    const decoded = await admin.verifyIdToken(mintTokenFor('env-resolved-proj', nowSec));
    expect(decoded.aud).toBe('env-resolved-proj');
    await expect(
      admin.verifyIdToken(mintTokenFor('from-file-proj', nowSec)),
    ).rejects.toMatchObject({ code: 'auth/argument-error' });
  });

  it('does not infer a project from bare .firebaserc or a pyric.json without project', async () => {
    clearProjectEnv();
    const root = makeTempDir('pyric-aud-bare-rc-');
    const child = join(root, 'nested');
    mkdirSync(child, { recursive: true });
    writeFileSync(join(root, 'pyric.json'), JSON.stringify({ project: 'outer-proj' }), 'utf8');
    writeFileSync(
      join(root, '.firebaserc'),
      JSON.stringify({ projects: { default: 'bare-rc-proj' } }),
      'utf8',
    );
    // Child has its own pyric.json without `project`, blocking parent leakage.
    writeFileSync(join(child, 'pyric.json'), JSON.stringify({}), 'utf8');
    writeFileSync(
      join(child, '.firebaserc'),
      JSON.stringify({ projects: { default: 'child-bare-rc-proj' } }),
      'utf8',
    );
    process.chdir(child);

    const sandbox = initializeSandbox();
    const nowSec = Math.floor(getClock(sandbox).now() / 1000);
    const admin = getAuth(initializeApp({ sandbox }, 'bare-rc-fallback'));

    const decoded = await admin.verifyIdToken(mintTokenFor(SANDBOX_PROJECT_ID, nowSec));
    expect(decoded.aud).toBe(SANDBOX_PROJECT_ID);
    await expect(
      admin.verifyIdToken(mintTokenFor('outer-proj', nowSec)),
    ).rejects.toMatchObject({ code: 'auth/argument-error' });
    await expect(
      admin.verifyIdToken(mintTokenFor('child-bare-rc-proj', nowSec)),
    ).rejects.toMatchObject({ code: 'auth/argument-error' });
  });

  it('always prefers explicit admin projectId, cert(), or GOOGLE_CLOUD_PROJECT over sandbox and pyric.json', async () => {
    clearProjectEnv();
    const root = makeTempDir('pyric-aud-explicit-');
    writeFileSync(join(root, 'pyric.json'), JSON.stringify({ project: 'file-proj' }), 'utf8');
    process.chdir(root);
    process.env.PYRIC_PROJECT = 'pyric-env-proj';

    const sandbox = initializeSandbox();
    const clientAuth = getClientAuth(sandbox);
    clientAuthSandbox.setProjectIdSource(clientAuth, () => 'sandbox-proj');
    const nowSec = Math.floor(getClock(sandbox).now() / 1000);

    const explicitAdmin = getAuth(
      initializeApp({ sandbox, projectId: 'explicit-admin-proj' }, 'explicit-option'),
    );
    expect((await explicitAdmin.verifyIdToken(mintTokenFor('explicit-admin-proj', nowSec))).aud).toBe(
      'explicit-admin-proj',
    );
    for (const rejected of ['sandbox-proj', 'pyric-env-proj', 'file-proj', SANDBOX_PROJECT_ID]) {
      await expect(
        explicitAdmin.verifyIdToken(mintTokenFor(rejected, nowSec)),
      ).rejects.toMatchObject({ code: 'auth/argument-error' });
    }

    const certAdmin = getAuth(
      initializeApp(
        {
          sandbox,
          credential: cert({
            projectId: 'cert-admin-proj',
            clientEmail: 'svc@cert-admin-proj.iam.gserviceaccount.com',
            privateKey: 'unused-in-sandbox',
          }),
        },
        'explicit-cert',
      ),
    );
    expect((await certAdmin.verifyIdToken(mintTokenFor('cert-admin-proj', nowSec))).aud).toBe(
      'cert-admin-proj',
    );
    await expect(
      certAdmin.verifyIdToken(mintTokenFor('sandbox-proj', nowSec)),
    ).rejects.toMatchObject({ code: 'auth/argument-error' });

    process.env.GOOGLE_CLOUD_PROJECT = 'gcp-env-proj';
    const gcpAdmin = getAuth(initializeApp({ sandbox }, 'explicit-gcp-env'));
    expect((await gcpAdmin.verifyIdToken(mintTokenFor('gcp-env-proj', nowSec))).aud).toBe(
      'gcp-env-proj',
    );
    await expect(
      gcpAdmin.verifyIdToken(mintTokenFor('sandbox-proj', nowSec)),
    ).rejects.toMatchObject({ code: 'auth/argument-error' });
  });

  it('fails closed when nowMs or remote sandbox.clock is non-finite instead of bypassing expiry/nbf', async () => {
    clearProjectEnv();
    const nowSec = Math.floor(Date.now() / 1000);
    const expiredToken = mintTokenFor(SANDBOX_PROJECT_ID, nowSec - 7200, {
      exp: nowSec - 3600,
    });
    const futureNbfToken = mintTokenFor(SANDBOX_PROJECT_ID, nowSec, {
      nbf: nowSec + 3600,
    });

    for (const badNow of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await expect(
        verifySandboxIdToken(expiredToken, { projectId: SANDBOX_PROJECT_ID, nowMs: badNow }),
      ).rejects.toMatchObject({ code: 'auth/internal-error' });
      await expect(
        verifySandboxIdToken(futureNbfToken, { projectId: SANDBOX_PROJECT_ID, nowMs: badNow }),
      ).rejects.toMatchObject({ code: 'auth/internal-error' });
    }

    const { auth: nanClockRemote } = makeRemoteApp('remote-nan-clock', () => ({ now: Number.NaN }));
    await expect(nanClockRemote.verifyIdToken(expiredToken)).rejects.toMatchObject({
      code: 'auth/internal-error',
    });

    const { auth: missingClockRemote } = makeRemoteApp('remote-missing-clock', () => ({}));
    await expect(missingClockRemote.verifyIdToken(futureNbfToken)).rejects.toMatchObject({
      code: 'auth/internal-error',
    });

    const validToken = mintTokenFor(SANDBOX_PROJECT_ID, nowSec);
    await expect(
      verifySandboxIdToken(validToken, { projectId: '', nowMs: nowSec * 1000 }),
    ).rejects.toMatchObject({ code: 'auth/internal-error' });
  });
});
