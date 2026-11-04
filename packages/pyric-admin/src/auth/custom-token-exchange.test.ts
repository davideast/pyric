/**
 * A server mints a custom token with `createCustomToken`, the client exchanges
 * it with `signInWithCustomToken`, and the server verifies the ID token the
 * client then holds (#1952). firebase-admin 13.10.0 mints the token as an
 * RS256 JWT for the identity toolkit audience, issued by the project's
 * service account, with `uid` and the developer claims under `claims`
 * (lib/auth/token-generator.js `createCustomToken`).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getClock } from 'pyric/sandbox/internal';
import { getAuth as getClientAuth, signInWithCustomToken } from 'pyric/auth';
import { deleteApp, getApps, initializeApp } from '../app/index.js';
import { getAuth } from './index.js';

const IDENTITY_TOOLKIT = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

function payloadOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('createCustomToken then signInWithCustomToken then verifyIdToken', () => {
  it('mints a custom token in production shape', async () => {
    const sandbox = initializeSandbox();
    const admin = getAuth(initializeApp({ sandbox }, 'custom-token-shape'));
    const token = await admin.createCustomToken('ada', { role: 'editor' });
    const [header] = token.split('.');
    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString('utf8'))).toEqual({ alg: 'RS256', typ: 'JWT' });
    const payload = payloadOf(token);
    expect(payload).toMatchObject({ aud: IDENTITY_TOOLKIT, uid: 'ada', claims: { role: 'editor' } });
    expect(payload.iss).toBe(payload.sub);
    expect(Number(payload.exp) - Number(payload.iat)).toBe(3600);
  });

  it('signs the client in as the uid, with the developer claims in the ID token', async () => {
    const sandbox = initializeSandbox();
    const admin = getAuth(initializeApp({ sandbox }, 'custom-token-round-trip'));
    const client = getClientAuth(sandbox);

    const customToken = await admin.createCustomToken('ada', { role: 'editor' });
    const { user } = await signInWithCustomToken(client, customToken);
    const decoded = await admin.verifyIdToken(await user.getIdToken());

    expect(user.uid).toBe('ada');
    expect(decoded.uid).toBe('ada');
    expect(decoded.role).toBe('editor');
    expect(decoded.firebase.sign_in_provider).toBe('custom');
  });

  it('refuses the custom token itself at verifyIdToken, as production does', async () => {
    const sandbox = initializeSandbox();
    const admin = getAuth(initializeApp({ sandbox }, 'custom-token-not-id-token'));
    const customToken = await admin.createCustomToken('ada');
    await expect(admin.verifyIdToken(customToken)).rejects.toMatchObject({
      code: 'auth/argument-error',
      message: expect.stringContaining('was given a custom token'),
    });
  });

  it('refuses a custom token whose claims were edited after signing', async () => {
    const sandbox = initializeSandbox();
    const admin = getAuth(initializeApp({ sandbox }, 'custom-token-forged'));
    const [header, , signature] = (await admin.createCustomToken('ada')).split('.');
    const forged = { ...payloadOf(await admin.createCustomToken('ada')), uid: 'victim', claims: { admin: true } };
    const segment = Buffer.from(JSON.stringify(forged), 'utf8').toString('base64url');
    await expect(signInWithCustomToken(getClientAuth(sandbox), `${header}.${segment}.${signature}`)).rejects.toMatchObject({
      code: 'auth/invalid-custom-token',
    });
  });

  it("refuses a custom token minted for another project with production's code", async () => {
    const sandbox = initializeSandbox();
    const admin = getAuth(initializeApp({ sandbox, projectId: 'demo-other-project' }, 'custom-token-other-project'));
    const customToken = await admin.createCustomToken('ada');
    await expect(signInWithCustomToken(getClientAuth(sandbox), customToken)).rejects.toMatchObject({
      code: 'auth/custom-token-mismatch',
    });
  });

  it('refuses a custom token an hour after it was minted, with the code the client SDK maps INVALID_CUSTOM_TOKEN to', async () => {
    const sandbox = initializeSandbox();
    const admin = getAuth(initializeApp({ sandbox }, 'custom-token-expired'));
    const customToken = await admin.createCustomToken('ada');
    getClock(sandbox).advance(60 * 60 * 1000);
    await expect(signInWithCustomToken(getClientAuth(sandbox), customToken)).rejects.toMatchObject({
      code: 'auth/invalid-custom-token',
    });
  });

  it('refuses a malformed custom token', async () => {
    const sandbox = initializeSandbox();
    await expect(signInWithCustomToken(getClientAuth(sandbox), 'not-a-token')).rejects.toMatchObject({
      code: 'auth/invalid-custom-token',
    });
  });
});
