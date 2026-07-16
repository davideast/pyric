/**
 * Provider-config persistence round-trip tests.
 *
 * Covers:
 *   - snapshot() includes `services.auth.providers` alongside `users`.
 *   - Round-trip: toggle providers, flush, fresh sandbox restore → same
 *     enablement, without re-toggling.
 *   - Legacy blobs (no `providers` key — written before this feature
 *     existed) restore to the documented defaults instead of an empty map.
 *   - `sandbox.reset()` does NOT clear provider config — same precedent as
 *     the user DB (`reset()` only clears the signed-in session).
 *   - `subscribeAuthProviderConfig` changes trigger a debounced flush,
 *     mirroring the user-DB auto-flush test.
 */
import { describe, expect, it } from 'bun:test';
import { createMemoryBackend, deserializeFromBuckets, initializeSandbox } from '../../src/sandbox/index.js';
import { getAuth, sandbox as authSandbox } from '../../src/auth/index.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('SandboxSnapshot.services.auth.providers', () => {
  it('includes the default provider config even with no explicit toggles', () => {
    const sandbox = initializeSandbox();
    getAuth(sandbox);
    const snap = sandbox.snapshot();
    const authSnap = snap.services.auth as { providers: Record<string, boolean> };
    expect(authSnap.providers).toEqual({ password: true, anonymous: true });
  });

  it('reflects toggles made via sandbox.setAuthProviderConfig', () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.setAuthProviderConfig(auth, 'google.com', false);
    authSandbox.setAuthProviderConfig(auth, 'password', false);
    const authSnap = sandbox.snapshot().services.auth as { providers: Record<string, boolean> };
    expect(authSnap.providers).toEqual({ password: false, anonymous: true, 'google.com': false });
  });
});

describe('auth provider-config persistence — round-trip', () => {
  it('restores toggled provider config in a fresh sandbox', async () => {
    const backend = createMemoryBackend();

    const sandbox1 = initializeSandbox();
    await sandbox1.enablePersistence({ key: 'auth:providers:rt', injectedBackend: backend });
    const auth1 = getAuth(sandbox1);
    authSandbox.setAuthProviderConfig(auth1, 'google.com', false);
    authSandbox.setAuthProviderConfig(auth1, 'anonymous', false);
    await sandbox1.flush();

    const sandbox2 = initializeSandbox();
    await sandbox2.enablePersistence({ key: 'auth:providers:rt', injectedBackend: backend });
    const auth2 = getAuth(sandbox2);

    const config = authSandbox.getAuthProviderConfig(auth2);
    const byId = Object.fromEntries(config.map((c) => [c.providerId, c.enabled]));
    expect(byId).toEqual({ password: true, anonymous: false, 'google.com': false });
  });

  it('legacy blob without a `providers` key restores to documented defaults', async () => {
    const backend = createMemoryBackend();

    // Simulate a pre-feature persisted blob: only `users`, no `providers`.
    const sandbox1 = initializeSandbox();
    await sandbox1.enablePersistence({ key: 'auth:providers:legacy', injectedBackend: backend });
    getAuth(sandbox1);
    await sandbox1.flush();
    // Overwrite the record directly to simulate a pre-feature blob.
    const recordIds = await backend.listRecords('auth:providers:legacy');
    for (const id of recordIds) {
      const rec = await backend.getRecord('auth:providers:legacy', id);
      if (rec && typeof rec === 'object' && 'services' in (rec as Record<string, unknown>)) {
        const services = (rec as { services?: Record<string, unknown> }).services;
        const authSection = services?.auth as { users?: unknown[]; providers?: unknown } | undefined;
        if (authSection) delete authSection.providers;
        await backend.putRecords('auth:providers:legacy', [[id, rec]]);
      }
    }

    const sandbox2 = initializeSandbox();
    await sandbox2.enablePersistence({ key: 'auth:providers:legacy', injectedBackend: backend });
    const auth2 = getAuth(sandbox2);

    const config = authSandbox.getAuthProviderConfig(auth2);
    const byId = Object.fromEntries(config.map((c) => [c.providerId, c.enabled]));
    expect(byId).toEqual({ password: true, anonymous: true });
  });

  it('changes to provider config trigger a debounced flush', async () => {
    const backend = createMemoryBackend();
    const sandbox = initializeSandbox();
    await sandbox.enablePersistence({ key: 'auth:providers:autoflush', injectedBackend: backend, flushIntervalMs: 20 });
    const auth = getAuth(sandbox);

    authSandbox.setAuthProviderConfig(auth, 'google.com', false);
    await sleep(60);

    const records: [string, unknown][] = [];
    for (const id of await backend.listRecords('auth:providers:autoflush')) {
      records.push([id, await backend.getRecord('auth:providers:autoflush', id)]);
    }
    const { services } = deserializeFromBuckets(records);
    const providers = (services as { auth?: { providers?: Record<string, boolean> } }).auth?.providers;
    expect(providers?.['google.com']).toBe(false);
  });
});

describe('sandbox.reset() and provider config', () => {
  it('reset() does NOT clear provider config — same precedent as the user DB', () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authSandbox.setAuthProviderConfig(auth, 'google.com', false);
    authSandbox.setAuthProviderConfig(auth, 'password', false);

    sandbox.reset();

    const config = authSandbox.getAuthProviderConfig(auth);
    const byId = Object.fromEntries(config.map((c) => [c.providerId, c.enabled]));
    expect(byId).toEqual({ password: false, anonymous: true, 'google.com': false });
  });

  it('a brand-new sandbox (not a reset() of an existing one) starts at the documented defaults', () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    const config = authSandbox.getAuthProviderConfig(auth);
    const byId = Object.fromEntries(config.map((c) => [c.providerId, c.enabled]));
    expect(byId).toEqual({ password: true, anonymous: true });
  });
});
