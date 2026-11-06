/**
 * Served `signInWithCredential` with an email credential (#1448).
 *
 * The served client must carry the credential's secret (the password, or the
 * link for `credentialWithLink`) to the host, and the host must check it with
 * the engine, as `signInWithEmailAndPassword` and `signInWithEmailLink` do.
 * A wrong, empty or missing secret is refused with the in-page codes and binds
 * no session to the port.
 */

import { describe, expect, it } from 'bun:test';
import { EmailAuthProvider, GoogleAuthProvider, getAuth, sandbox as authSandbox } from 'pyric/auth';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { handleMessage, type HostCtx, type PortLike } from '../host.js';
import { portSession } from '../host-auth.js';
import { signInWithCredentialPayload, type CredentialPayload } from '../host/auth-credential-sign-in.js';
import type { InboundMessage, OutboundMessage, ResMessage, ResolvedIdentity } from '../protocol.js';
import { wirePort } from '../client/core.js';
import type { ClientPort } from '../client/handles.js';
import {
  createUserWithEmailAndPassword,
  getAuth as getClientAuth,
  sendSignInLinkToEmail,
  signInWithCredential,
  signOut,
  stageSignInResult,
  type ClientDb,
} from '../client.js';

const OWNER = 'owner@example.com';
const PASSWORD = 'right-password';

function harness() {
  const sandbox = initializeSandbox();
  const ctx: HostCtx = { sandbox, db: getFirestore(sandbox), subs: new Map(), sessionMode: 'LOCAL' };
  let clientPort!: ClientPort;
  const hostPort: PortLike = {
    postMessage(message: OutboundMessage) {
      clientPort.onmessage?.({ data: message } as MessageEvent<OutboundMessage>);
    },
  };
  clientPort = {
    onmessage: null,
    postMessage(message: InboundMessage) { void handleMessage(ctx, hostPort, message); },
    start() {},
  };
  wirePort(clientPort);
  const clientDb: ClientDb = { __kind: 'client-db', port: clientPort };
  const clientAuth = getClientAuth(clientDb);

  const rawMessages: OutboundMessage[] = [];
  const rawPort: PortLike = { postMessage: (message) => rawMessages.push(message) };
  async function sendRaw(fields: Record<string, unknown>): Promise<ResMessage> {
    const id = crypto.randomUUID();
    await handleMessage(ctx, rawPort, { ...fields, t: 'op', id, method: 'auth.signInWithCredential' } as InboundMessage);
    const response = rawMessages.find((entry): entry is ResMessage => entry.t === 'res' && entry.id === id);
    if (response === undefined) throw new Error('No response from host');
    return response;
  }

  async function createOwner(): Promise<string> {
    const created = await createUserWithEmailAndPassword(clientAuth, OWNER, PASSWORD);
    await signOut(clientAuth);
    return created.user.uid;
  }

  function userCount(): number {
    return authSandbox.listUsers(getAuth(sandbox)).length;
  }

  return { ctx, sandbox, hostPort, clientAuth, rawPort, sendRaw, createOwner, userCount };
}

const nothingStaged = (): null => null;

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
  return 'signed-in';
}

describe('served signInWithCredential with an email credential', () => {
  it('refuses a wrong password, an empty password and an unknown email with the in-page codes', async () => {
    const h = harness();
    await h.createOwner();
    const before = h.userCount();

    const wrong = EmailAuthProvider.credential(OWNER, 'wrong-password');
    expect(await refusal(signInWithCredential(h.clientAuth, wrong))).toBe('auth/wrong-password');
    const empty = EmailAuthProvider.credential(OWNER, '');
    expect(await refusal(signInWithCredential(h.clientAuth, empty))).toBe('auth/missing-password');
    const unknown = EmailAuthProvider.credential('nobody@example.com', PASSWORD);
    expect(await refusal(signInWithCredential(h.clientAuth, unknown))).toBe('auth/user-not-found');

    expect(portSession(h.ctx, h.hostPort)).toBeNull();
    expect(h.clientAuth.currentUser).toBeNull();
    expect(h.userCount()).toBe(before);
  });

  it('signs in with the right password and reports a null providerId', async () => {
    const h = harness();
    const uid = await h.createOwner();

    const result = await signInWithCredential(h.clientAuth, EmailAuthProvider.credential(OWNER, PASSWORD));

    expect(result.user.uid).toBe(uid);
    expect(result.providerId).toBeNull();
    expect(result._additionalUserInfo?.isNewUser).toBe(false);
    expect(portSession(h.ctx, h.hostPort)?.user.uid).toBe(uid);
  });

  it('refuses an email link the engine did not issue and accepts one it mailed', async () => {
    const h = harness();
    const madeUp = 'https://example.com/__/auth/action?mode=signIn&oobCode=made-up&apiKey=fake';
    const forged = EmailAuthProvider.credentialWithLink(OWNER, madeUp);
    expect(await refusal(signInWithCredential(h.clientAuth, forged))).toBe('auth/invalid-action-code');
    expect(portSession(h.ctx, h.hostPort)).toBeNull();

    await sendSignInLinkToEmail(h.clientAuth, OWNER, { url: 'https://example.com/finish', handleCodeInApp: true });
    const mail = authSandbox.takeAuthMail(getAuth(h.sandbox), OWNER);
    if (mail === null) throw new Error('No sign-in link was mailed');
    const result = await signInWithCredential(h.clientAuth, EmailAuthProvider.credentialWithLink(OWNER, mail.link));

    expect(result.user.email).toBe(OWNER);
    expect(result.providerId).toBeNull();
    expect(portSession(h.ctx, h.hostPort)?.user.uid).toBe(result.user.uid);
  });

  it('refuses a password credential that carries no secret, nested or flat', async () => {
    const h = harness();
    await h.createOwner();

    const nested = await h.sendRaw({ credential: { providerId: 'password', email: OWNER } });
    expect(nested).toMatchObject({ ok: false, error: { code: 'auth/invalid-credential' } });
    const flat = await h.sendRaw({ providerId: 'password', email: OWNER });
    expect(flat).toMatchObject({ ok: false, error: { code: 'auth/invalid-credential' } });
    const noPassword = await h.sendRaw({ credential: { providerId: 'password', signInMethod: 'password', email: OWNER } });
    expect(noPassword).toMatchObject({ ok: false, error: { code: 'auth/missing-password' } });

    expect(portSession(h.ctx, h.rawPort)).toBeNull();
  });
});

