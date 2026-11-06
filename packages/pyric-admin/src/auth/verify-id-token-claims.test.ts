/**
 * `verifyIdToken` on a client ID token returns the token's own `sub`, `aud`,
 * `iss`, `iat`, `exp` and `auth_time`, not values made up at verify time
 * (auth-claims AU-7). A server's recent-sign-in check reads `auth_time`
 * (firebase.google.com/docs/auth/admin/manage-cookies: "the auth_time should
 * be checked"), and production keeps it at the sign-in across refreshes
 * (firebase-admin `token-verifier.d.ts`: "the same auth_time value"; capture
 * `admin.verifyIdTokenDecoded.authTimeEqualsToken: true`).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { initializeSandbox } from 'pyric/sandbox';
import { getClock } from 'pyric/sandbox/internal';
import { createUserWithEmailAndPassword, getAuth as getClientAuth } from 'pyric/auth';
import { deleteApp, getApps, initializeApp } from '../app/index.js';
import { getAuth } from './index.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('verifyIdToken returns the client token claims', () => {
  it('keeps auth_time at the sign-in and iat at the refresh', async () => {
    const sandbox = initializeSandbox();
    const admin = getAuth(initializeApp({ sandbox }, 'verify-id-token-claims'));
    const client = getClientAuth(sandbox);
    // Move the sandbox clock away from the wall clock, so a value made up at
    // verify time cannot match by accident.
    getClock(sandbox).advance(60 * 60 * 1000);
    const { user } = await createUserWithEmailAndPassword(client, 'ada@example.com', 'secret-pw');
    getClock(sandbox).advance(10 * 60 * 1000);
    const idToken = await user.getIdToken(true);
    const { claims } = await user.getIdTokenResult();

    const decoded = await admin.verifyIdToken(idToken);

    for (const key of ['sub', 'aud', 'iss', 'iat', 'exp', 'auth_time'] as const) {
      expect(decoded[key]).toEqual(claims[key]);
    }
    expect(decoded.uid).toBe(user.uid);
    expect(decoded.iat - decoded.auth_time).toBe(600);
  });
});

/** A base64url JSON segment. */
function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * An ID token shaped as production's (#2304): RS256, a 40-hex `kid` naming
 * a key the sandbox does not hold, and a securetoken issuer, signed with a
 * throwaway RSA key.
 */
function productionShapedIdToken(projectId: string, nowSec: number): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomBytes(20).toString('hex');
  const claims = {
    iss: `https://securetoken.google.com/${projectId}`,
    aud: projectId,
    sub: 'production-uid',
    user_id: 'production-uid',
    auth_time: nowSec,
    iat: nowSec,
    exp: nowSec + 3600,
    firebase: { identities: {}, sign_in_provider: 'password' },
  };
  const input = `${segment({ alg: 'RS256', kid, typ: 'JWT' })}.${segment(claims)}`;
  const signature = createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url');
  return `${input}.${signature}`;
}

interface RefusalData {
  code?: unknown;
  pyricCode?: unknown;
}

async function refusalOf(verified: Promise<unknown>): Promise<RefusalData> {
  try {
    await verified;
  } catch (error) {
    const { code, pyricCode } = error as RefusalData;
    return { code, pyricCode };
  }
  throw new Error('verifyIdToken resolved');
}

/**
 * Verifies `token` twice in a fresh process, so no earlier test has spent the
 * once-per-process report, and returns that process's stderr.
 */
function stderrOfTwoVerifications(token: string, projectId: string): string {
  const verifier = new URL('./verify-token.ts', import.meta.url).href;
  const script = [
    `const { verifySandboxIdToken } = await import(${JSON.stringify(verifier)});`,
    'for (let attempt = 0; attempt < 2; attempt++) {',
    `  await verifySandboxIdToken(${JSON.stringify(token)}, { projectId: ${JSON.stringify(projectId)}, nowMs: Date.now() }).catch(() => {});`,
    '}',
  ].join('\n');
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  if (child.status !== 0) throw new Error(`the verifying process exited ${child.status}: ${child.stderr}`);
  return child.stderr;
}

describe('a sandbox backend refuses a production ID token by name (#2304)', () => {
  const PROJECT = 'demo-mode-mismatch';

  it('keeps auth/argument-error and adds PYRIC_MODE_MISMATCH', async () => {
    const sandbox = initializeSandbox();
    const admin = getAuth(initializeApp({ sandbox, projectId: PROJECT }, 'mode-mismatch'));
    const nowSec = Math.floor(getClock(sandbox).now() / 1000);
    const refusal = await refusalOf(admin.verifyIdToken(productionShapedIdToken(PROJECT, nowSec)));
    expect(refusal).toEqual({ code: 'auth/argument-error', pyricCode: 'PYRIC_MODE_MISMATCH' });
  });

  it('writes one stderr line per process, however many tokens it refuses', () => {
    const token = productionShapedIdToken(PROJECT, Math.floor(Date.now() / 1000));
    const lines = stderrOfTwoVerifications(token, PROJECT).split('\n').filter((line) => line.includes('PYRIC_MODE_MISMATCH'));
    expect(lines.length).toBe(1);
  });

  it('leaves a sandbox token with a bad signature, and a production token for another project, as firebase-admin answers', async () => {
    const sandbox = initializeSandbox();
    const admin = getAuth(initializeApp({ sandbox, projectId: PROJECT }, 'mode-mismatch-other'));
    const client = getClientAuth(sandbox);
    const { user } = await createUserWithEmailAndPassword(client, 'grace@example.com', 'secret-pw');
    const [header, payload] = (await user.getIdToken()).split('.');
    const badSignature = await refusalOf(admin.verifyIdToken(`${header}.${payload}.AAAA`));
    expect(badSignature).toEqual({ code: 'auth/argument-error', pyricCode: undefined });

    const nowSec = Math.floor(getClock(sandbox).now() / 1000);
    const otherProject = await refusalOf(admin.verifyIdToken(productionShapedIdToken('demo-other-project', nowSec)));
    expect(otherProject).toEqual({ code: 'auth/argument-error', pyricCode: undefined });
  });
});
