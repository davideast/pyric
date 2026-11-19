import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSandbox, type RemoteSandbox, type Sandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getDatabase } from '../../src/database/index.js';
import {
  observeAdminUseEmulatorContract,
  type AdminUseEmulatorSdk,
} from '../../../conformance/probes/rtdb-modular/rtdb-modular-admin-use-emulator-validation.ts';
import { sharedWorkerArm } from './arms.js';

const OBS_DIR = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'conformance',
  'observations',
  'rtdb-modular',
);

function load(stemOrFile: string): Record<string, unknown> {
  let filename = `${stemOrFile}.json`;
  if (stemOrFile.endsWith('.json')) {
    filename = stemOrFile;
  }
  const parsed = JSON.parse(readFileSync(join(OBS_DIR, filename), 'utf8')) as {
    behavior: Record<string, unknown>;
  };
  return parsed.behavior;
}

let armSeq = 0;

const ARMS: ReadonlyArray<{
  name: string;
  makeSandbox: () => Sandbox | RemoteSandbox;
}> = [
  {
    name: 'in-process',
    makeSandbox() {
      armSeq += 1;
      return initializeSandbox({ projectId: `demo-admin-emu-local-${armSeq}` });
    },
  },
  {
    name: 'remote (SharedWorker bridge)',
    makeSandbox() {
      const { app } = sharedWorkerArm();
      return app.sandbox;
    },
  },
];

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe.each(ARMS)('RTDB admin Database#useEmulator oracle capture [$name]', ({ makeSandbox }) => {
  it('rtdb-modular-admin-use-emulator-validation (rtdb-admin#9)', async () => {
    const observed = load('rtdb-modular-admin-use-emulator-validation');
    const { fetchCalls, ...expectedContract } = observed;
    expect(fetchCalls).toBe(0);

    let appCounter = 0;
    const sdk: AdminUseEmulatorSdk = {
      createApp(options, label) {
        appCounter += 1;
        return initializeApp(
          {
            sandbox: makeSandbox(),
            projectId: options.projectId,
            databaseURL: options.databaseURL,
          },
          `pyric-admin-emu-${appCounter}-${label}`,
        ) as unknown as ReturnType<AdminUseEmulatorSdk['createApp']>;
      },
      getDatabase(app) {
        return getDatabase(
          app as unknown as Parameters<typeof getDatabase>[0],
        ) as unknown as ReturnType<AdminUseEmulatorSdk['getDatabase']>;
      },
      deleteApp(app) {
        return deleteApp(app as unknown as Parameters<typeof deleteApp>[0]);
      },
    };

    const actual = await observeAdminUseEmulatorContract(sdk);
    expect(actual as unknown).toEqual(expectedContract);

    // Verify data operations continue routing cleanly through the bound sandbox/remote backend
    // after pre-start useEmulator('127.0.0.1', 9000) rebinds Reference URLs.
    const liveSandbox = makeSandbox();
    const liveApp = initializeApp(
      {
        sandbox: liveSandbox,
        projectId: 'demo-admin-emulator-live',
        databaseURL: 'https://demo-admin-emulator-live.firebaseio.com',
      },
      `pyric-admin-emu-live-${++armSeq}`,
    );
    const liveDb = getDatabase(liveApp);
    liveDb.useEmulator('127.0.0.1', 9000);
    const itemRef = liveDb.ref('items/k1');
    expect(itemRef.toString()).toBe('http://127.0.0.1:9000/items/k1');
    await itemRef.set({ status: 'routed', count: 7 });
    const snap = await liveDb.refFromURL('http://127.0.0.1:9000/items/k1').get();
    expect(snap.val()).toEqual({ status: 'routed', count: 7 });
    expect(snap.ref.toString()).toBe('http://127.0.0.1:9000/items/k1');

    // Case-insensitive host normalization matches RepoInfo lowercasing while raw host comparisons govern post-start idempotency.
    const mixedCaseApp = initializeApp(
      {
        sandbox: makeSandbox(),
        projectId: 'demo-admin-emulator-case',
        databaseURL: 'https://demo-admin-emulator-case.firebaseio.com',
      },
      `pyric-admin-emu-case-${++armSeq}`,
    );
    const mixedCaseDb = getDatabase(mixedCaseApp);
    mixedCaseDb.useEmulator('LocalHost', 9000);
    expect(mixedCaseDb.ref('items/K1').toString()).toBe('http://localhost:9000/items/K1');
    expect(() => mixedCaseDb.useEmulator('LocalHost', 9000)).toThrow(
      'FIREBASE FATAL ERROR: connectDatabaseEmulator() cannot initialize or alter the emulator configuration after the database instance has started. ',
    );
    expect(() => mixedCaseDb.useEmulator('localhost', 9000)).not.toThrow();
  });
});