describe('served signInWithCredential with a provider id that is not federated (#1466)', () => {
  function ownerProviderIds(h: ReturnType<typeof harness>, uid: string): string[] {
    const owner = authSandbox.listUsers(getAuth(h.sandbox)).find((user) => user.uid === uid);
    return owner?.providerUserInfo.map((entry) => entry.providerId) ?? [];
  }

  function refusedPayloads(uid: string): Record<string, CredentialPayload> {
    return {
      capitalPassword: { providerId: 'Password', signInMethod: 'password', email: OWNER, password: 'wrong' },
      trailingSpacePassword: { providerId: 'password ', signInMethod: 'password', email: OWNER, password: 'wrong' },
      emailLink: { providerId: 'emailLink', email: OWNER },
      phone: { providerId: 'phone', uid },
      anonymous: { providerId: 'anonymous', uid },
      firebase: { providerId: 'firebase', uid },
      madeUp: { providerId: 'acme', email: OWNER },
      emptyOidc: { providerId: 'oidc.', email: OWNER },
      googleWithPasswordMethod: { providerId: 'google.com', signInMethod: 'password', email: OWNER, password: 'wrong' },
    };
  }

  function thrownCode(run: () => unknown): string {
    try {
      run();
    } catch (error) {
      return (error as { code?: string }).code ?? String(error);
    }
    return 'signed-in';
  }

  it('refuses each look-alike and unknown id with auth/no-mock-configured and leaves the owner untouched', async () => {
    const h = harness();
    const uid = await h.createOwner();
    const before = h.userCount();
    const auth = getAuth(h.sandbox);

    for (const [name, payload] of Object.entries(refusedPayloads(uid))) {
      const code = thrownCode(() => signInWithCredentialPayload(auth, payload, { tenantId: null }, nothingStaged));
      expect({ name, code }).toEqual({ name, code: 'auth/no-mock-configured' });
    }

    expect(ownerProviderIds(h, uid)).toEqual(['password']);
    expect(h.userCount()).toBe(before);
  });

  it('checks a disabled provider first, as in-page does, and refuses it with auth/operation-not-allowed', async () => {
    const h = harness();
    const uid = await h.createOwner();
    const auth = getAuth(h.sandbox);
    authSandbox.setAuthProviderConfig(auth, 'anonymous', false);
    authSandbox.setAuthProviderConfig(auth, 'phone', false);

    for (const providerId of ['anonymous', 'phone']) {
      const code = thrownCode(() => signInWithCredentialPayload(auth, { providerId, uid }, { tenantId: null }, nothingStaged));
      expect({ providerId, code }).toEqual({ providerId, code: 'auth/operation-not-allowed' });
    }

    expect(ownerProviderIds(h, uid)).toEqual(['password']);
  });

  it('refuses a look-alike over the wire, nested or flat, and binds no session', async () => {
    const h = harness();
    const uid = await h.createOwner();

    const nested = await h.sendRaw({ credential: { providerId: 'Password', email: OWNER } });
    expect(nested).toMatchObject({ ok: false, error: { code: 'auth/no-mock-configured' } });
    const flat = await h.sendRaw({ providerId: 'phone', uid });
    expect(flat).toMatchObject({ ok: false, error: { code: 'auth/no-mock-configured' } });

    expect(portSession(h.ctx, h.rawPort)).toBeNull();
    expect(ownerProviderIds(h, uid)).toEqual(['password']);
  });

});

