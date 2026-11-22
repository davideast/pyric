/**
 * Served worker and bridge regressions for staged sign-in profile preservation
 * and disabled-user ordering (#1517), absolute avatar photoURL resolution in
 * providerData/snapshots/events/native bridge frames (#1244, #581), and
 * verified vs unverified @gmail.com Google account linking (#1814).
 */
import { describe, expect, it } from 'bun:test';
import {
  SandboxError,
  initializeSandbox,
  type SandboxEvent,
  type ServiceMutationEvent,
} from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import {
  GoogleAuthProvider,
  getAuth,
  sandbox as authSandbox,
  type Auth,
} from 'pyric/auth';
import { SERVED_SANDBOX_HOOK, setAuthBlockingHooks } from 'pyric/auth/internal';
import { servedAvatarMint } from '../../../src/serve/assets/avatar-url.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
  ResMessage,
  SerializedIdTokenResult,
  SerializedUser,
  SerializedUserCredential,
  SnapMessage,
} from '../../../src/serve/worker/protocol.js';
import { wirePort } from '../../../src/serve/worker/client/core.js';
import {
  acceptProviderCredential,
  createUserWithEmailAndPassword,
  getAuth as getClientAuth,
  onAuthStateChanged,
  onIdTokenChanged,
  signInWithCredential,
  stageSignInResult,
  updateEmail,
  updateProfile,
  type ClientDb,
  type ClientPort,
} from '../../../src/serve/worker/client.js';

const ORIGIN = 'http://localhost:5173';

function createWorkerHarness(options?: { withOrigin?: boolean }) {
  const sandbox = initializeSandbox();
  const inPageAuth = getAuth(sandbox);
  authSandbox.setAuthProviderConfig(inPageAuth, 'google.com', true);
  authSandbox.setAvatarMint(inPageAuth, servedAvatarMint);

  const ctx: HostCtx = {
    db: getFirestore(sandbox),
    sandbox,
    subs: new Map(),
    sessionMode: 'LOCAL',
  };

  let clientPortRef: ClientPort | null = null;
  const hostPort: PortLike = {
    postMessage(msg: OutboundMessage) {
      if (clientPortRef !== null && clientPortRef.onmessage !== null) {
        clientPortRef.onmessage({ data: msg } as MessageEvent<OutboundMessage>);
      }
    },
  };
  const clientPort: ClientPort = {
    onmessage: null,
    postMessage(msg: InboundMessage) {
      void handleMessage(ctx, hostPort, msg);
    },
    start() {},
  };
  clientPortRef = clientPort;
  wirePort(clientPort);

  if (options?.withOrigin !== false) {
    void handleMessage(ctx, hostPort, {
      t: 'appConfig',
      origin: ORIGIN,
      options: { projectId: 'demo-pyric' },
    });
  }

  const clientDb: ClientDb = { __kind: 'client-db', port: clientPort };
  const clientAuth = getClientAuth(clientDb);
  return { sandbox, inPageAuth, ctx, hostPort, clientPort, clientAuth };
}

function createRawNativePort(ctx: HostCtx) {
  const replies: OutboundMessage[] = [];
  const port: PortLike = {
    postMessage(msg: OutboundMessage) {
      replies.push(msg);
    },
  };
  async function sendOp(op: Record<string, unknown>): Promise<ResMessage> {
    const id = `op-${replies.length + 1}`;
    await handleMessage(ctx, port, { t: 'op', id, ...op } as InboundMessage);
    const found = replies.find((m): m is ResMessage => m.t === 'res' && m.id === id);
    if (found === undefined) {
      throw new Error(`Missing response for ${id}`);
    }
    return found;
  }
  return { port, replies, sendOp };
}

