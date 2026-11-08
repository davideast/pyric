import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { deleteApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import * as ipAuth from 'pyric/auth';
import { mintCustomTokenFor } from 'pyric/auth/internal';
import * as ipDb from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';
import * as ipStorage from 'pyric/storage';
import { handleMessage, type PortLike } from '../../../src/serve/worker/host.js';
import { setDatabaseRules } from '../../../src/serve/worker/host/rules.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import { OPEN_STORAGE_RULES } from './permissive-services.js';
import { type FakePort, makeHostCtx, portPair, sleep } from './integration-support.js';

let seq = 0;
function nextAppName(prefix: string): string {
  return `auth-app-parity-${prefix}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
}

describe('Cross-plane Auth, App lifecycle, and multi-instance parity', () => {
  let restoreSW: () => void;

  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSW = () => {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = previous;
    };
  });

  afterEach(() => {
    restoreSW();
  });

  async function setupServedHost(appOptions?: {
    projectId?: string;
    databaseURL?: string;
    storageBucket?: string;
  }) {
    const ctx = await makeHostCtx();
    if (appOptions) {
      ctx.appOptions = appOptions;
    }
    ipStorage.getStorageSandbox(ctx.sandbox, {
      dbName: nextAppName('served-default-storage'),
      bucket: 'demo-bucket',
      rules: OPEN_STORAGE_RULES,
    });
    ipStorage.getStorageSandbox(ctx.sandbox, {
      dbName: nextAppName('served-other-storage'),
      bucket: 'other-bucket',
      rules: OPEN_STORAGE_RULES,
    });
    setDatabaseRules(ctx, 'secondary-items', { rules: { '.read': true, '.write': true } });

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
    const servedDb = await import('../../../src/serve/entries/database.js');
    const servedStorage = await import('../../../src/serve/entries/storage.js');

    return { ctx, servedAuth, servedDb, servedStorage };
  }

  it('supports bound observer objects on onAuthStateChanged / onIdTokenChanged and auth.signOut() across planes', async () => {
    const { ctx, servedAuth } = await setupServedHost({ projectId: 'demo-project' });
    const servedApp = createAppForSandbox(ctx.sandbox, { projectId: 'demo-project' }, nextAppName('served-obs'));
    const ipSandbox = initializeSandbox();
    const ipApp = createAppForSandbox(ipSandbox, { projectId: 'demo-project' }, nextAppName('ip-obs'));

    try {
      const sAuth = servedAuth.getAuth(servedApp);
      const pAuth = ipAuth.getAuth(ipApp);

      const servedStateFn: Array<string | null> = [];
      const servedStateObs = {
        tag: 'state:',
        events: [] as string[],
        next(user: { uid: string } | null) {
          this.events.push(`${this.tag}${user?.uid ?? 'null'}`);
        },
      };
      const servedTokenObs = {
        tag: 'token:',
        events: [] as string[],
        next(user: { uid: string } | null) {
          this.events.push(`${this.tag}${user?.uid ?? 'null'}`);
        },
      };

      const ipStateFn: Array<string | null> = [];
      const ipStateObs = {
        tag: 'state:',
        events: [] as string[],
        next(user: { uid: string } | null) {
          this.events.push(`${this.tag}${user?.uid ?? 'null'}`);
        },
      };
      const ipTokenObs = {
        tag: 'token:',
        events: [] as string[],
        next(user: { uid: string } | null) {
          this.events.push(`${this.tag}${user?.uid ?? 'null'}`);
        },
      };

      const unsubServedFn = servedAuth.onAuthStateChanged(sAuth, (u) => servedStateFn.push(u?.uid ?? null));
      const unsubServedObs = servedAuth.onAuthStateChanged(sAuth, servedStateObs);
      const unsubServedTok = servedAuth.onIdTokenChanged(sAuth, servedTokenObs);

      const unsubIpFn = ipAuth.onAuthStateChanged(pAuth, (u) => ipStateFn.push(u?.uid ?? null));
      const unsubIpObs = ipAuth.onAuthStateChanged(pAuth, ipStateObs);
      const unsubIpTok = ipAuth.onIdTokenChanged(pAuth, ipTokenObs);

      try {
        await sleep(15);
        expect(servedStateFn).toEqual([null]);
        expect(servedStateObs.events).toEqual(['state:null']);
        expect(servedTokenObs.events).toEqual(['token:null']);
        expect(ipStateFn).toEqual([null]);
        expect(ipStateObs.events).toEqual(['state:null']);
        expect(ipTokenObs.events).toEqual(['token:null']);

        const sCred = await servedAuth.signInAnonymously(sAuth);
        const pCred = await ipAuth.signInAnonymously(pAuth);
        await sleep(15);

        expect(servedStateFn).toEqual([null, sCred.user.uid]);
        expect(servedStateObs.events).toEqual(['state:null', `state:${sCred.user.uid}`]);
        expect(servedTokenObs.events).toEqual(['token:null', `token:${sCred.user.uid}`]);
        expect(ipStateFn).toEqual([null, pCred.user.uid]);
        expect(ipStateObs.events).toEqual(['state:null', `state:${pCred.user.uid}`]);
        expect(ipTokenObs.events).toEqual(['token:null', `token:${pCred.user.uid}`]);

        // Forced token refresh fires onIdTokenChanged observer objects without re-firing onAuthStateChanged.
        await sCred.user.getIdToken(true);
        await pCred.user.getIdToken(true);
        await sleep(15);

        expect(servedStateObs.events).toEqual(['state:null', `state:${sCred.user.uid}`]);
        expect(servedTokenObs.events).toEqual([
          'token:null',
          `token:${sCred.user.uid}`,
          `token:${sCred.user.uid}`,
        ]);
        expect(ipStateObs.events).toEqual(['state:null', `state:${pCred.user.uid}`]);
        expect(ipTokenObs.events).toEqual([
          'token:null',
          `token:${pCred.user.uid}`,
          `token:${pCred.user.uid}`,
        ]);

        // Method-form auth.signOut() works on both served ClientAuth and in-process Auth.
        expect(typeof sAuth.signOut).toBe('function');
        await sAuth.signOut();
        await pAuth.signOut();
        await sleep(15);

        expect(sAuth.currentUser).toBeNull();
        expect(pAuth.currentUser).toBeNull();
        expect(servedStateObs.events).toEqual(['state:null', `state:${sCred.user.uid}`, 'state:null']);
        expect(ipStateObs.events).toEqual(['state:null', `state:${pCred.user.uid}`, 'state:null']);
      } finally {
        unsubServedFn();
        unsubServedObs();
        unsubServedTok();
        unsubIpFn();
        unsubIpObs();
        unsubIpTok();
      }
    } finally {
      await deleteApp(servedApp);
      await deleteApp(ipApp);
    }
  });

  it('refreshes providerData and tenantId on in-process reload(user) to match served reload(user)', async () => {
    const { ctx, servedAuth } = await setupServedHost({ projectId: 'demo-project' });
    const servedApp = createAppForSandbox(ctx.sandbox, { projectId: 'demo-project' }, nextAppName('served-reload'));
    const ipSandbox = initializeSandbox();
    const ipApp = createAppForSandbox(ipSandbox, { projectId: 'demo-project' }, nextAppName('ip-reload'));

    try {
      const hostAuth = ipAuth.getAuth(ctx.sandbox);
      ipAuth.sandbox.seedUsers(hostAuth, [
        {
          uid: 'user-1',
          email: 'user-1@example.test',
          password: 'password1234',
          displayName: 'User One',
          providerUserInfo: [{ providerId: 'password' }],
          tenantId: null,
        },
      ]);

      const pAuth = ipAuth.getAuth(ipApp);
      ipAuth.sandbox.seedUsers(pAuth, [
        {
          uid: 'user-1',
          email: 'user-1@example.test',
          password: 'password1234',
          displayName: 'User One',
          providerUserInfo: [{ providerId: 'password' }],
          tenantId: null,
        },
      ]);

      const sAuth = servedAuth.getAuth(servedApp);
      const sCred = await servedAuth.signInWithEmailAndPassword(sAuth, 'user-1@example.test', 'password1234');
      const pCred = await ipAuth.signInWithEmailAndPassword(pAuth, 'user-1@example.test', 'password1234');

      expect(sCred.user.providerData?.map((p) => p.providerId)).toEqual(['password']);
      expect(pCred.user.providerData?.map((p) => p.providerId)).toEqual(['password']);
      expect(sCred.user.tenantId).toBeNull();
      expect(pCred.user.tenantId).toBeNull();

      // Out-of-band account mutation links a second provider, updates profile, and assigns tenantId.
      const updatedSeed = [
        {
          uid: 'user-1',
          email: 'user-1-next@example.test',
          password: 'password1234',
          displayName: 'User One Updated',
          providerUserInfo: [{ providerId: 'password' }, { providerId: 'google.com' }],
          tenantId: 'org-1',
        },
      ];
      ipAuth.sandbox.seedUsers(hostAuth, updatedSeed);
      ipAuth.sandbox.seedUsers(pAuth, updatedSeed);

      await servedAuth.reload(sCred.user);
      await ipAuth.reload(pCred.user);

      expect(pCred.user.email).toBe('user-1-next@example.test');
      expect(pCred.user.displayName).toBe('User One Updated');
      expect(pCred.user.tenantId).toBe('org-1');
      expect(pCred.user.providerData?.map((p) => p.providerId)).toEqual(
        sCred.user.providerData?.map((p) => p.providerId),
      );
      expect(pCred.user.providerData?.map((p) => p.providerId)).toEqual(['password', 'google.com']);
      expect(pCred.user.providerData?.map((p) => p.email)).toEqual([
        'user-1-next@example.test',
        'user-1-next@example.test',
      ]);
      expect(pAuth.currentUser?.tenantId).toBe('org-1');
      expect(pAuth.currentUser?.providerData?.map((p) => p.providerId)).toEqual(['password', 'google.com']);
    } finally {
      await deleteApp(servedApp);
      await deleteApp(ipApp);
    }
  });

  it('preserves cached getDatabase / getStorage handles after deleteApp(app) and clears retainedAuth.currentUser on signOut', async () => {
    const appConfig = {
      projectId: 'demo-project',
      databaseURL: 'https://secondary-items.firebaseio.com',
      storageBucket: 'gs://demo-bucket',
    };
    const { ctx, servedAuth, servedDb, servedStorage } = await setupServedHost(appConfig);

    const ipSandbox = initializeSandbox();
    ipStorage.getStorageSandbox(ipSandbox, {
      dbName: nextAppName('ip-default-storage'),
      bucket: 'demo-bucket',
      rules: OPEN_STORAGE_RULES,
    });

    const ipApp = createAppForSandbox(ipSandbox, appConfig, nextAppName('ip-deleted'));
    const servedApp = createAppForSandbox(ctx.sandbox, appConfig, nextAppName('served-deleted'));

    const pAuth = ipAuth.getAuth(ipApp);
    const pDb = ipDb.getDatabase(ipApp);
    const pStore = ipStorage.getStorage(ipApp);

    const sAuth = servedAuth.getAuth(servedApp);
    const sDb = servedDb.getDatabase(servedApp);
    const sStore = servedStorage.getStorage(servedApp);

    await ipAuth.signInAnonymously(pAuth);
    await servedAuth.signInAnonymously(sAuth);
    expect(pAuth.currentUser).not.toBeNull();
    expect(sAuth.currentUser).not.toBeNull();

    await deleteApp(ipApp);
    await deleteApp(servedApp);

    // Cached service factories on a deleted app return their cached handles rather than throwing app/app-deleted.
    expect(ipAuth.getAuth(ipApp)).toBe(pAuth);
    expect(ipDb.getDatabase(ipApp)).toBe(pDb);
    expect(ipStorage.getStorage(ipApp)).toBe(pStore);
    expect(ipStorage.getStorage(ipApp, 'demo-bucket')).toBe(pStore);
    expect(ipStorage.getStorage(ipApp, 'gs://demo-bucket')).toBe(pStore);

    expect(servedAuth.getAuth(servedApp)).toBe(sAuth);
    expect(servedDb.getDatabase(servedApp)).toBe(sDb);
    expect(servedStorage.getStorage(servedApp)).toBe(sStore);
    expect(servedStorage.getStorage(servedApp, 'demo-bucket')).toBe(sStore);
    expect(servedStorage.getStorage(servedApp, 'gs://demo-bucket')).toBe(sStore);

    // Uncached service instances on a deleted app reject with app/app-deleted.
    expect(() => ipDb.getDatabase(ipApp, 'https://uncached-items.firebaseio.com')).toThrow(/app-deleted/);
    expect(() => ipStorage.getStorage(ipApp, 'gs://uncached-bucket')).toThrow(/app-deleted/);
    expect(() => servedDb.getDatabase(servedApp, 'https://uncached-items.firebaseio.com')).toThrow(/app-deleted/);
    expect(() => servedStorage.getStorage(servedApp, 'gs://uncached-bucket')).toThrow(/app-deleted/);

    // signOut on a retained Auth handle resolves and leaves currentUser null.
    await expect(ipAuth.signOut(pAuth)).resolves.toBeUndefined();
    await expect(servedAuth.signOut(sAuth)).resolves.toBeUndefined();
    expect(pAuth.currentUser).toBeNull();
    expect(sAuth.currentUser).toBeNull();
  });

  it('normalizes gs://bucket and bare bucket URLs in getStorage(app, bucketUrl) across planes', async () => {
    const bareHost = await setupServedHost({
      projectId: 'demo-project',
      storageBucket: 'demo-bucket',
    });
    const servedBareApp = createAppForSandbox(
      bareHost.ctx.sandbox,
      { projectId: 'demo-project', storageBucket: 'demo-bucket' },
      nextAppName('served-bare'),
    );
    expect(bareHost.servedStorage.getStorage(servedBareApp, 'demo-bucket')).toBe(
      bareHost.servedStorage.getStorage(servedBareApp),
    );
    expect(bareHost.servedStorage.getStorage(servedBareApp, 'gs://demo-bucket')).toBe(
      bareHost.servedStorage.getStorage(servedBareApp),
    );
    expect(bareHost.servedStorage.getStorage(servedBareApp, 'gs://other-bucket')).toBe(
      bareHost.servedStorage.getStorage(servedBareApp, 'other-bucket'),
    );
    expect(bareHost.servedStorage.getStorage(servedBareApp, 'gs://other-bucket')).not.toBe(
      bareHost.servedStorage.getStorage(servedBareApp),
    );
    await deleteApp(servedBareApp);

    const gsHost = await setupServedHost({
      projectId: 'demo-project',
      storageBucket: 'gs://demo-bucket',
    });
    const servedGsApp = createAppForSandbox(
      gsHost.ctx.sandbox,
      { projectId: 'demo-project', storageBucket: 'gs://demo-bucket' },
      nextAppName('served-gs'),
    );

    const ipSandbox = initializeSandbox();
    ipStorage.getStorageSandbox(ipSandbox, {
      dbName: nextAppName('ip-norm-default'),
      bucket: 'demo-bucket',
      rules: OPEN_STORAGE_RULES,
    });
    ipStorage.getStorageSandbox(ipSandbox, {
      dbName: nextAppName('ip-norm-other'),
      bucket: 'other-bucket',
      rules: OPEN_STORAGE_RULES,
    });

    const ipBareApp = createAppForSandbox(
      ipSandbox,
      { projectId: 'demo-project', storageBucket: 'demo-bucket' },
      nextAppName('ip-bare'),
    );
    const ipGsApp = createAppForSandbox(
      ipSandbox,
      { projectId: 'demo-project', storageBucket: 'gs://demo-bucket' },
      nextAppName('ip-gs'),
    );

    try {
      expect(gsHost.servedStorage.getStorage(servedGsApp, 'demo-bucket')).toBe(
        gsHost.servedStorage.getStorage(servedGsApp),
      );
      expect(gsHost.servedStorage.getStorage(servedGsApp, 'gs://demo-bucket')).toBe(
        gsHost.servedStorage.getStorage(servedGsApp),
      );

      expect(ipStorage.getStorage(ipBareApp, 'demo-bucket')).toBe(ipStorage.getStorage(ipBareApp));
      expect(ipStorage.getStorage(ipBareApp, 'gs://demo-bucket')).toBe(ipStorage.getStorage(ipBareApp));
      expect(ipStorage.getStorage(ipGsApp, 'demo-bucket')).toBe(ipStorage.getStorage(ipGsApp));
      expect(ipStorage.getStorage(ipGsApp, 'gs://demo-bucket')).toBe(ipStorage.getStorage(ipGsApp));
      expect(ipStorage.getStorage(ipBareApp, 'gs://other-bucket')).toBe(
        ipStorage.getStorage(ipBareApp, 'other-bucket'),
      );
      expect(ipStorage.getStorage(ipBareApp, 'gs://other-bucket')).not.toBe(
        ipStorage.getStorage(ipBareApp),
      );
    } finally {
      await deleteApp(ipBareApp);
      await deleteApp(ipGsApp);
      await deleteApp(servedGsApp);
    }
  });

  it('reload(user) updates User profile in-place without prematurely refreshing cached ID token or overwriting custom signInProvider', async () => {
    const { ctx, servedAuth } = await setupServedHost({ projectId: 'demo-project' });
    const servedApp = createAppForSandbox(ctx.sandbox, { projectId: 'demo-project' }, nextAppName('served-reload-token'));
    const ipSandbox = initializeSandbox();
    const ipApp = createAppForSandbox(ipSandbox, { projectId: 'demo-project' }, nextAppName('ip-reload-token'));

    try {
      const hostAuth = ipAuth.getAuth(ctx.sandbox);
      const pAuth = ipAuth.getAuth(ipApp);
      const sAuth = servedAuth.getAuth(servedApp);

      ipAuth.sandbox.seedUsers(hostAuth, [
        { uid: 'u-reload', email: 'reload@example.test', password: 'password1234', customClaims: { role: 'viewer' } },
      ]);
      ipAuth.sandbox.seedUsers(pAuth, [
        { uid: 'u-reload', email: 'reload@example.test', password: 'password1234', customClaims: { role: 'viewer' } },
      ]);

      const sCred = await servedAuth.signInWithEmailAndPassword(sAuth, 'reload@example.test', 'password1234');
      const pCred = await ipAuth.signInWithEmailAndPassword(pAuth, 'reload@example.test', 'password1234');

      ipAuth.sandbox.updateUser(hostAuth, 'u-reload', {
        displayName: 'Admin Renamed',
        emailVerified: true,
        customClaims: { role: 'admin' },
      });
      ipAuth.sandbox.updateUser(pAuth, 'u-reload', {
        displayName: 'Admin Renamed',
        emailVerified: true,
        customClaims: { role: 'admin' },
      });

      await servedAuth.reload(sCred.user);
      await ipAuth.reload(pCred.user);

      expect(sCred.user.displayName).toBe('Admin Renamed');
      expect(sCred.user.emailVerified).toBe(true);

      const pTokCached = await ipAuth.getIdTokenResult(pCred.user, false);
      const sTokCached = await servedAuth.getIdTokenResult(sCred.user, false);
      expect(sTokCached.claims.role).toBe(pTokCached.claims.role);
      expect(sTokCached.claims.role).toBe('viewer');
      expect(sTokCached.claims.email_verified).toBe(false);

      const pTokFresh = await ipAuth.getIdTokenResult(pCred.user, true);
      const sTokFresh = await servedAuth.getIdTokenResult(sCred.user, true);
      expect(sTokFresh.claims.role).toBe(pTokFresh.claims.role);
      expect(sTokFresh.claims.role).toBe('admin');
      expect(sTokFresh.claims.email_verified).toBe(true);

      // Custom token signInProvider stays 'custom' across reload and updateEmail
      const sCustomTok = mintCustomTokenFor(hostAuth, 'u-custom', { tier: 'pro' });
      const pCustomTok = mintCustomTokenFor(pAuth, 'u-custom', { tier: 'pro' });
      const sCustomCred = await servedAuth.signInWithCustomToken(sAuth, sCustomTok);
      const pCustomCred = await ipAuth.signInWithCustomToken(pAuth, pCustomTok);

      await servedAuth.reload(sCustomCred.user);
      await ipAuth.reload(pCustomCred.user);
      expect((await servedAuth.getIdTokenResult(sCustomCred.user, false)).signInProvider).toBe('custom');
      expect((await ipAuth.getIdTokenResult(pCustomCred.user, false)).signInProvider).toBe('custom');

      await servedAuth.updateEmail(sCustomCred.user, 'custom-updated@example.test');
      await ipAuth.updateEmail(pCustomCred.user, 'custom-updated@example.test');
      const sCustomAfterEmail = await servedAuth.getIdTokenResult(sCustomCred.user, true);
      const pCustomAfterEmail = await ipAuth.getIdTokenResult(pCustomCred.user, true);
      expect(sCustomAfterEmail.signInProvider).toBe(pCustomAfterEmail.signInProvider);
      expect(sCustomAfterEmail.signInProvider).toBe('custom');
    } finally {
      await deleteApp(servedApp);
      await deleteApp(ipApp);
    }
  });
});