describe('served signInWithCredential with a federated credential needs a staged result (#1466)', () => {
  function stagedIdentity(uid: string, providerId = 'google.com'): ResolvedIdentity {
    return { uid, providerId, email: 'staged@example.com', displayName: null, photoURL: null, customClaims: {} };
  }

  function thrownCode(run: () => unknown): string {
    try {
      run();
    } catch (error) {
      return (error as { code?: string }).code ?? String(error);
    }
    return 'signed-in';
  }

  it('refuses a google.com and an oidc.acme credential with nothing staged, and creates no user', async () => {
    const h = harness();
    await h.createOwner();
    const before = h.userCount();
    const auth = getAuth(h.sandbox);

    for (const payload of [
      { providerId: 'google.com', idToken: 'token-1' },
      { providerId: 'google.com', email: OWNER },
      { providerId: 'oidc.acme', email: 'o@example.com' },
    ]) {
      const code = thrownCode(() => signInWithCredentialPayload(auth, payload, { tenantId: null }, nothingStaged));
      expect({ payload, code }).toEqual({ payload, code: 'auth/no-mock-configured' });
    }
    expect(h.userCount()).toBe(before);
  });

  it('signs in as the staged identity, not the uid or email the payload asserts', async () => {
    const h = harness();
    const ownerUid = await h.createOwner();
    const auth = getAuth(h.sandbox);

    const result = signInWithCredentialPayload(
      auth,
      { providerId: 'google.com', uid: ownerUid, email: OWNER },
      { tenantId: null },
      (providerId) => (providerId === 'google.com' ? stagedIdentity('staged-uid') : null),
    );

    expect(result.providerId).toBe('google.com');
    expect(result.session.user.uid).toBe('staged-uid');
    expect(result.session.user.email).toBe('staged@example.com');
  });

  it('refuses a staged result with an empty uid instead of falling back to its email', async () => {
    const h = harness();
    await h.createOwner();
    const auth = getAuth(h.sandbox);
    const emptyUid = { ...stagedIdentity(''), email: OWNER };

    const code = thrownCode(() => signInWithCredentialPayload(auth, { providerId: 'google.com' }, { tenantId: null }, () => emptyUid));

    expect(code).toBe('auth/no-mock-configured');
  });

  it('over the wire, a result the client staged signs in once, on the port that staged it', async () => {
    const h = harness();
    await h.createOwner();
    const google = GoogleAuthProvider.credential('any-token');

    stageSignInResult(h.clientAuth, { user: { uid: 'staged-uid', email: 'staged@example.com' }, providerId: 'google.com' });
    const signedIn = await signInWithCredential(h.clientAuth, google);
    expect(signedIn.user.uid).toBe('staged-uid');
    expect(signedIn.providerId).toBe('google.com');
    await signOut(h.clientAuth);

    expect(await refusal(signInWithCredential(h.clientAuth, google))).toBe('auth/no-mock-configured');
  });

  it('refuses a profile field the host would refuse at the call, not as an unhandled rejection', async () => {
    const h = harness();
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', record);
    try {
      for (const user of [{ uid: 'u1', email: 42 }, { uid: 'u1', displayName: {} }, { uid: 'u1', photoURL: 7 }]) {
        const result = { user, providerId: 'google.com' } as unknown as Parameters<typeof stageSignInResult>[1];
        expect(() => stageSignInResult(h.clientAuth, result)).toThrow('strings or null');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', record);
    }
    expect(unhandled).toEqual([]);
  });

  it('drops an error reply to a staged result instead of leaving an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    let port!: ClientPort;
    port = {
      onmessage: null,
      postMessage(message: InboundMessage) {
        const isOp = message.t === 'op';
        if (!isOp) return;
        const refusal = { t: 'res', id: message.id, ok: false, error: { code: 'invalid-argument', message: 'refused' } };
        queueMicrotask(() => port.onmessage?.({ data: refusal } as MessageEvent<OutboundMessage>));
      },
      start() {},
    };
    wirePort(port);
    const refusingAuth = getClientAuth({ __kind: 'client-db', port } as ClientDb);
    process.on('unhandledRejection', record);
    try {
      stageSignInResult(refusingAuth, { user: { uid: 'u1' }, providerId: 'google.com' });
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', record);
    }
    expect(unhandled).toEqual([]);
  });

  it('refuses to stage a result with an empty uid or provider at the call', () => {
    const h = harness();
    expect(() => stageSignInResult(h.clientAuth, { user: { uid: '' }, providerId: 'google.com' })).toThrow('non-empty');
    expect(() => stageSignInResult(h.clientAuth, { user: { uid: 'u' }, providerId: null })).toThrow('non-empty');
  });
});
