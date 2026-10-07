/**
 * The agent identity carries the account's standard claims: after
 * `useAppSession` or `switch_auth_identity` to a uid with an Auth account,
 * rules read `request.auth.token.email_verified` and `firebase.identities`
 * as they do for the application's own signed-in user.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAuth, sandbox as authSandbox, signInWithEmailAndPassword } from 'pyric/auth';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { createSurfaceContext, renderSurface } from '../../../src/bridge/surface/index.js';

const VERIFIED_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /verified/{id} {
      allow read, write: if request.auth.token.email_verified == true
        && request.auth.token.firebase.identities.email[0] == request.auth.token.email;
    }
  }
}`;

function harness(emailVerified: boolean) {
  const sandbox = initializeSandbox();
  setRules(sandbox, VERIFIED_RULES);
  const auth = getAuth(sandbox);
  const record = authSandbox.createUser(auth, {
    email: 'ada@example.com', password: 'secret-pw', emailVerified, customClaims: { role: 'editor' },
  });
  const ctx = createSurfaceContext(sandbox, mkdtempSync(join(tmpdir(), 'pyric-identity-claims-')));
  const surface = renderSurface(undefined);
  const run = (key: string, args: Record<string, unknown> = {}) => {
    const [toolName, method] = key.split('.');
    const tool = surface.tools.find((candidate) => candidate.name === toolName);
    if (!tool) throw new Error(`no rendered tool named ${toolName}`);
    return tool.execute({ method, args }, ctx);
  };
  return { sandbox, auth, uid: record.uid, ctx, run };
}

describe('the agent identity projects the account standard claims', () => {
  for (const emailVerified of [true, false]) {
    it(`useAppSession: ${emailVerified ? 'a verified user is allowed' : 'an unverified user is denied'}`, async () => {
      const { auth, run } = harness(emailVerified);
      await signInWithEmailAndPassword(auth, 'ada@example.com', 'secret-pw');
      expect((await run('auth.useAppSession')).ok).toBe(true);
      const written = await run('firestore.setDoc', { path: 'verified/a', data: { ok: true } });
      expect(written.ok).toBe(emailVerified);
    });
  }

  it('switch to a uid carries the account claims, the custom claims, and the sign-in provider of the app session', async () => {
    const { auth, uid, ctx } = harness(true);
    await signInWithEmailAndPassword(auth, 'ada@example.com', 'secret-pw');
    ctx.identity.switchTo({ mode: 'uid', uid });
    const state = ctx.identity.authState();
    expect(state?.token).toMatchObject({
      role: 'editor',
      email: 'ada@example.com',
      email_verified: true,
      user_id: uid,
      firebase: { identities: { email: ['ada@example.com'] }, sign_in_provider: 'password' },
    });
  });

  it('a verification recorded after the switch reaches the next call', async () => {
    const { auth, uid, ctx, run } = harness(false);
    ctx.identity.switchTo({ mode: 'uid', uid });
    expect((await run('firestore.setDoc', { path: 'verified/a', data: { ok: true } })).ok).toBe(false);
    authSandbox.updateUser(auth, uid, { emailVerified: true });
    expect((await run('firestore.setDoc', { path: 'verified/a', data: { ok: true } })).ok).toBe(true);
  });

  it('a stated tenant still lands on firebase.tenant beside the account claims', () => {
    const { uid, ctx } = harness(true);
    ctx.identity.switchTo({ mode: 'uid', uid, tenant: 'tenant-a' });
    expect(ctx.identity.authState()?.token?.firebase).toEqual({
      identities: { email: ['ada@example.com'] }, sign_in_provider: null, tenant: 'tenant-a',
    });
  });
});
