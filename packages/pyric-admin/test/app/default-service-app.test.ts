import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  REMOTE_SANDBOX_FACTORY,
  initializeSandbox,
  type RemoteSandbox,
} from 'pyric/sandbox';
import { LAZY_DEFAULT_AMBIENT_APP } from 'pyric/sandbox/internal';

import { getDefaultServiceApp } from '../../src/app/default-service-app.js';
import { deleteApp, getApp, getApps, initializeApp } from '../../src/app/index.js';
import { getAppCheck } from '../../src/app-check/index.js';
import { getAuth } from '../../src/auth/index.js';
import { getDatabase } from '../../src/database/index.js';
import { getFirestore } from '../../src/firestore/index.js';
import { getMessaging } from '../../src/messaging/index.js';
import { getRemoteConfig } from '../../src/remote-config/index.js';
import { getStorage } from '../../src/storage/index.js';

type LazyAmbientGlobal = {
  [REMOTE_SANDBOX_FACTORY]?: unknown;
  [LAZY_DEFAULT_AMBIENT_APP]?: boolean;
};

const savedEnv: Record<string, string | undefined> = {};
let savedFactory: unknown;
let savedLazyFlag: boolean | undefined;
let savedStderrWrite: typeof process.stderr.write;

beforeEach(() => {
  for (const key of ['PYRIC_SANDBOX', 'FIREBASE_CONFIG', 'NODE_ENV']) {
    savedEnv[key] = process.env[key];
  }
  process.env.PYRIC_SANDBOX = 'remote';
  process.env.FIREBASE_CONFIG = JSON.stringify({
    projectId: 'org-alpha',
    storageBucket: 'org-alpha.appspot.com',
    databaseURL: 'https://org-alpha-default-rtdb.firebaseio.com',
  });
  delete process.env.NODE_ENV;

  const globals = globalThis as LazyAmbientGlobal;
  savedFactory = globals[REMOTE_SANDBOX_FACTORY];
  savedLazyFlag = globals[LAZY_DEFAULT_AMBIENT_APP];
  delete globals[LAZY_DEFAULT_AMBIENT_APP];
  globals[REMOTE_SANDBOX_FACTORY] = () => initializeSandbox() as unknown as RemoteSandbox;

  savedStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
});

afterEach(async () => {
  process.stderr.write = savedStderrWrite;
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  const globals = globalThis as LazyAmbientGlobal;
  if (savedFactory === undefined) delete globals[REMOTE_SANDBOX_FACTORY];
  else globals[REMOTE_SANDBOX_FACTORY] = savedFactory;
  if (savedLazyFlag === undefined) delete globals[LAZY_DEFAULT_AMBIENT_APP];
  else globals[LAZY_DEFAULT_AMBIENT_APP] = savedLazyFlag;

  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('getDefaultServiceApp and lazy ambient [DEFAULT] behavior', () => {
  it('throws app/no-app when LAZY_DEFAULT_AMBIENT_APP is not enabled', () => {
    expect(() => getDefaultServiceApp()).toThrow(/default Firebase app does not exist/);
    expect(() => getDatabase()).toThrow(/default Firebase app does not exist/);
  });

  it('keeps getApp() throwing app/no-app when LAZY_DEFAULT_AMBIENT_APP is enabled so try/catch initializeApp(options) configures [DEFAULT]', () => {
    (globalThis as LazyAmbientGlobal)[LAZY_DEFAULT_AMBIENT_APP] = true;

    expect(getApps()).toHaveLength(0);
    let getAppThrew = false;
    let app;
    try {
      app = getApp();
    } catch (err) {
      getAppThrew = true;
      expect((err as { code?: string }).code).toBe('app/no-app');
      app = initializeApp({ storageBucket: 'archive-bucket' });
    }
    expect(getAppThrew).toBe(true);
    expect(app.options.storageBucket).toBe('archive-bucket');
    expect(getStorage().bucket().name).toBe('archive-bucket');
  });

  it('lazily initializes [DEFAULT] on no-arg service getters and upgrades options on a later explicit initializeApp(options)', async () => {
    (globalThis as LazyAmbientGlobal)[LAZY_DEFAULT_AMBIENT_APP] = true;

    expect(getApps()).toHaveLength(0);
    expect(getDatabase()).toBeDefined();
    expect(getFirestore()).toBeDefined();
    expect(getStorage().bucket().name).toBe('org-alpha.appspot.com');
    expect(getAuth()).toBeDefined();
    expect(getMessaging()).toBeDefined();
    expect(getAppCheck()).toBeDefined();
    expect(getRemoteConfig()).toBeDefined();
    expect(getApps()).toHaveLength(1);

    const upgraded = initializeApp({ storageBucket: 'upgraded-archive-bucket' });
    expect(upgraded.options.storageBucket).toBe('upgraded-archive-bucket');
    expect(getApp().options.storageBucket).toBe('upgraded-archive-bucket');
    expect(getStorage().bucket().name).toBe('upgraded-archive-bucket');
  });
});
