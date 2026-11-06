/**
 * ID token lifetime on the worker plane (#1836): a port's token lasts one
 * hour, and a read past `exp * 1000 - 30000` on the sandbox clock returns a
 * new token, updates the port session rules read, and fires the port's
 * `onIdTokenChanged` subscription. The in-page twin is
 * `packages/pyric/test/auth/sandbox-token-lifetime.test.ts`.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { checkIdToken, getClock } from 'pyric/sandbox/internal';
import { cleanupPort, handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import { portSession } from '../../../src/serve/worker/host-auth.js';
import type { OpMessage, OutboundMessage, ResMessage } from '../../../src/serve/worker/protocol.js';

const SIXTY_ONE_MINUTES_MS = 61 * 60 * 1000;

/** Allows an RTDB write only while the session's token is unexpired. */
const FRESH_DATABASE_RULES = { rules: { fresh: { '.write': 'auth != null && auth.token.exp * 1000 > now' } } };

function portHost(label: string) {
  const sandbox = initializeSandbox();
  getClock(sandbox).set(Date.UTC(2026, 0, 1));
  const context: HostCtx = { sandbox, db: getFirestore(sandbox), instanceId: `lifetime-${label}`, subs: new Map(), flushPersistence: async () => {} };
  const messages: OutboundMessage[] = [];
  const port: PortLike = { postMessage: (message) => messages.push(message) };
  let seq = 0;
  async function send(message: Record<string, unknown>): Promise<ResMessage> {
    const id = `${label}-${++seq}`;
    await handleMessage(context, port, { ...message, t: 'op', id } as OpMessage);
    const response = messages.findLast((entry): entry is ResMessage => entry.t === 'res' && entry.id === id);
    if (response === undefined) throw new Error('No response from host');
    return response;
  }
  return { sandbox, context, port, messages, send };
}

async function claimsOf(token: unknown): Promise<Record<string, unknown>> {
  const check = await checkIdToken(String(token));
  if (!check.ok) throw new Error(`token did not check: ${check.reason}`);
  return check.claims;
}

function snapsFor(messages: OutboundMessage[], subId: string): number {
  return messages.filter((m) => m.t === 'snap' && (m as { subId?: string }).subId === subId).length;
}

describe('worker port ID tokens last one hour and refresh on read', () => {
  it('auth.getIdToken past the refresh point returns a new token and updates the port session', async () => {
    const { sandbox, context, port, messages, send } = portHost('get-id-token');
    try {
      authSandbox.createUser(getAuth(sandbox), { email: 'ada@example.com', password: 'secret-pw' });
      expect(await send({ method: 'auth.signInEmail', email: 'ada@example.com', password: 'secret-pw' })).toMatchObject({ ok: true });
      const first = await send({ method: 'auth.getIdToken' });
      const firstClaims = await claimsOf((first as { value?: unknown }).value);
      expect((firstClaims.exp as number) - (firstClaims.iat as number)).toBe(3600);

      expect(await send({ method: 'setDatabaseRules', source: FRESH_DATABASE_RULES })).toMatchObject({ ok: true });
      expect(await send({ method: 'rtdb.set', path: '/fresh/before', value: 1 })).toMatchObject({ ok: true });

      await handleMessage(context, port, { t: 'sub', subId: 'id-token', target: 'idToken' });
      await handleMessage(context, port, { t: 'sub', subId: 'auth-state', target: 'authState' });
      const idTokenSnaps = snapsFor(messages, 'id-token');
      const authStateSnaps = snapsFor(messages, 'auth-state');

      getClock(sandbox).advance(SIXTY_ONE_MINUTES_MS);
      const before = getClock(sandbox).now();
      const second = await send({ method: 'auth.getIdToken' });
      const after = getClock(sandbox).now();
      const token = (second as { value?: unknown }).value;
      expect(token).not.toBe((first as { value?: unknown }).value);
      const claims = await claimsOf(token);
      expect(claims.iat).toBeGreaterThanOrEqual(Math.floor(before / 1000));
      expect(claims.iat).toBeLessThanOrEqual(Math.floor(after / 1000));
      expect(portSession(context, port)?.state.token?.iat).toBe(claims.iat);
      expect(snapsFor(messages, 'id-token')).toBe(idTokenSnaps + 1);
      expect(snapsFor(messages, 'auth-state')).toBe(authStateSnaps);
      expect(await send({ method: 'rtdb.set', path: '/fresh/after', value: 1 })).toMatchObject({ ok: true });

      const third = await send({ method: 'auth.getIdToken' });
      expect((third as { value?: unknown }).value).toBe(token);
      expect(snapsFor(messages, 'id-token')).toBe(idTokenSnaps + 1);
    } finally { await cleanupPort(context, port); }
  });

  it('auth.getIdTokenResult past the refresh point reports the new token and lifetime', async () => {
    const { sandbox, context, port, send } = portHost('get-id-token-result');
    try {
      authSandbox.createUser(getAuth(sandbox), { email: 'ada@example.com', password: 'secret-pw' });
      await send({ method: 'auth.signInEmail', email: 'ada@example.com', password: 'secret-pw' });
      const before = (await send({ method: 'auth.getIdTokenResult' })) as { value?: { token: string; issuedAtTime: string } };
      getClock(sandbox).advance(SIXTY_ONE_MINUTES_MS);
      const after = (await send({ method: 'auth.getIdTokenResult' })) as { value?: { token: string; issuedAtTime: string; expirationTime: string } };
      expect(after.value?.token).not.toBe(before.value?.token);
      expect(Date.parse(after.value?.issuedAtTime ?? '')).toBe(getClock(sandbox).now());
      expect(Date.parse(after.value?.expirationTime ?? '') - Date.parse(after.value?.issuedAtTime ?? '')).toBe(60 * 60 * 1000);
      const claims = await claimsOf(after.value?.token);
      expect(portSession(context, port)?.state.token?.iat).toBe(claims.iat);
    } finally { await cleanupPort(context, port); }
  });
});
