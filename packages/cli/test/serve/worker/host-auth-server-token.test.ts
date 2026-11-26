import { describe, expect, it } from 'bun:test';
import { createUserWithEmailAndPassword, sandbox as authSandbox } from 'pyric/auth';
import { getFirestore } from 'pyric/firestore';
import { setRules } from 'pyric/sandbox/firestore';
import { getClock, initializeSandbox } from 'pyric/sandbox';
import {
  authAccountsFor,
  mintIdToken,
  signSandboxJwtSync,
} from 'pyric/sandbox/internal';
import {
  ensureAuth,
  handleMessage,
  portSession,
  type HostCtx,
  type PortLike,
} from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';

const ID_TOKEN_KEY = 'pyric-sandbox-id-token-signing-key';
const SANDBOX_JWT_KID = 'pyric-sandbox';
const PROJECT_ID = 'demo-server-session-host';

function makePort() {
  const replies: OutboundMessage[] = [];
  const port: PortLike = {
    postMessage(msg) {
      replies.push(msg);
    },
  };
  return { port, replies };
}

async function sendOp(
  ctx: HostCtx,
  port: PortLike,
  replies: OutboundMessage[],
  msg: InboundMessage & { id: string },
): Promise<Extract<OutboundMessage, { t: 'res' }>> {
  await handleMessage(ctx, port, msg);
  const found = replies.find((entry) => entry.t === 'res' && entry.id === msg.id);
  if (found === undefined || found.t !== 'res') {
    throw new Error(`Missing response for ${msg.id}`);
  }
  return found;
}

function makeClaims(
  uid: string,
  nowSec: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    aud: PROJECT_ID,
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    sub: uid,
    user_id: uid,
    auth_time: nowSec,
    iat: nowSec,
    exp: nowSec + 3600,
    firebase: { identities: {}, sign_in_provider: 'password' },
    ...overrides,
  };
}

