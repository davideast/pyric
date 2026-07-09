/**
 * `pyric-admin/messaging` — service resolution + backend dispatch.
 *
 * Covers both arms of the registry: an explicit sandbox app yields the
 * broker-backed {@link Messaging}; an explicit prod app delegates to
 * `firebase-admin/messaging`'s genuine service (NOT our class). No-arg
 * `getMessaging()` resolves the registered `'[DEFAULT]'` app (sandbox and prod),
 * throws firebase-admin's exact `app/no-app` when none exists, and mints the
 * implicit climb app only under `PYRIC_CLIMB=1`. Also: per-app instance
 * caching, the `messaging()` legacy accessor, and the `enableLegacyHttpTransport`
 * no-op.
 *
 * Blocking unit suite (no PYRIC_CLIMB flag by default): the one climb-arm test
 * sets and restores the env itself. Prod-arm apps are created with a fake
 * projectId — firebase-admin's `getMessaging(app)` constructs offline, no
 * network until an op runs, mirroring the prod-target house pattern.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getMessaging, Messaging, messaging } from '../../src/messaging/index.js';

// Module-global registry; clear it before and after so default-app resolution
// is deterministic regardless of sibling suites in the same process.
beforeEach(async () => {
  for (const app of getApps()) await deleteApp(app);
});
afterEach(async () => {
  for (const app of getApps()) await deleteApp(app);
});

describe('explicit-app resolution', () => {
  it('a sandbox app yields the broker-backed Messaging class', () => {
    const app = initializeApp({ sandbox: initializeSandbox() });
    expect(getMessaging(app)).toBeInstanceOf(Messaging);
  });

  it('a prod app delegates to firebase-admin (not our Messaging class)', () => {
    const app = initializeApp({ projectId: 'demo-prod-msg' }, 'prod-explicit');
    const svc = getMessaging(app);
    expect(svc).not.toBeInstanceOf(Messaging);
    // The genuine firebase-admin Messaging is bound to the underlying admin app.
    expect((svc as unknown as { app: { name: string } }).app.name).toBe('prod-explicit');
    expect(typeof (svc as unknown as { send: unknown }).send).toBe('function');
  });

  it('caches one Messaging instance per app', () => {
    const app = initializeApp({ sandbox: initializeSandbox() });
    expect(getMessaging(app)).toBe(getMessaging(app));
  });

  it('the messaging() legacy accessor is equivalent to getMessaging()', () => {
    const app = initializeApp({ sandbox: initializeSandbox() });
    expect(messaging(app)).toBe(getMessaging(app));
  });
});

describe('default-app resolution', () => {
  it('no-arg getMessaging resolves the registered [DEFAULT] sandbox app', () => {
    const app = initializeApp({ sandbox: initializeSandbox() });
    expect(getMessaging()).toBe(getMessaging(app));
    expect(getMessaging()).toBeInstanceOf(Messaging);
  });

  it('no-arg getMessaging resolves the registered [DEFAULT] prod app', () => {
    const app = initializeApp({ projectId: 'demo-prod-default' });
    // Same genuine firebase-admin service the explicit call returns (identity).
    expect(getMessaging()).toBe(getMessaging(app));
  });

  it('throws firebase-admin\'s exact app/no-app when no default exists', () => {
    let err: unknown;
    try {
      getMessaging();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as { code: string }).code).toBe('app/no-app');
    expect((err as Error).constructor.name).toBe('FirebaseAppError');
    expect((err as Error).message).toMatch(/default Firebase app does not exist/);
  });

  it('mints an implicit sandbox app only under PYRIC_CLIMB=1', () => {
    const prev = process.env.PYRIC_CLIMB;
    process.env.PYRIC_CLIMB = '1';
    try {
      const svc = getMessaging();
      expect(svc).toBeInstanceOf(Messaging);
      // The climb app is memoized: a second call returns the same instance and
      // is deliberately NOT placed in the registry (getApps stays empty).
      expect(getMessaging()).toBe(svc);
      expect(getApps()).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.PYRIC_CLIMB;
      else process.env.PYRIC_CLIMB = prev;
    }
  });
});

describe('enableLegacyHttpTransport', () => {
  it('is a recorded no-op on the sandbox arm (no transport to reconfigure)', () => {
    const svc = getMessaging(initializeApp({ sandbox: initializeSandbox() }));
    expect(() => svc.enableLegacyHttpTransport()).not.toThrow();
  });
});
