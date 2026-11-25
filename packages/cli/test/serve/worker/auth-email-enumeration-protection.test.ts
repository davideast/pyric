import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createAppForSandbox } from 'pyric/app/internal';
import * as ipAuth from 'pyric/auth';
import { setAuthBlockingHooks } from 'pyric/auth/internal';
import {
  getEmailEnumerationProtection,
  setEmailEnumerationProtection,
  type ClientAuth,
} from '../../../src/serve/worker/client.js';
import { handleMessage, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import { type FakePort, makeHostCtx, portPair, sleep } from './integration-support.js';

let appCounter = 0;
function nextAppName(tag: string): string {
  appCounter += 1;
  return `eep-worker-${tag}-${appCounter}`;
}

async function expectRejectedCode(promise: Promise<unknown>, expectedCode: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect((err as { code?: string }).code).toBe(expectedCode);
    return;
  }
  throw new Error(`Expected ${expectedCode} rejection`);
}

describe('SharedWorker Auth emailEnumerationProtection parity (#1689)', () => {
  let restoreSharedWorker: () => void;

  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSharedWorker = () => {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = previous;
    };
  });

  afterEach(() => {
    restoreSharedWorker();
  });

  async function setupServedAuth() {
    const ctx = await makeHostCtx();
    ctx.appOptions = { projectId: 'demo-served-eep' };
    (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
      port: FakePort;
      addEventListener() {}
      constructor(_url: unknown, _opts: unknown) {
        const { a: clientPort, b: hostPort } = portPair();
        const hostPortLike: PortLike = {
          postMessage: (message: OutboundMessage) => hostPort.postMessage(message),
        };
        hostPort.onmessage = (event) => {
          void handleMessage(ctx, hostPortLike, event.data as InboundMessage);
        };
        this.port = clientPort;
      }
    };
    const servedAuth = await import('../../../src/serve/entries/auth.js');
    const app = createAppForSandbox(ctx.sandbox, { projectId: 'demo-served-eep' }, nextAppName('app'));
    const auth = servedAuth.getAuth(app);
    return { ctx, servedAuth, app, auth };
  }

  it('defaults to true and toggles sign-in, credential, reauth, and password-reset behavior over the worker', async () => {
    const { ctx, servedAuth, auth } = await setupServedAuth();
    const clientAuth = auth as unknown as ClientAuth;

    expect(await getEmailEnumerationProtection(clientAuth)).toBe(true);
    await servedAuth.createUserWithEmailAndPassword(auth, 'member@example.com', 'correct-pw-123');
    await servedAuth.createUserWithEmailAndPassword(auth, 'other@example.com', 'correct-pw-123');
    await servedAuth.signOut(auth);

    // Default protection on: auth/invalid-credential and silent sendPasswordResetEmail.
    await expectRejectedCode(
      servedAuth.signInWithEmailAndPassword(auth, 'unknown@example.com', 'correct-pw-123'),
      'auth/invalid-credential',
    );
    await expectRejectedCode(
      servedAuth.signInWithEmailAndPassword(auth, 'member@example.com', 'wrong-pw-999'),
      'auth/invalid-credential',
    );
    await expectRejectedCode(
      servedAuth.signInWithCredential(auth, servedAuth.EmailAuthProvider.credential('unknown@example.com', 'correct-pw-123')),
      'auth/invalid-credential',
    );
    await expectRejectedCode(
      servedAuth.signInWithCredential(auth, servedAuth.EmailAuthProvider.credential('member@example.com', 'wrong-pw-999')),
      'auth/invalid-credential',
    );
    await expect(servedAuth.sendPasswordResetEmail(auth, 'unknown@example.com')).resolves.toBeUndefined();

    // Disable via worker RPC and verify protection-off codes across all surfaces.
    await setEmailEnumerationProtection(clientAuth, false);
    expect(await getEmailEnumerationProtection(clientAuth)).toBe(false);
    expect(ipAuth.sandbox.getEmailEnumerationProtection(ipAuth.getAuth(ctx.sandbox))).toBe(false);

    await expectRejectedCode(
      servedAuth.signInWithEmailAndPassword(auth, 'unknown@example.com', 'correct-pw-123'),
      'auth/user-not-found',
    );
    await expectRejectedCode(
      servedAuth.signInWithEmailAndPassword(auth, 'member@example.com', 'wrong-pw-999'),
      'auth/wrong-password',
    );
    await expectRejectedCode(
      servedAuth.signInWithCredential(auth, servedAuth.EmailAuthProvider.credential('unknown@example.com', 'correct-pw-123')),
      'auth/user-not-found',
    );
    await expectRejectedCode(
      servedAuth.signInWithCredential(auth, servedAuth.EmailAuthProvider.credential('member@example.com', 'wrong-pw-999')),
      'auth/wrong-password',
    );
    await expectRejectedCode(
      servedAuth.sendPasswordResetEmail(auth, 'unknown@example.com'),
      'auth/user-not-found',
    );

    const signedIn = await servedAuth.signInWithEmailAndPassword(auth, 'member@example.com', 'correct-pw-123');
    await expectRejectedCode(
      servedAuth.reauthenticateWithCredential(
        signedIn.user,
        servedAuth.EmailAuthProvider.credential('other@example.com', 'wrong-pw-999'),
      ),
      'auth/user-mismatch',
    );
    await expectRejectedCode(
      servedAuth.reauthenticateWithCredential(
        signedIn.user,
        servedAuth.EmailAuthProvider.credential('member@example.com', 'wrong-pw-999'),
      ),
      'auth/wrong-password',
    );

    // ServedSandboxHook forwards pyric/auth sandbox.setEmailEnumerationProtection(servedAuth, true) over the worker.
    ipAuth.sandbox.setEmailEnumerationProtection(auth, true);
    await sleep(20);
    expect(await getEmailEnumerationProtection(clientAuth)).toBe(true);
    await expectRejectedCode(
      servedAuth.reauthenticateWithCredential(
        signedIn.user,
        servedAuth.EmailAuthProvider.credential('member@example.com', 'wrong-pw-999'),
      ),
      'auth/invalid-credential',
    );
    ctx.sandbox.dispose();
  });

  it('honors protection-off codes over the worker when beforeSignIn blocking hooks are active', async () => {
    const { ctx, servedAuth, auth } = await setupServedAuth();
    const hostAuth = ipAuth.getAuth(ctx.sandbox);
    ipAuth.sandbox.seedUsers(hostAuth, [
      { uid: 'blocked-1', email: 'blocked@example.com', password: 'correct-password' },
    ]);
    setAuthBlockingHooks(hostAuth, {
      beforeSignIn: async () => ({}),
    });
    await setEmailEnumerationProtection(auth as unknown as ClientAuth, false);

    await expectRejectedCode(
      servedAuth.signInWithEmailAndPassword(auth, 'nobody@example.com', 'correct-password'),
      'auth/user-not-found',
    );
    await expectRejectedCode(
      servedAuth.signInWithEmailAndPassword(auth, 'blocked@example.com', 'wrong-password'),
      'auth/wrong-password',
    );
    await expectRejectedCode(
      servedAuth.signInWithCredential(auth, servedAuth.EmailAuthProvider.credential('nobody@example.com', 'correct-password')),
      'auth/user-not-found',
    );
    await expectRejectedCode(
      servedAuth.signInWithCredential(auth, servedAuth.EmailAuthProvider.credential('blocked@example.com', 'wrong-password')),
      'auth/wrong-password',
    );
    ctx.sandbox.dispose();
  });

  it('rejects non-boolean enabled payloads at inbound worker validation', async () => {
    const { ctx } = await setupServedAuth();
    const replies: OutboundMessage[] = [];
    const fakePort: PortLike = {
      postMessage(msg: OutboundMessage) {
        replies.push(msg);
      },
    };
    await handleMessage(ctx, fakePort, {
      t: 'op',
      id: 'bad-eep',
      method: 'auth.setEmailEnumerationProtection',
      enabled: 'no' as unknown as boolean,
    });
    expect(replies).toHaveLength(1);
    const first = replies[0];
    expect(first?.t).toBe('res');
    if (first?.t === 'res') {
      expect(first.ok).toBe(false);
      if (!first.ok) {
        expect(first.error.code).toBe('invalid-argument');
      }
    }
    ctx.sandbox.dispose();
  });
});
