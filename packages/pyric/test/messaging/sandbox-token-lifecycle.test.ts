/**
 * getToken / deleteToken lifecycle — client mirror, sandbox target, BLOCKING.
 *
 * The oracle rows pin the token SHAPE and per-registration STABILITY as
 * production facts; this suite owns the lifecycle mechanics the mirror adds:
 * stability keyed on the (simulated) service-worker registration identity,
 * per-sandbox token isolation, and the delete → re-mint transition. Permission
 * is modeled as always-granted in the sandbox (no permission-denied plane), so
 * getToken always resolves — noted, not asserted as deniable.
 */
import { describe, expect, it } from 'bun:test';
import { createAppForSandbox } from '../../src/app/internal.js';
import { initializeSandbox } from '../../src/sandbox/index.js';
import {
  deleteToken,
  getMessaging,
  getToken,
  onMessage,
  sandbox as messagingSandbox,
} from '../../src/messaging/index.js';

function sandboxApp() {
  // Distinct independent apps need distinct names — a default-name reuse
  // would collide (app/duplicate-app), exactly as firebase/app does. The
  // random suffix stays unique across the messaging test files (one process,
  // one shared app registry).
  return createAppForSandbox(initializeSandbox(), { projectId: 'messaging-test' }, `msg-${Math.random().toString(36).slice(2)}`);
}

/** A distinct simulated registration (identity is what token stability keys on). */
function registration(scope: string) {
  return { scope, active: { state: 'activated' as const } };
}

describe('getToken (sandbox)', () => {
  it('resolves a token and is stable per registration (permission modeled as granted)', async () => {
    const messaging = getMessaging(sandboxApp());
    const reg = messagingSandbox.registration();
    const token = await getToken(messaging, { vapidKey: 'k', serviceWorkerRegistration: reg });
    expect(typeof token).toBe('string');
    expect(await getToken(messaging, { serviceWorkerRegistration: reg })).toBe(token);
  });

  it('mints distinct tokens for distinct registrations on the same instance', async () => {
    const messaging = getMessaging(sandboxApp());
    const t1 = await getToken(messaging, { serviceWorkerRegistration: registration('/a') });
    const t2 = await getToken(messaging, { serviceWorkerRegistration: registration('/b') });
    expect(t1).not.toBe(t2);
  });

  it('is stable across the module-default registration within one sandbox', async () => {
    // No serviceWorkerRegistration → the module-default registration object;
    // repeated calls key on its identity and return the same token.
    const messaging = getMessaging(sandboxApp());
    const t1 = await getToken(messaging);
    expect(await getToken(messaging)).toBe(t1);
  });

  it('isolates tokens per sandbox — same default registration, distinct brokers, distinct tokens', async () => {
    const a = getMessaging(sandboxApp());
    const b = getMessaging(sandboxApp());
    expect(await getToken(a)).not.toBe(await getToken(b));
  });

  it('rejects a Messaging instance not produced by this module', async () => {
    const foreign = { app: sandboxApp() } as ReturnType<typeof getMessaging>;
    await expect(getToken(foreign)).rejects.toThrow(/was not produced by/);
  });
});

describe('deleteToken (sandbox)', () => {
  it('resolves truthy even when no token was ever minted', async () => {
    expect(await deleteToken(getMessaging(sandboxApp()))).toBe(true);
  });

  it('resolves truthy after a mint, and a subsequent getToken re-mints a fresh token', async () => {
    const messaging = getMessaging(sandboxApp());
    const reg = messagingSandbox.registration();
    const before = await getToken(messaging, { serviceWorkerRegistration: reg });
    expect(await deleteToken(messaging)).toBe(true);
    const after = await getToken(messaging, { serviceWorkerRegistration: reg });
    expect(after).not.toBe(before); // registration entry cleared, fresh token minted
  });

  it('deleting one sandbox\'s token leaves another sandbox\'s token untouched', async () => {
    const a = getMessaging(sandboxApp());
    const b = getMessaging(sandboxApp());
    const tokenB = await getToken(b);
    await getToken(a);
    await deleteToken(a);
    expect(await getToken(b)).toBe(tokenB);
  });

  it('the sandbox.deliver driver is token-independent: delivery still fires after deleteToken', async () => {
    // deleteToken invalidates the token on the SEND plane (broker `send`
    // answers UNREGISTERED — covered by the broker + oracle suites). The
    // client mirror's `sandbox.deliver` is a direct injector, not a send, so
    // it keeps routing by visibility. Pinned so the seam is explicit.
    const messaging = getMessaging(sandboxApp());
    await getToken(messaging);
    await deleteToken(messaging);
    const seen: unknown[] = [];
    onMessage(messaging, (p) => { seen.push(p); });
    await messagingSandbox.deliver(messaging, { visibilityState: 'visible', data: { k: 'v' } });
    expect(seen.length).toBe(1);
  });
});
