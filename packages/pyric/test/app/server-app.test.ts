import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as realApp from 'firebase/app';
import 'fake-indexeddb/auto';
import {
  deleteApp,
  FirebaseError,
  getApp,
  getApps,
  initializeApp,
  initializeServerApp,
  type FirebaseApp,
  type FirebaseOptions,
  type FirebaseServerApp,
  type FirebaseServerAppSettings,
} from '../../src/app/index.js';
import { resetAppRegistryForTests } from '../../src/app/internal.js';
import { sandboxForApp } from '../../src/app/runtime.js';
import { getAI, getGenerativeModel } from '../../src/ai/index.js';
import { isAppCheckRefusal } from '../../src/ai/app-check-gate.js';
import { createUserWithEmailAndPassword, getAuth } from '../../src/auth/index.js';
import { doc, getDoc, getFirestore, setDoc } from '../../src/firestore/index.js';
import { setRules } from '../../src/firestore/sandbox-controls.js';
import type { LocalSandbox } from '../../src/sandbox/index.js';
import { mintAppCheckToken } from '../../src/sandbox/internal/app-check-token.js';
import { mintIdToken } from '../../src/sandbox/internal/id-token.js';

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

const _assertServerAppSame: Same<FirebaseServerApp, realApp.FirebaseServerApp> = true;
const _assertServerSettingsSame: Same<FirebaseServerAppSettings, realApp.FirebaseServerAppSettings> = true;
const _assertInitServerAppAssignableToReal: typeof realApp.initializeServerApp = initializeServerApp;
const _assertRealAssignableToInitServerApp: typeof initializeServerApp = realApp.initializeServerApp;
void _assertServerAppSame;
void _assertServerSettingsSame;
void _assertInitServerAppAssignableToReal;
void _assertRealAssignableToInitServerApp;

const OPTS: FirebaseOptions = {
  apiKey: 'fake-api-key',
  projectId: 'demo-server-app-test',
  appId: '1:123456789012:web:serverapp01',
};

beforeEach(async () => {
  await resetAppRegistryForTests();
});

afterEach(async () => {
  await resetAppRegistryForTests();
});