describe('host auth.restorePortSession authIdToken verification', () => {
  it('verifies token claims, host clock, tenant, and revocation/disabled/deleted standing on the host', async () => {
    const sandbox = initializeSandbox();
    const clock = getClock(sandbox);
    const db = getFirestore(sandbox);
    setRules(
      sandbox,
      `
      rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /ssr/{uid} {
            allow read, write: if request.auth != null
              && request.auth.uid == uid
              && request.auth.token.ssrRole == 'editor'
              && request.auth.token.firebase.tenant == 'tenant-host';
          }
        }
      }
      `,
    );

    const ctx: HostCtx = {
      db,
      sandbox,
      instanceId: 'host-auth-token-test',
      appOptions: { projectId: PROJECT_ID },
      flushPersistence: async () => {},
    };
    const auth = ensureAuth(ctx);
    auth.tenantId = 'tenant-host';
    const cred = await createUserWithEmailAndPassword(auth, 'host@example.com', 'password123');
    const uid = cred.user.uid;
    const nowSec = Math.floor(clock.now() / 1000);

    const validClaims = makeClaims(uid, nowSec, {
      ssrRole: 'editor',
      firebase: {
        identities: { email: ['host@example.com'] },
        sign_in_provider: 'password',
        tenant: 'tenant-host',
      },
    });
    const validToken = mintIdToken(validClaims);

    // Valid token restores session with custom claims and tenant even when msg.uid is empty.
    const okPort = makePort();
    const okReply = await sendOp(ctx, okPort.port, okPort.replies, {
      t: 'op',
      id: 'op-ok',
      method: 'auth.restorePortSession',
      uid: '',
      authIdToken: validToken,
      expectedProjectId: PROJECT_ID,
    } as InboundMessage & { id: string });
    expect(okReply.ok).toBe(true);
    if (okReply.ok) {
      expect((okReply.value as { uid?: string } | null)?.uid).toBe(uid);
    }
    const activeSession = portSession(ctx, okPort.port);
    expect(activeSession?.state.tenant).toBe('tenant-host');
    expect(activeSession?.state.token?.ssrRole).toBe('editor');

    const writeOk = await sendOp(ctx, okPort.port, okPort.replies, {
      t: 'op',
      id: 'op-write-ok',
      method: 'setDoc',
      path: `ssr/${uid}`,
      data: { allowed: true },
    });
    expect(writeOk.ok).toBe(true);

    // Adversarial negative matrix on host side (must ignore client uid and clear any prior session).
    const adversarialCases: Array<[string, Record<string, unknown>]> = [
      ['empty authIdToken', { uid, authIdToken: '' }],
      ['non-string authIdToken', { uid, authIdToken: 123 }],
      ['wrong expectedProjectId vs host', { uid, authIdToken: validToken, expectedProjectId: 'other-project' }],
      ['empty expectedProjectId', { uid, authIdToken: validToken, expectedProjectId: '' }],
      [
        'alg=none',
        {
          uid,
          authIdToken: signSandboxJwtSync(
            ID_TOKEN_KEY,
            { alg: 'none', kid: SANDBOX_JWT_KID, typ: 'JWT' },
            validClaims,
          ),
        },
      ],
      [
        'missing kid',
        {
          uid,
          authIdToken: signSandboxJwtSync(ID_TOKEN_KEY, { alg: 'RS256', typ: 'JWT' }, validClaims),
        },
      ],
      ['wrong iss', { uid, authIdToken: mintIdToken({ ...validClaims, iss: 'https://evil.example/x' }) }],
      ['wrong aud', { uid, authIdToken: mintIdToken({ ...validClaims, aud: 'other-project' }) }],
      ['future nbf', { uid, authIdToken: mintIdToken({ ...validClaims, nbf: nowSec + 600 }) }],
      [
        'cross-tenant mismatch',
        {
          uid,
          authIdToken: mintIdToken({
            ...validClaims,
            firebase: { identities: {}, sign_in_provider: 'password', tenant: 'wrong-tenant' },
          }),
        },
      ],
      ['unknown uid', { uid: 'ghost-uid', authIdToken: mintIdToken(makeClaims('ghost-uid', nowSec)) }],
    ];

    let seq = 0;
    for (const [label, extra] of adversarialCases) {
      seq += 1;
      const reply = await sendOp(ctx, okPort.port, okPort.replies, {
        t: 'op',
        id: `op-neg-${seq}`,
        method: 'auth.restorePortSession',
        ...extra,
      } as InboundMessage & { id: string });
      expect(reply.ok, label).toBe(true);
      if (reply.ok) expect(reply.value, label).toBeNull();
      expect(portSession(ctx, okPort.port), label).toBeNull();
    }

    // Revocation check against auth_time (even if refreshed iat is newer).
    clock.advance(10_000);
    authAccountsFor(sandbox)?.revokeRefreshTokens(uid);
    const revokedRefreshed = mintIdToken({
      ...validClaims,
      auth_time: nowSec,
      iat: nowSec + 20,
      exp: nowSec + 3600,
    });
    const revReply = await sendOp(ctx, okPort.port, okPort.replies, {
      t: 'op',
      id: 'op-revoked',
      method: 'auth.restorePortSession',
      uid,
      authIdToken: revokedRefreshed,
      expectedProjectId: PROJECT_ID,
    } as InboundMessage & { id: string });
    expect(revReply.ok).toBe(true);
    if (revReply.ok) expect(revReply.value).toBeNull();
    expect(portSession(ctx, okPort.port)).toBeNull();

    // Re-authenticated token after revocation succeeds, then disabled/deleted/expired fail closed.
    const reauthedSec = Math.floor(clock.now() / 1000) + 1;
    const reauthedToken = mintIdToken({
      ...validClaims,
      auth_time: reauthedSec,
      iat: reauthedSec,
      exp: reauthedSec + 120,
    });
    const reauthedReply = await sendOp(ctx, okPort.port, okPort.replies, {
      t: 'op',
      id: 'op-reauthed',
      method: 'auth.restorePortSession',
      uid: '',
      authIdToken: reauthedToken,
      expectedProjectId: PROJECT_ID,
    } as InboundMessage & { id: string });
    expect(reauthedReply.ok).toBe(true);
    expect(portSession(ctx, okPort.port)?.user.uid).toBe(uid);

    // Disabled account fails closed.
    authSandbox.updateUser(auth, uid, { disabled: true });
    const disReply = await sendOp(ctx, okPort.port, okPort.replies, {
      t: 'op',
      id: 'op-disabled',
      method: 'auth.restorePortSession',
      uid,
      authIdToken: reauthedToken,
      expectedProjectId: PROJECT_ID,
    } as InboundMessage & { id: string });
    expect(disReply.ok).toBe(true);
    expect(portSession(ctx, okPort.port)).toBeNull();

    // Re-enable, advance host clock past exp -> fails closed on host clock.
    authSandbox.updateUser(auth, uid, { disabled: false });
    clock.advance(200_000);
    const expReply = await sendOp(ctx, okPort.port, okPort.replies, {
      t: 'op',
      id: 'op-expired-clock',
      method: 'auth.restorePortSession',
      uid,
      authIdToken: reauthedToken,
      expectedProjectId: PROJECT_ID,
    } as InboundMessage & { id: string });
    expect(expReply.ok).toBe(true);
    expect(portSession(ctx, okPort.port)).toBeNull();

    // Deleted account fails closed even with a newly minted token.
    const latestSec = Math.floor(clock.now() / 1000);
    const preDeleteToken = mintIdToken({
      ...validClaims,
      auth_time: latestSec,
      iat: latestSec,
      exp: latestSec + 3600,
    });
    authSandbox.deleteUser(auth, uid);
    const delReply = await sendOp(ctx, okPort.port, okPort.replies, {
      t: 'op',
      id: 'op-deleted',
      method: 'auth.restorePortSession',
      uid,
      authIdToken: preDeleteToken,
      expectedProjectId: PROJECT_ID,
    } as InboundMessage & { id: string });
    expect(delReply.ok).toBe(true);
    expect(portSession(ctx, okPort.port)).toBeNull();
  });
});