describe('served staged sign-in parity (#1517)', () => {
  it('throws SandboxError(invalid-argument) on empty or whitespace uid across served and in-page handles', () => {
    const { inPageAuth, clientAuth } = createWorkerHarness();
    const servedAuth = Object.assign({}, clientAuth) as unknown as Auth;
    Object.defineProperty(servedAuth, SERVED_SANDBOX_HOOK, {
      value: { mockSignInResult: (res: Parameters<typeof stageSignInResult>[1]) => stageSignInResult(clientAuth, res) },
    });

    for (const handle of [inPageAuth, servedAuth]) {
      for (const badUid of ['', '   ']) {
        let caught: unknown;
        try {
          authSandbox.mockSignInResult(handle, {
            user: {
              uid: badUid,
              email: 'x@example.com',
              displayName: null,
              isAnonymous: false,
              getIdToken: async () => 't',
              getIdTokenResult: async () => ({
                token: 't',
                claims: {},
                expirationTime: '',
                issuedAtTime: '',
                authTime: '',
              }),
            },
            providerId: 'google.com',
            operationType: 'signIn',
          });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(SandboxError);
        expect((caught as SandboxError).code).toBe('invalid-argument');
      }
    }
  });

  it('links provider on served staged sign-in without overwriting existing stored email, displayName, or photoUrl', async () => {
    for (const withBlocking of [false, true]) {
      const { inPageAuth, clientAuth } = createWorkerHarness();
      if (withBlocking) {
        setAuthBlockingHooks(inPageAuth, {
          beforeSignIn: async () => ({}),
        });
      }
      const owner = await createUserWithEmailAndPassword(
        clientAuth,
        'original@example.com',
        'secret123',
      );
      await updateProfile(owner.user, {
        displayName: 'Original Name',
        photoURL: 'https://cdn.example.com/original.png',
      });
      await createUserWithEmailAndPassword(clientAuth, 'taken@example.com', 'secret123');

      stageSignInResult(clientAuth, {
        user: {
          uid: owner.user.uid,
          email: 'taken@example.com',
          displayName: 'Overwritten Name',
          photoURL: 'https://cdn.example.com/overwritten.png',
        },
        providerId: 'google.com',
      });

      const cred = await signInWithCredential(
        clientAuth,
        GoogleAuthProvider.credential('staged-token'),
      );
      expect(cred.user.uid).toBe(owner.user.uid);
      expect(cred.user.email).toBe('original@example.com');
      expect(cred.user.displayName).toBe('Original Name');
      expect(cred.user.photoURL).toBe('https://cdn.example.com/original.png');

      const stored = authSandbox.listUsers(inPageAuth).find((u) => u.uid === owner.user.uid);
      expect(stored?.email).toBe('original@example.com');
      expect(stored?.displayName).toBe('Original Name');
      expect(stored?.photoUrl).toBe('https://cdn.example.com/original.png');
      expect(stored?.providerUserInfo.map((p) => p.providerId)).toEqual(['password', 'google.com']);
    }
  });

  it('refuses a disabled user with auth/user-disabled before linking provider or mutating profile', async () => {
    const { inPageAuth, clientAuth } = createWorkerHarness();
    const record = authSandbox.createUser(inPageAuth, {
      uid: 'disabled-victim',
      email: 'disabled@example.com',
      password: 'secret-password-123',
      displayName: 'Keep Me',
      disabled: true,
    });
    expect(record.disabled).toBe(true);

    stageSignInResult(clientAuth, {
      user: {
        uid: 'disabled-victim',
        email: 'changed@example.com',
        displayName: 'Mutated',
      },
      providerId: 'google.com',
    });

    let errCode: string | undefined;
    try {
      await signInWithCredential(clientAuth, GoogleAuthProvider.credential('staged-token'));
    } catch (err) {
      errCode = (err as { code?: string }).code;
    }
    expect(errCode).toBe('auth/user-disabled');

    const after = authSandbox.listUsers(inPageAuth).find((u) => u.uid === 'disabled-victim');
    expect(after?.email).toBe('disabled@example.com');
    expect(after?.displayName).toBe('Keep Me');
    expect(after?.providerUserInfo.map((p) => p.providerId)).toEqual(['password']);
  });
});

describe('served avatar photoURL across providerData, snapshots, events, and native wire (#1244, #581)', () => {
  it('resolves providerData[].photoURL, listener snapshots, events, and native bridge wire frames while keeping exportUsers relative', async () => {
    const prevLocation = (globalThis as { location?: unknown }).location;
    (globalThis as { location?: unknown }).location = new URL(`${ORIGIN}/`);
    try {
      const { sandbox, inPageAuth, ctx, clientAuth } = createWorkerHarness();
      const events: SandboxEvent[] = [];
      const unsubEvents = sandbox.onEvent((event) => events.push(event));

      const authSnapshots: Array<SerializedUser | null> = [];
      const tokenSnapshots: Array<SerializedUser | null> = [];
      const unsubAuth = onAuthStateChanged(clientAuth, (u) => {
        authSnapshots.push(u as unknown as SerializedUser | null);
      });
      const unsubToken = onIdTokenChanged(clientAuth, (u) => {
        tokenSnapshots.push(u as unknown as SerializedUser | null);
      });

      const cred = await acceptProviderCredential(clientAuth, {
        uid: 'ada-federated',
        email: 'ada@example.com',
        displayName: 'Ada',
        photoURL: null,
        customClaims: {},
        providerId: 'google.com',
      });
      await new Promise((r) => setTimeout(r, 20));

      expect(cred.user.photoURL).toStartWith(`${ORIGIN}/__pyric/assets/avatar/ada-federated?`);
      expect(cred.user.providerData[0]?.photoURL).toBe(cred.user.photoURL);
      expect(authSnapshots.at(-1)?.photoURL).toBe(cred.user.photoURL);
      expect(authSnapshots.at(-1)?.providerData[0]?.photoURL).toBe(cred.user.photoURL);
      expect(tokenSnapshots.at(-1)?.providerData[0]?.photoURL).toBe(cred.user.photoURL);

      await updateEmail(cred.user, 'ada2@example.com');
      expect(cred.user.providerData[0]?.photoURL).toBe(cred.user.photoURL);

      // Native bridge client (no appConfig.origin on its port, and location unset in Node) receives absolute URLs (#581).
      (globalThis as { location?: unknown }).location = undefined;
      const native = createRawNativePort(ctx);
      await handleMessage(ctx, native.port, { t: 'sub', subId: 'native-auth', target: 'authState' });
      const restoreRes = await native.sendOp({
        method: 'auth.restorePortSession',
        uid: 'ada-federated',
      });
      expect(restoreRes.ok).toBe(true);
      const nativeUser = (restoreRes as { ok: true; value: SerializedUser | null }).value;
      expect(nativeUser?.photoURL).toBe(cred.user.photoURL);
      expect(nativeUser?.providerData[0]?.photoURL).toBe(cred.user.photoURL);

      const nativeSnaps = native.replies.filter(
        (m): m is SnapMessage => m.t === 'snap' && m.subId === 'native-auth' && m.value !== null,
      );
      const lastNativeSnap = nativeSnaps.at(-1)?.value as SerializedUser | undefined;
      expect(lastNativeSnap?.photoURL).toBe(cred.user.photoURL);
      expect(lastNativeSnap?.providerData[0]?.photoURL).toBe(cred.user.photoURL);

      const tokenRes = await native.sendOp({ method: 'auth.getIdTokenResult', forceRefresh: false });
      const wireToken = (tokenRes as { ok: true; value: SerializedIdTokenResult }).value;
      expect(wireToken.claims.picture).toBe(cred.user.photoURL);

      const createEv = events.find(
        (e): e is ServiceMutationEvent =>
          'service' in e && e.service === 'auth' && e.op === 'user_create',
      );
      expect((createEv?.after as { photoUrl?: string } | null)?.photoUrl).toBe(cred.user.photoURL);

      // Persisted state export remains root-relative.
      const exported = authSandbox.exportUsers(inPageAuth).find((u) => u.uid === 'ada-federated');
      expect(exported?.photoUrl).toStartWith('/__pyric/assets/avatar/ada-federated?');

      unsubAuth();
      unsubToken();
      unsubEvents();
    } finally {
      (globalThis as { location?: unknown }).location = prevLocation;
    }
  });
});

describe('served @gmail.com verified vs unverified linking (#1814)', () => {
  it('preserves a verified @gmail.com password on Google acceptIdentity while overwriting an unverified one', async () => {
    const { inPageAuth, ctx } = createWorkerHarness();
    const raw = createRawNativePort(ctx);

    // Verified @gmail.com account keeps its password.
    await raw.sendOp({
      method: 'auth.createUser',
      email: 'verified@gmail.com',
      password: 'password123',
    });
    const verifiedRecord = authSandbox
      .listUsers(inPageAuth)
      .find((u) => u.email === 'verified@gmail.com');
    expect(verifiedRecord).toBeDefined();
    authSandbox.updateUser(inPageAuth, verifiedRecord?.uid ?? '', { emailVerified: true });

    const acceptVerified = await raw.sendOp({
      method: 'auth.acceptIdentity',
      identity: {
        uid: verifiedRecord?.uid ?? '',
        email: 'verified@gmail.com',
        displayName: 'Verified Owner',
        photoURL: null,
        customClaims: {},
        providerId: 'google.com',
      },
    });
    expect(acceptVerified.ok).toBe(true);
    const verifiedCred = (acceptVerified as { ok: true; value: SerializedUserCredential }).value;
    expect(verifiedCred.user.providerData.map((p) => p.providerId)).toEqual([
      'password',
      'google.com',
    ]);

    const pwStillWorks = await raw.sendOp({
      method: 'auth.signInEmail',
      email: 'verified@gmail.com',
      password: 'password123',
    });
    expect(pwStillWorks.ok).toBe(true);
  });
});