describe('pyric/app initializeServerApp parity (#1644)', () => {
  it('matches upstream firebase/app 13.4.0 hash naming, settings shape, toJSON, refcounting, and deletion errors', async () => {
    const derefA = {};
    const derefB = {};
    const upstream = realApp.initializeServerApp(OPTS, {
      automaticDataCollectionEnabled: false,
      releaseOnDeref: derefA,
    });
    try {
      const pyricServer = initializeServerApp(OPTS, {
        automaticDataCollectionEnabled: false,
        releaseOnDeref: derefB,
      });

      expect(pyricServer.name).toBe(upstream.name);
      expect(pyricServer.options).toEqual(upstream.options);
      expect(pyricServer.automaticDataCollectionEnabled).toBe(false);
      expect(pyricServer.settings).toEqual(upstream.settings);
      expect(pyricServer.settings.releaseOnDeref).toBeUndefined();
      expect(pyricServer.toJSON?.()).toBeUndefined();
      expect(JSON.stringify(pyricServer)).toBeUndefined();

      // Isolated from client getApps() and getApp()
      expect(getApps()).toEqual([]);
      expect(() => getApp(pyricServer.name)).toThrow(/No Firebase App/);

      // Second call with identical config (different releaseOnDeref) returns same instance and increments refCount
      const secondRef = initializeServerApp({ ...OPTS }, {
        automaticDataCollectionEnabled: false,
        releaseOnDeref: {},
      });
      expect(secondRef).toBe(pyricServer);

      // First deleteApp decrements refCount (2 -> 1); server app stays usable
      await deleteApp(pyricServer);
      expect(pyricServer.name).toBe(upstream.name);

      // Second deleteApp decrements refCount (1 -> 0); server app becomes deleted
      await deleteApp(pyricServer);
      await realApp.deleteApp(upstream);

      let realDeletedErr: Error | undefined;
      try {
        void upstream.name;
      } catch (err) {
        realDeletedErr = err as Error;
      }
      let pyricDeletedErr: Error | undefined;
      try {
        void pyricServer.name;
      } catch (err) {
        pyricDeletedErr = err as Error;
      }
      expect(pyricDeletedErr).toBeInstanceOf(FirebaseError);
      expect((pyricDeletedErr as FirebaseError).code).toBe('app/server-app-deleted');
      expect(pyricDeletedErr?.message).toBe(realDeletedErr?.message);

      expect(() => pyricServer.settings).toThrow(realDeletedErr?.message);
      expect(() => pyricServer.options).toThrow(realDeletedErr?.message);
      await expect(deleteApp(pyricServer)).rejects.toThrow(realDeletedErr?.message);
    } finally {
      try {
        await realApp.deleteApp(upstream);
      } catch (err) {
        void err;
      }
    }
  });

  it('supports FirebaseApp first argument and __FIREBASE_DEFAULTS__ single-arg overload identically to upstream', async () => {
    const clientApp: FirebaseApp = initializeApp(OPTS, 'seed-client');
    const fromClient = initializeServerApp(clientApp, { automaticDataCollectionEnabled: true });
    const upstreamClient = realApp.initializeApp(OPTS, 'real-seed-client');
    const upstreamFromClient = realApp.initializeServerApp(upstreamClient, {
      automaticDataCollectionEnabled: true,
    });
    try {
      expect(fromClient.name).toBe(upstreamFromClient.name);
      expect(fromClient.options).toEqual(upstreamFromClient.options);
    } finally {
      await realApp.deleteApp(upstreamFromClient);
      await realApp.deleteApp(upstreamClient);
    }

    // Without options or __FIREBASE_DEFAULTS__, throws app/no-options
    expect(() => initializeServerApp({ automaticDataCollectionEnabled: false })).toThrow(
      /Need to provide options/,
    );

    const prevEnv = process.env.__FIREBASE_DEFAULTS__;
    process.env.__FIREBASE_DEFAULTS__ = JSON.stringify({ config: OPTS });
    try {
      const envServer = initializeServerApp({ automaticDataCollectionEnabled: false });
      const realEnvServer = realApp.initializeServerApp({ automaticDataCollectionEnabled: false });
      try {
        expect(envServer.name).toBe(realEnvServer.name);
        expect(envServer.options).toEqual(realEnvServer.options);
        expect(envServer.automaticDataCollectionEnabled).toBe(false);
      } finally {
        await realApp.deleteApp(realEnvServer);
        await deleteApp(envServer);
      }
    } finally {
      if (prevEnv === undefined) {
        delete process.env.__FIREBASE_DEFAULTS__;
      } else {
        process.env.__FIREBASE_DEFAULTS__ = prevEnv;
      }
    }
  });

  it('throws app/invalid-server-app-environment in a browser Window while allowing WebWorker realms', async () => {
    const scope = globalThis as Record<string, unknown>;
    const hadWindow = 'window' in scope;
    const prevWindow = scope.window;
    const hadWgs = 'WorkerGlobalScope' in scope;
    const prevWgs = scope.WorkerGlobalScope;
    const hadSelf = 'self' in scope;
    const prevSelf = scope.self;

    try {
      scope.window = {};
      delete scope.WorkerGlobalScope;
      let err: FirebaseError | undefined;
      try {
        initializeServerApp(OPTS);
      } catch (caught) {
        err = caught as FirebaseError;
      }
      expect(err).toBeInstanceOf(FirebaseError);
      expect(err?.code).toBe('app/invalid-server-app-environment');
      expect(err?.message).toBe(
        'Firebase: FirebaseServerApp is not for use in browser environments. (app/invalid-server-app-environment).',
      );

      class FakeWorkerGlobalScope {}
      const workerSelf = new FakeWorkerGlobalScope();
      scope.WorkerGlobalScope = FakeWorkerGlobalScope;
      scope.self = workerSelf;
      const workerServerApp = initializeServerApp(OPTS);
      expect(typeof workerServerApp.name).toBe('string');
      await deleteApp(workerServerApp);
    } finally {
      if (hadWindow) scope.window = prevWindow;
      else delete scope.window;
      if (hadWgs) scope.WorkerGlobalScope = prevWgs;
      else delete scope.WorkerGlobalScope;
      if (hadSelf) scope.self = prevSelf;
      else delete scope.self;
    }
  });

  it('logs validateTokenTTL console.error diagnostics on malformed, exp-missing, and expired tokens without throwing', async () => {
    const logged: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map((item) => String(item)).join(' '));
    };
    try {
      const sMalformed = initializeServerApp(OPTS, { appCheckToken: 'not-a-jwt' });
      expect(logged).toEqual([
        'FirebaseServerApp appCheckToken is invalid: second part could not be parsed.',
      ]);
      logged.length = 0;
      await deleteApp(sMalformed);

      const noExpSeg = Buffer.from(JSON.stringify({ sub: 'u1' }), 'utf8').toString('base64url');
      const sNoExp = initializeServerApp(OPTS, { authIdToken: `eyJhbGciOiJSUzI1NiJ9.${noExpSeg}.sig` });
      expect(logged).toEqual([
        'FirebaseServerApp authIdToken is invalid: expiration claim could not be parsed',
      ]);
      logged.length = 0;
      await deleteApp(sNoExp);

      const pastExpSeg = Buffer.from(
        JSON.stringify({ sub: 'u1', exp: Math.floor(Date.now() / 1000) - 60 }),
        'utf8',
      ).toString('base64url');
      const sExpired = initializeServerApp(OPTS, {
        appCheckToken: `eyJhbGciOiJSUzI1NiJ9.${pastExpSeg}.sig`,
      });
      expect(logged).toEqual([
        'FirebaseServerApp appCheckToken is invalid: the token has expired.',
      ]);
      await deleteApp(sExpired);
    } finally {
      console.error = origError;
    }
  });

  it('forwards settings.appCheckToken to pyric/ai App Check gate and settings.authIdToken to security rules', async () => {
    const validAc = await mintAppCheckToken(
      { appId: OPTS.appId ?? '', projectId: OPTS.projectId ?? '' },
      3600,
    );
    const admittedApp = initializeServerApp(OPTS, { appCheckToken: validAc.token });
    const model = getGenerativeModel(getAI(admittedApp), { model: 'gemini-flash-lite-latest' });
    const response = await model.generateContent('hello from server app');
    expect(response.response.text().length).toBeGreaterThan(0);

    // Invalid App Check token is refused by the AI Logic gate with 401
    const origError = console.error;
    console.error = () => {};
    let rejectedApp: FirebaseServerApp | undefined;
    try {
      rejectedApp = initializeServerApp(OPTS, { appCheckToken: 'invalid-app-check-token' });
    } finally {
      console.error = origError;
    }
    const rejectedModel = getGenerativeModel(getAI(rejectedApp), {
      model: 'gemini-flash-lite-latest',
    });
    let gateErr: unknown;
    try {
      await rejectedModel.generateContent('should fail');
    } catch (caught) {
      gateErr = caught;
    }
    expect(isAppCheckRefusal(gateErr)).toBe(true);

    // Auth ID token forwarding into Firestore rules
    const clientApp = initializeApp(OPTS);
    const sandbox = sandboxForApp(clientApp) as LocalSandbox;
    setRules(
      sandbox,
      `
      rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /ssr/{uid} {
            allow read, write: if request.auth != null
              && request.auth.uid == uid
              && request.auth.token.ssrRole == 'editor';
          }
        }
      }
    `,
    );
    const cred = await createUserWithEmailAndPassword(
      getAuth(clientApp),
      'ssr@example.com',
      'password123',
    );
    const nowSec = Math.floor(Date.now() / 1000);
    const ssrIdToken = mintIdToken({
      aud: OPTS.projectId,
      iss: `https://securetoken.google.com/${OPTS.projectId}`,
      sub: cred.user.uid,
      user_id: cred.user.uid,
      iat: nowSec,
      exp: nowSec + 3600,
      ssrRole: 'editor',
    });

    const authedServerApp = initializeServerApp(OPTS, { authIdToken: ssrIdToken });
    const serverDb = getFirestore(authedServerApp);
    await setDoc(doc(serverDb, 'ssr', cred.user.uid), { rendered: true });
    const snap = await getDoc(doc(serverDb, 'ssr', cred.user.uid));
    expect(snap.data()).toEqual({ rendered: true });

    const unauthedServerApp = initializeServerApp(OPTS, { automaticDataCollectionEnabled: false });
    await expect(
      setDoc(doc(getFirestore(unauthedServerApp), 'ssr', cred.user.uid), { rendered: false }),
    ).rejects.toThrow();
  });
});
