import { afterEach, describe, expect, it } from 'bun:test';
import { randomUuid } from '../../../src/sandbox/internal/random-uuid.js';
import { createTenantEmailPasswordAccount, upsertTenantEmailLinkAccount } from '../../../src/auth/sandbox/tenant-isolation.js';
import { MessagingBroker } from '../../../src/messaging/broker/broker.js';
import { getAuth, signInAnonymously } from 'pyric/auth';
import { initializeSandbox } from 'pyric/sandbox';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

function withCryptoOverride(value: unknown, fn: () => Promise<void> | void): Promise<void> | void {
  Object.defineProperty(globalThis, 'crypto', {
    value,
    configurable: true,
    writable: true,
  });
  const restore = () => {
    if (originalCryptoDescriptor !== undefined) {
      Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor);
    }
  };
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

afterEach(() => {
  if (originalCryptoDescriptor !== undefined) {
    Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor);
  }
});

describe('randomUuid (secure and non-secure context fallback)', () => {
  it('returns an RFC 4122 v4 UUID using crypto.randomUUID when available', () => {
    const id = randomUuid();
    expect(id).toMatch(UUID_V4_RE);
  });

  it('falls back to crypto.getRandomValues when crypto.randomUUID is unavailable', async () => {
    const realCrypto = globalThis.crypto;
    const insecureCrypto = {
      getRandomValues: <T extends ArrayBufferView | null>(array: T): T => realCrypto.getRandomValues(array),
      randomUUID: undefined,
    };

    await withCryptoOverride(insecureCrypto, async () => {
      const seen = new Set<string>();
      for (let i = 0; i < 64; i += 1) {
        const value = randomUuid();
        expect(value).toMatch(UUID_V4_RE);
        seen.add(value);
      }
      expect(seen.size).toBe(64);

      // Auth anonymous sign-in and tenant account creation stay functional.
      const sandbox = initializeSandbox();
      const auth = getAuth(sandbox);
      const anon = await signInAnonymously(auth);
      expect(anon.user.uid).toMatch(/^anonymous-[0-9a-f-]{36}$/);

      const usersByEmail = new Map();
      const usersByUid = new Map();
      const created = createTenantEmailPasswordAccount({
        usersByEmail,
        usersByUid,
        email: 'dev@example.com',
        password: 'password-123',
        tenantId: 'tenant-a',
        buildAccount: (fields) => ({
          uid: fields.uid,
          email: fields.email,
          emailVerified: false,
          password: fields.password,
          tenantId: fields.tenantId,
          isAnonymous: false,
          providerUserInfo: fields.providerUserInfo,
        }),
      });
      expect(created.uid).toMatch(/^email-[0-9a-f-]{36}$/);

      const linked = upsertTenantEmailLinkAccount({
        usersByEmail,
        usersByUid,
        email: 'link@example.com',
        tenantId: 'tenant-a',
        buildAccount: (fields) => ({
          uid: fields.uid,
          email: fields.email,
          emailVerified: false,
          password: null,
          tenantId: fields.tenantId,
          isAnonymous: false,
          providerUserInfo: fields.providerUserInfo,
        }),
      });
      expect(linked.stored.uid).toMatch(/^email-[0-9a-f-]{36}$/);

      // Messaging broker send and direct delivery generate valid message IDs.
      const broker = new MessagingBroker();
      const delivered = broker.deliver({ data: { ping: '1' } });
      expect(delivered.payload.messageId).toMatch(UUID_V4_RE);
      const mintedToken = broker.getTokenFor('demo-scope');
      const sent = broker.send({ token: mintedToken, data: { ok: 'true' } }, 'demo-project');
      expect(sent.messageId).toMatch(UUID_V4_RE);
    });
  });

  it('fails closed instead of falling back to Math.random when Web Crypto is missing', () => {
    withCryptoOverride(undefined, () => {
      expect(() => randomUuid()).toThrow('Web Crypto API is unavailable');
    });
  });
});
