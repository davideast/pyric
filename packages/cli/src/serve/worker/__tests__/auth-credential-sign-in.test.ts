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
import { EmailAuthProvider, getAuth, sandbox as authSandbox } from 'pyric/auth';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { handleMessage, type HostCtx, type PortLike } from '../host.js';
import { portSession } from '../host-auth.js';
import type { InboundMessage, OutboundMessage, ResMessage } from '../protocol.js';
import { wirePort } from '../client/core.js';
import type { ClientPort } from '../client/handles.js';
import {
  createUserWithEmailAndPassword,
  getAuth as getClientAuth,
  sendSignInLinkToEmail,
  signInWithCredential,
  signOut,
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
