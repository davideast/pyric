import 'fake-indexeddb/auto';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildChildEnv, registerModuleUrl } from '../../src/cli/sandbox-runner.js';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import { spawnFunctionsChild, type FunctionsChildHandle } from '../../src/functions/spawn.js';
import { silentServeLogger } from '../../src/serve/server.js';
import {
  connectFunctionsWorkerPeer,
  createFunctionsWorkerHostCtx,
} from '../functions-rtdb/worker-peer.js';
import { trackTempDirs } from '../use-temp-dirs.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const childModule = join(cliRoot, 'dist/functions/child.js');

const tempDirs = trackTempDirs('pyric-functions-params-child-');
const activeHandles: FunctionsChildHandle[] = [];
const activePeers: Array<{ close(): Promise<void> }> = [];
const activeRuntimes: ServeRuntime[] = [];

afterEach(async () => {
  for (const handle of activeHandles.splice(0)) {
    await handle.stop().catch(() => undefined);
  }
  for (const peer of activePeers.splice(0)) {
    await peer.close().catch(() => undefined);
  }
  for (const runtime of activeRuntimes.splice(0)) {
    await runtime.handle.stop().catch(() => undefined);
  }
  tempDirs.cleanupTempDirs();
});

describe('Functions child dynamic params end-to-end discovery', () => {
  test('discovers dynamic-param triggers loaded from .env files without unsupported dynamic errors', async () => {
    const fixtureDir = tempDirs.makeTempDir();
    const sourceDir = join(fixtureDir, 'functions');
    const libDir = join(sourceDir, 'lib');
    mkdirSync(join(fixtureDir, 'public'), { recursive: true });
    mkdirSync(join(sourceDir, 'node_modules'), { recursive: true });
    mkdirSync(libDir, { recursive: true });
    writeFileSync(join(fixtureDir, 'public/index.html'), '<!doctype html><body>params</body>');
    writeFileSync(
      join(fixtureDir, 'firebase.json'),
      JSON.stringify({ hosting: { public: 'public' } }),
    );
    writeFileSync(
      join(sourceDir, 'package.json'),
      JSON.stringify({ name: 'params-e2e', private: true, type: 'commonjs', main: 'lib/index.cjs' }),
    );
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(sourceDir, 'node_modules/firebase-functions'),
    );

    writeFileSync(
      join(sourceDir, '.env'),
      [
        'API_REGION=europe-west1',
        'API_TIMEOUT=150',
        'OMIT_DEBUG=true',
        'JOB_TOPIC=nightly-sync',
        'JOB_SCHEDULE=every 30 minutes',
        'JOB_TZ=UTC',
      ].join('\n'),
    );
    writeFileSync(
      join(libDir, 'index.cjs'),
      [
        "const { onRequest } = require('firebase-functions/v2/https');",
        "const { onMessagePublished } = require('firebase-functions/v2/pubsub');",
        "const { onSchedule } = require('firebase-functions/v2/scheduler');",
        "const { defineString, defineInt, defineBoolean } = require('firebase-functions/params');",
        "const apiRegion = defineString('API_REGION');",
        "const apiTimeout = defineInt('API_TIMEOUT');",
        "const omitDebug = defineBoolean('OMIT_DEBUG');",
        "const jobTopic = defineString('JOB_TOPIC');",
        "const jobSchedule = defineString('JOB_SCHEDULE');",
        "const jobTz = defineString('JOB_TZ');",
        'exports.api = onRequest({ region: apiRegion, timeoutSeconds: apiTimeout }, (_req, res) => res.json({ ok: true }));',
        'exports.debugOnly = onRequest({ omit: omitDebug }, (_req, res) => res.json({ debug: true }));',
        'exports.onJob = onMessagePublished({ topic: jobTopic, region: apiRegion }, () => undefined);',
        'exports.nightly = onSchedule({ schedule: jobSchedule, timeZone: jobTz, region: apiRegion }, () => undefined);',
      ].join('\n'),
    );

    const runtime = await startServe({
      cwd: fixtureDir,
      port: 0,
      host: '127.0.0.1',
      bridge: true,
      noCache: true,
      capture: false,
      disableAuditLog: true,
      logger: silentServeLogger(),
    });
    activeRuntimes.push(runtime);

    const ctx = await createFunctionsWorkerHostCtx({
      persistenceKeyPrefix: 'functions-params-e2e',
      instanceId: 'functions-params-e2e-instance',
    });
    const peer = await connectFunctionsWorkerPeer({
      url: `${runtime.handle.url.replace(/^http/, 'ws')}/__pyric/sandbox`,
      ctx,
      sandboxId: 'functions-params-e2e-peer',
      cwd: fixtureDir,
    });
    activePeers.push(peer);

    const handle = spawnFunctionsChild({
      cwd: sourceDir,
      entry: join(libDir, 'index.cjs'),
      childModuleUrl: pathToFileURL(childModule),
      env: buildChildEnv(process.env, {
        serveUrl: runtime.handle.url,
        registerUrl: registerModuleUrl(),
        instanceId: runtime.instanceId,
        sessionToken: runtime.sessionToken,
      }),
      instance: 'demo-params-e2e-default-rtdb',
      projectId: 'demo-params-e2e',
      location: 'us-central1',
    });
    activeHandles.push(handle);

    const ready = await handle.ready;
    expect(ready.triggerCount).toBe(2);
    expect(ready.unsupportedTriggers).toEqual([
      { exportName: 'debugOnly', eventType: 'https (omitted from emulation)' },
    ]);
    expect(ready.http?.functions).toEqual([
      {
        exportName: 'api',
        regions: ['europe-west1'],
        platform: 'gcfv2',
        privateInvoker: false,
        timeoutSeconds: 150,
      },
    ]);
  }, 20_000);
});
