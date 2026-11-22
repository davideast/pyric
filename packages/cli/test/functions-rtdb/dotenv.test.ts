import 'fake-indexeddb/auto';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildChildEnv, registerModuleUrl } from '../../src/cli/sandbox-runner.js';
import {
  isProtectedFunctionsEnvKey,
  loadFunctionsDotenv,
  parseDotenv,
  resolveFunctionsSourceDir,
} from '../../src/functions/dotenv.js';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import { CHILD_TOKEN_HEADER } from '../../src/functions/http/child-token.js';
import { spawnFunctionsChild, type FunctionsChildHandle } from '../../src/functions/spawn.js';
import { silentServeLogger } from '../../src/serve/server.js';
import { trackTempDirs } from '../use-temp-dirs.js';
import {
  connectFunctionsWorkerPeer,
  createFunctionsWorkerHostCtx,
} from './worker-peer.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const childModule = join(cliRoot, 'dist/functions/child.js');
const tempDirs = trackTempDirs('pyric-functions-dotenv-');

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

describe('Functions dotenv loader (#1939)', () => {
  test('parses dotenv syntax including quotes, escapes, multiline values, comments, export, and CRLF', () => {
    const raw = [
      '\uFEFF# Full line comment',
      'PLAIN=hello # inline comment',
      'export EXPORTED = spaced value',
      'SINGLE=\'literal \\n and # hash \\\'quote\\\'\'',
      'DOUBLE="line1\\nline2\\r\\"quoted\\"\\\\end"',
      'BACKTICK=`tick # value`',
      'MULTILINE="first line',
      'second line"',
      'EMPTY=',
    ].join('\r\n');

    expect(parseDotenv(raw)).toEqual({
      PLAIN: 'hello',
      EXPORTED: 'spaced value',
      SINGLE: 'literal \\n and # hash \'quote\'',
      DOUBLE: 'line1\nline2\r"quoted"\\end',
      BACKTICK: 'tick # value',
      MULTILINE: 'first line\nsecond line',
      EMPTY: '',
    });
  });

  test('loads .env, .env.<project>, and .env.local in Firebase precedence order and supports .firebaserc aliases', () => {
    const projectRoot = tempDirs.makeTempDir();
    const sourceDir = join(projectRoot, 'functions');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(projectRoot, '.firebaserc'),
      JSON.stringify({
        projects: {
          default: 'prod-project',
          staging: 'staging-project-id',
        },
      }),
    );

    writeFileSync(
      join(sourceDir, '.env'),
      ['ORDER=from-base', 'BASE_ONLY=base', 'PROJECT_OVERRIDE=from-base'].join('\n'),
    );
    writeFileSync(
      join(sourceDir, '.env.demo-project'),
      ['ORDER=from-project', 'PROJECT_OVERRIDE=from-project', 'PROJECT_ONLY=proj'].join('\n'),
    );
    writeFileSync(
      join(sourceDir, '.env.staging'),
      ['ALIAS_ONLY=from-staging-alias', 'PROJECT_OVERRIDE=from-alias'].join('\n'),
    );
    writeFileSync(
      join(sourceDir, '.env.local'),
      ['ORDER=from-local', 'LOCAL_ONLY=local'].join('\n'),
    );

    expect(loadFunctionsDotenv({ sourceDir, projectId: 'demo-project' })).toEqual({
      ORDER: 'from-local',
      BASE_ONLY: 'base',
      PROJECT_OVERRIDE: 'from-project',
      PROJECT_ONLY: 'proj',
      LOCAL_ONLY: 'local',
    });

    expect(loadFunctionsDotenv({ sourceDir, projectId: 'staging-project-id' })).toEqual({
      ORDER: 'from-local',
      BASE_ONLY: 'base',
      PROJECT_OVERRIDE: 'from-alias',
      ALIAS_ONLY: 'from-staging-alias',
      LOCAL_ONLY: 'local',
    });
  });

  test('refuses credential, sandbox-routing, and Firebase reserved keys in .env files (#3203, #1463)', () => {
    const projectRoot = tempDirs.makeTempDir();
    const sourceDir = join(projectRoot, 'functions');
    const outsideDir = tempDirs.makeTempDir();
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(outsideDir, 'outside.env'), 'ESCAPED_SECRET=leaked\n');

    writeFileSync(
      join(sourceDir, '.env.local'),
      [
        'SAFE_KEY=allowed',
        'GOOGLE_APPLICATION_CREDENTIALS=/tmp/prod-sa.json',
        'google_application_credentials=/tmp/lower-sa.json',
        'FIREBASE_SA_BASE64=eyJ0eXBlIjoic2VydmljZV9hY2NvdW50In0=',
        'GOOGLE_CLOUD_QUOTA_PROJECT=prod-billing',
        'GCLOUD_PROJECT=prod-project',
        'GOOGLE_CLOUD_PROJECT=prod-project',
        'GCP_PROJECT=prod-project',
        'FIREBASE_CONFIG={"projectId":"prod-project"}',
        'CLOUDSDK_CONFIG=/tmp/gcloud',
        'HOME=/tmp/home',
        'APPDATA=/tmp/appdata',
        'USERPROFILE=/tmp/profile',
        'NODE_OPTIONS=--require /tmp/evil.js',
        'PYRIC_SANDBOX=off',
        'PYRIC_FUNCTIONS_HTTP_TOKEN=forged',
        'K_SERVICE=forged-service',
        'PORT=9999',
        'X_GOOGLE_INTERNAL=1',
      ].join('\n'),
    );
    symlinkSync(join(outsideDir, 'outside.env'), join(sourceDir, '.env'));

    const loaded = loadFunctionsDotenv({ sourceDir, projectId: 'demo-project' });
    expect(loaded).toEqual({ SAFE_KEY: 'allowed' });
    expect(isProtectedFunctionsEnvKey('Google_Application_Credentials')).toBe(true);
    expect(isProtectedFunctionsEnvKey('pyric_functions_http_token')).toBe(true);
    expect(isProtectedFunctionsEnvKey('SAFE_KEY')).toBe(false);
  });

  test('resolves Functions sourceDir from nested build output entry paths', () => {
    const projectRoot = tempDirs.makeTempDir();
    const sourceDir = join(projectRoot, 'functions');
    const libDir = join(sourceDir, 'lib');
    mkdirSync(libDir, { recursive: true });
    writeFileSync(join(projectRoot, 'firebase.json'), '{}');
    writeFileSync(join(sourceDir, 'package.json'), '{"main":"lib/index.js"}');

    expect(resolveFunctionsSourceDir(join(libDir, 'index.js'))).toBe(sourceDir);
  });

  test('isolated Functions child exposes .env values to process.env and defineString() while preserving credential isolation and firebasestorage.app (#1939, #1940)', async () => {
    const fixtureDir = tempDirs.makeTempDir();
    const sourceDir = join(fixtureDir, 'functions');
    const libDir = join(sourceDir, 'lib');
    mkdirSync(join(fixtureDir, 'public'), { recursive: true });
    mkdirSync(join(sourceDir, 'node_modules'), { recursive: true });
    mkdirSync(libDir, { recursive: true });
    writeFileSync(join(fixtureDir, 'public/index.html'), '<!doctype html><body>env</body>');
    writeFileSync(join(fixtureDir, 'firebase.json'), JSON.stringify({ hosting: { public: 'public' } }));
    writeFileSync(
      join(sourceDir, 'package.json'),
      JSON.stringify({ name: 'dotenv-fn', private: true, type: 'commonjs', main: 'lib/index.cjs' }),
    );
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(sourceDir, 'node_modules/firebase-functions'),
    );

    writeFileSync(
      join(sourceDir, '.env'),
      ['GREETING=from-base', 'BASE_ONLY=alpha', 'PRECEDENCE=base'].join('\n'),
    );
    writeFileSync(
      join(sourceDir, '.env.demo-dotenv'),
      ['GREETING=hi', 'PROJECT_ONLY=bravo', 'PRECEDENCE=project'].join('\n'),
    );
    writeFileSync(
      join(sourceDir, '.env.local'),
      [
        'PRECEDENCE=local',
        'LOCAL_ONLY=charlie',
        'GOOGLE_APPLICATION_CREDENTIALS=/nonexistent/evil-sa.json',
        'FIREBASE_CONFIG={"projectId":"evil-prod","storageBucket":"evil.appspot.com"}',
      ].join('\n'),
    );

    writeFileSync(
      join(libDir, 'index.cjs'),
      [
        "const { onRequest } = require('firebase-functions/v2/https');",
        "const { onValueCreated } = require('firebase-functions/v2/database');",
        "const { setGlobalOptions, RESET_VALUE } = require('firebase-functions/v2/options');",
        "const { defineString, storageBucket } = require('firebase-functions/params');",
        'setGlobalOptions({ timeoutSeconds: 300 });',
        "const greetingParam = defineString('GREETING');",
        "const precedenceParam = defineString('PRECEDENCE');",
        "const topLevelGreeting = process.env.GREETING ?? null;",
        "exports.inheritedTimeout = onValueCreated('/inherited/{id}', () => null);",
        "exports.resetTimeout = onValueCreated({ ref: '/reset/{id}', timeoutSeconds: RESET_VALUE }, () => null);",
        "exports.explicitTimeout = onValueCreated({ ref: '/explicit/{id}', timeoutSeconds: 180 }, () => null);",
        'exports.inspectEnv = onRequest((_req, res) => {',
        '  res.json({',
        '    topLevelGreeting,',
        '    envGreeting: process.env.GREETING ?? null,',
        '    paramGreeting: greetingParam.value(),',
        '    paramPrecedence: precedenceParam.value(),',
        '    baseOnly: process.env.BASE_ONLY ?? null,',
        '    projectOnly: process.env.PROJECT_ONLY ?? null,',
        '    localOnly: process.env.LOCAL_ONLY ?? null,',
        '    storageBucketParam: storageBucket.value(),',
        '    firebaseConfig: JSON.parse(process.env.FIREBASE_CONFIG || "{}"),',
        '    gac: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? null,',
        '    gcloudProject: process.env.GCLOUD_PROJECT ?? null,',
        '  });',
        '});',
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
      persistenceKeyPrefix: 'functions-dotenv',
      instanceId: 'functions-dotenv-instance',
    });
    const peer = await connectFunctionsWorkerPeer({
      url: `${runtime.handle.url.replace(/^http/, 'ws')}/__pyric/sandbox`,
      ctx,
      sandboxId: 'functions-dotenv-peer',
      cwd: fixtureDir,
    });
    activePeers.push(peer);

    const handle = spawnFunctionsChild({
      cwd: sourceDir,
      entry: join(libDir, 'index.cjs'),
      childModuleUrl: pathToFileURL(childModule),
      env: buildChildEnv(
        {
          ...process.env,
          GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/host-sa.json',
          GCLOUD_PROJECT: 'corp-host-project',
        },
        {
          serveUrl: runtime.handle.url,
          registerUrl: registerModuleUrl(),
          instanceId: runtime.instanceId,
          sessionToken: runtime.sessionToken,
        },
      ),
      instance: 'demo-dotenv-default-rtdb',
      projectId: 'demo-dotenv',
      location: 'us-central1',
    });
    activeHandles.push(handle);

    let observedEventTimeouts: unknown = undefined;
    handle.child.on('message', (raw: unknown) => {
      if (typeof raw === 'object' && raw !== null && (raw as { type?: unknown }).type === 'ready') {
        observedEventTimeouts = (raw as { eventTimeouts?: unknown }).eventTimeouts;
      }
    });

    const ready = await handle.ready;
    expect(observedEventTimeouts).toEqual([300, null, 180]);
    if (ready.http === undefined) {
      throw new Error('expected HTTP listener on ready child');
    }

    const response = await fetch(`http://127.0.0.1:${ready.http.port}/`, {
      headers: {
        'x-pyric-function-target': 'inspectEnv',
        [CHILD_TOKEN_HEADER]: ready.http.token,
      },
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload).toEqual({
      topLevelGreeting: 'hi',
      envGreeting: 'hi',
      paramGreeting: 'hi',
      paramPrecedence: 'local',
      baseOnly: 'alpha',
      projectOnly: 'bravo',
      localOnly: 'charlie',
      storageBucketParam: 'demo-dotenv.firebasestorage.app',
      firebaseConfig: {
        projectId: 'demo-dotenv',
        databaseURL: 'https://demo-dotenv-default-rtdb.firebasedatabase.app',
        storageBucket: 'demo-dotenv.firebasestorage.app',
      },
      gac: null,
      gcloudProject: 'demo-dotenv',
    });
  }, 20_000);
});
