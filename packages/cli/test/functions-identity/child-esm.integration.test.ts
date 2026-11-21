import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildChildEnv, registerModuleUrl } from '../../src/cli/sandbox-runner.js';
import { spawnFunctionsChild, type FunctionsChildHandle } from '../../src/functions/spawn.js';
import { connectRemoteSandbox, type RemoteSandbox } from '../../src/remote/index.js';
import {
  createUserWithEmailAndPassword,
  getAuth as getClientAuth,
  listUsers,
  type ClientDb,
} from '../../src/serve/worker/client.js';
import { trackTempDirs } from '../use-temp-dirs.js';
import {
  childModule,
  createChannelClientPort,
  repoRoot,
  startNodeHostedRuntime,
  type HostedNodeServer,
} from './hosted-harness.js';

describe('isolated ESM Functions Identity child against live HostedRuntime', () => {
  const tempDirs = trackTempDirs('pyric-fn-identity-esm-');
  let fixtureDir = '';
  let hosted: HostedNodeServer | undefined;
  let activeChild: FunctionsChildHandle | undefined;
  let readyPayload: Awaited<FunctionsChildHandle['ready']> | undefined;
  const clientConnections: RemoteSandbox[] = [];

  async function makeClientSession() {
    if (!hosted) throw new Error('hosted runtime not initialized');
    const conn = await connectRemoteSandbox({
      cwd: fixtureDir,
      url: hosted.url,
      sessionToken: hosted.sessionToken,
    });
    clientConnections.push(conn);
    const port = createChannelClientPort(conn);
    const db: ClientDb = { __kind: 'client-db', type: 'firestore', port };
    return {
      port,
      auth: getClientAuth(db),
    };
  }

  beforeAll(async () => {
    if (!existsSync(childModule)) {
      throw new Error(`Functions child is not built: ${childModule}`);
    }
    fixtureDir = tempDirs.makeTempDir();
    mkdirSync(join(fixtureDir, 'public'), { recursive: true });
    mkdirSync(join(fixtureDir, 'functions-esm/node_modules'), { recursive: true });
    writeFileSync(join(fixtureDir, 'public/index.html'), '<!doctype html><body>esm</body>');
    writeFileSync(
      join(fixtureDir, 'firebase.json'),
      JSON.stringify({ hosting: { public: 'public' } }),
    );
    writeFileSync(
      join(fixtureDir, 'functions-esm/package.json'),
      JSON.stringify({
        name: 'identity-fn-esm',
        private: true,
        type: 'module',
        main: 'index.js',
      }),
    );
    writeFileSync(
      join(fixtureDir, 'functions-esm/index.js'),
      [
        "import { initializeApp, getApps } from 'firebase-admin/app';",
        "import { beforeUserCreated, HttpsError } from 'firebase-functions/v2/identity';",
        '',
        'await Promise.resolve();',
        'if (getApps().length === 0) initializeApp();',
        '',
        'export const alphaShadowedGate = beforeUserCreated(() => {',
        "  throw new HttpsError('permission-denied', 'Shadowed handler should be superseded');",
        '});',
        '',
        'export const zetaActiveGate = beforeUserCreated((event) => {',
        "  if (event.data?.email?.endsWith('@esm-blocked.test')) {",
        "    throw new HttpsError('permission-denied', 'ESM policy blocked sign-up');",
        '  }',
        "  if (event.data?.email?.endsWith('@esm-crash.test')) {",
        "    throw new Error('Unhandled database outage');",
        '  }',
        '  return {',
        "    displayName: 'ESM Approved',",
        "    customClaims: { runtime: 'esm' },",
        '  };',
        '});',
      ].join('\n'),
    );
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(fixtureDir, 'functions-esm/node_modules/firebase-functions'),
    );

    hosted = await startNodeHostedRuntime(fixtureDir, 'demo-project');
    activeChild = spawnFunctionsChild({
      cwd: join(fixtureDir, 'functions-esm'),
      entry: join(fixtureDir, 'functions-esm/index.js'),
      childModuleUrl: pathToFileURL(childModule),
      env: buildChildEnv(process.env, {
        serveUrl: hosted.url,
        registerUrl: registerModuleUrl(),
        instanceId: hosted.instanceId,
        sessionToken: hosted.sessionToken,
      }),
      instance: 'demo-project-default-rtdb',
      projectId: 'demo-project',
      location: 'us-central1',
    });
    readyPayload = await activeChild.ready;
  }, 30_000);

  afterAll(async () => {
    if (activeChild) {
      const code = await activeChild.stop();
      activeChild = undefined;
      expect(code).toBe(0);
    }
    for (const conn of clientConnections) {
      conn.close();
    }
    clientConnections.length = 0;
    if (hosted) await hosted.stop();
    tempDirs.cleanupTempDirs();
  });

  test('supersedes earlier duplicate beforeUserCreated export deterministically in ESM', () => {
    expect(readyPayload).toEqual({
      triggerCount: 1,
      unsupportedTriggers: [
        {
          exportName: 'alphaShadowedGate',
          eventType:
            'providers/cloud.auth/eventTypes/user.beforeCreate (superseded by zetaActiveGate)',
        },
      ],
    });
  });

  test('executes active ESM beforeUserCreated export with top-level await and HttpsError rejection', async () => {
    const blockedClient = await makeClientSession();
    let esmErr: (Error & { code?: string }) | undefined;
    try {
      await createUserWithEmailAndPassword(
        blockedClient.auth,
        'nope@esm-blocked.test',
        'secret123',
      );
    } catch (err) {
      esmErr = err as Error & { code?: string };
    }
    expect(esmErr?.code).toBe('auth/internal-error');
    expect(esmErr?.message).toContain('ESM policy blocked sign-up');

    const allowedClient = await makeClientSession();
    const allowedCred = await createUserWithEmailAndPassword(
      allowedClient.auth,
      'ok@esm-ok.test',
      'secret123',
    );
    expect(allowedCred.user.displayName).toBe('ESM Approved');
    expect((await allowedCred.user.getIdTokenResult()).claims.runtime).toBe('esm');
  });

  test('fails closed with INTERNAL and persists zero user record when handler throws non-HttpsError', async () => {
    const crashClient = await makeClientSession();
    let crashErr: (Error & { code?: string }) | undefined;
    try {
      await createUserWithEmailAndPassword(
        crashClient.auth,
        'oops@esm-crash.test',
        'secret123',
      );
    } catch (err) {
      crashErr = err as Error & { code?: string };
    }
    expect(crashErr?.code).toBe('auth/internal-error');
    expect(crashErr?.message).toContain('"status":"INTERNAL"');
    expect(
      (await listUsers(crashClient.auth)).find((u) => u.email === 'oops@esm-crash.test'),
    ).toBeUndefined();
  });
});
