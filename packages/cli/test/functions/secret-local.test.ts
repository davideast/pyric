import 'fake-indexeddb/auto';
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initializeSandbox } from 'pyric/sandbox';
import { buildChildEnv, registerModuleUrl } from '../../src/cli/sandbox-runner.js';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import { serializeError, type FunctionsChildEvent } from '../../src/functions/child-protocol.js';
import {
  applyFunctionsDotenv,
  loadFunctionsDotenv,
  loadFunctionsEnvAndSecrets,
  loadFunctionsSecrets,
} from '../../src/functions/dotenv.js';
import { emitExecutionFinished } from '../../src/functions/events.js';
import { recordFunctionExecution } from '../../src/functions/execution-log.js';
import { CHILD_TOKEN_HEADER } from '../../src/functions/http/child-token.js';
import {
  REDACTED_SECRET_PLACEHOLDER,
  createSecretRedactor,
  installStreamSecretRedaction,
  setActiveSecretRedactor,
} from '../../src/functions/secret-redaction.js';
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
const tempDirs = trackTempDirs('pyric-functions-secret-local-');

const activeHandles: FunctionsChildHandle[] = [];
const activePeers: Array<{ close(): Promise<void> }> = [];
const activeRuntimes: ServeRuntime[] = [];

afterEach(async () => {
  setActiveSecretRedactor(null);
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

describe('.secret.local loading and precedence', () => {
  test('loads .secret.local with highest precedence over .env, .env.<project>, and .env.local', () => {
    const projectRoot = tempDirs.makeTempDir();
    const sourceDir = join(projectRoot, 'functions');
    mkdirSync(sourceDir, { recursive: true });

    writeFileSync(
      join(sourceDir, '.env'),
      ['SHARED_KEY=from-base', 'BASE_ONLY=base-val'].join('\n'),
    );
    writeFileSync(
      join(sourceDir, '.env.demo-secrets'),
      ['SHARED_KEY=from-project', 'PROJ_ONLY=proj-val'].join('\n'),
    );
    writeFileSync(
      join(sourceDir, '.env.local'),
      ['SHARED_KEY=from-local', 'LOCAL_ONLY=local-val'].join('\n'),
    );
    writeFileSync(
      join(sourceDir, '.secret.local'),
      [
        'SHARED_KEY=synth-secret-override-9999',
        'SECRET_ONLY=synth-token-alpha-1234',
        'JSON_SECRET={"apiKey":"synth-nested-key-8888","region":"us-east1"}',
      ].join('\n'),
    );

    const both = loadFunctionsEnvAndSecrets({ sourceDir, projectId: 'demo-secrets' });
    expect(both.env).toEqual({
      SHARED_KEY: 'synth-secret-override-9999',
      BASE_ONLY: 'base-val',
      PROJ_ONLY: 'proj-val',
      LOCAL_ONLY: 'local-val',
      SECRET_ONLY: 'synth-token-alpha-1234',
      JSON_SECRET: '{"apiKey":"synth-nested-key-8888","region":"us-east1"}',
    });
    expect(both.secrets).toEqual({
      SHARED_KEY: 'synth-secret-override-9999',
      SECRET_ONLY: 'synth-token-alpha-1234',
      JSON_SECRET: '{"apiKey":"synth-nested-key-8888","region":"us-east1"}',
    });

    expect(loadFunctionsSecrets({ sourceDir })).toEqual(both.secrets);
    expect(loadFunctionsDotenv({ sourceDir, projectId: 'demo-secrets' })).toEqual(both.env);
    expect(
      loadFunctionsDotenv({ sourceDir, projectId: 'demo-secrets', includeSecrets: false }),
    ).toEqual({
      SHARED_KEY: 'from-local',
      BASE_ONLY: 'base-val',
      PROJ_ONLY: 'proj-val',
      LOCAL_ONLY: 'local-val',
    });
  });

  test('enforces credential isolation, symlink containment, and directory safety on .secret.local', () => {
    const projectRoot = tempDirs.makeTempDir();
    const sourceDir = join(projectRoot, 'functions');
    const outsideDir = tempDirs.makeTempDir();
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(outsideDir, 'escaped.secret'), 'ESCAPED_TOKEN=outside-secret-1234\n');
    symlinkSync(join(outsideDir, 'escaped.secret'), join(sourceDir, '.secret.local'));

    expect(loadFunctionsSecrets({ sourceDir })).toEqual({});

    const isolatedSourceDir = join(projectRoot, 'functions-protected');
    mkdirSync(isolatedSourceDir, { recursive: true });
    writeFileSync(
      join(isolatedSourceDir, '.secret.local'),
      [
        'VALID_SECRET=synth-valid-secret-5555',
        'GOOGLE_APPLICATION_CREDENTIALS=/fake/sa.json',
        'google_application_credentials=/fake/lower.json',
        'FIREBASE_SA_BASE64=eyJ0eXBlIjoic2VydmljZV9hY2NvdW50In0=',
        'FIREBASE_CONFIG={"projectId":"hijack"}',
        'GCLOUD_PROJECT=hijack',
        'HOME=/fake/home',
        'NODE_OPTIONS=--require /fake/hook.js',
        'PYRIC_FUNCTIONS_HTTP_TOKEN=forged',
        'X_GOOGLE_INTERNAL=1',
        'FIREBASE_DEBUG_MODE=true',
        'PORT=8888',
      ].join('\n'),
    );

    const targetEnv: NodeJS.ProcessEnv = {};
    const secrets = applyFunctionsDotenv(targetEnv, {
      sourceDir: isolatedSourceDir,
      projectId: 'demo-secrets',
    });
    expect(secrets).toEqual({ VALID_SECRET: 'synth-valid-secret-5555' });
    expect(targetEnv).toEqual({ VALID_SECRET: 'synth-valid-secret-5555' });

    const dirSecretSource = join(projectRoot, 'functions-dir-secret');
    mkdirSync(join(dirSecretSource, '.secret.local'), { recursive: true });
    expect(loadFunctionsSecrets({ sourceDir: dirSecretSource })).toEqual({});
  });
});

describe('secret redaction primitives', () => {
  test('redacts overlapping secrets longest-first, multiline escapes, and nested JSON secret leaves', () => {
    const redactor = createSecretRedactor({
      BASE: 'synth_secret',
      LONGER: 'synth_secret_extended_999',
      MULTILINE: 'line-one-secret\nline-two-secret',
      JSON_CRED: JSON.stringify({
        apiKey: 'synth_nested_api_key_777',
        enabled: true,
        tiny: 'ok',
      }),
      SHORT_FLAG: '1',
    });

    expect(redactor.hasSecrets).toBe(true);
    expect(redactor.redactString('token=synth_secret_extended_999')).toBe(
      `token=${REDACTED_SECRET_PLACEHOLDER}`,
    );
    expect(redactor.redactString('nested=synth_nested_api_key_777 status=201 ok=true')).toBe(
      `nested=${REDACTED_SECRET_PLACEHOLDER} status=201 ok=true`,
    );
    expect(redactor.redactString('raw=line-one-secret\nline-two-secret')).toBe(
      `raw=${REDACTED_SECRET_PLACEHOLDER}`,
    );
    expect(redactor.redactString('escaped=line-one-secret\\nline-two-secret')).toBe(
      `escaped=${REDACTED_SECRET_PLACEHOLDER}`,
    );

    const badJsonSecret = 'bad_secret_json_payload_9999';
    const jsonErrRedactor = createSecretRedactor({ BAD_JSON: badJsonSecret });
    let syntaxErrMsg = '';
    try {
      JSON.parse(badJsonSecret);
    } catch (error: unknown) {
      syntaxErrMsg = error instanceof Error ? error.message : String(error);
    }
    const scrubbedSyntax = jsonErrRedactor.redactString(
      `"BAD_JSON" could not be parsed as JSON. Details: SyntaxError: ${syntaxErrMsg}`,
    );
    expect(scrubbedSyntax).not.toContain('bad_secret');
    expect(scrubbedSyntax).toContain(REDACTED_SECRET_PLACEHOLDER);

    const cyclic: Record<string, unknown> = {
      secret: 'synth_nested_api_key_777',
      synth_nested_api_key_777: 'val',
      nestedErr: new Error('boom synth_nested_api_key_777'),
    };
    cyclic.self = cyclic;
    const redactedObj = redactor.redactValue(cyclic);
    expect(redactedObj.secret).toBe(REDACTED_SECRET_PLACEHOLDER);
    expect(redactedObj[REDACTED_SECRET_PLACEHOLDER]).toBe('val');
    expect(redactedObj.synth_nested_api_key_777).toBeUndefined();
    expect((redactedObj.nestedErr as Error).message).toBe(`boom ${REDACTED_SECRET_PLACEHOLDER}`);
    expect((redactedObj.nestedErr as Error).stack).not.toContain('synth_nested_api_key_777');
    expect(redactedObj.self).toBe(redactedObj);
  });

  test('redacts serializeError, sandbox execution events, execution log records, and stdout/stderr streams', () => {
    const rawSecret = 'synth_super_secret_token_4242';
    const redactor = createSecretRedactor({ API_SECRET: rawSecret });
    setActiveSecretRedactor(redactor);

    const err = new Error(`Failed auth with ${rawSecret}`);
    err.stack = `Error: Failed auth with ${rawSecret}\n    at handler (/app/index.js:10:5)`;
    const serialized = serializeError(err);
    expect(serialized.message).not.toContain(rawSecret);
    expect(serialized.message).toContain(REDACTED_SECRET_PLACEHOLDER);
    expect(serialized.stack).not.toContain(rawSecret);

    const sandbox = initializeSandbox();
    try {
      const record = recordFunctionExecution(sandbox, {
        trigger: 'leakCheck',
        ref: `/items/${rawSecret}`,
        params: { token: rawSecret },
        startedAt: 1000,
        durationMs: 12,
        status: 'rejected',
        error: `rejected with ${rawSecret}`,
      });
      expect(JSON.stringify(record)).not.toContain(rawSecret);
      expect(record.error).toContain(REDACTED_SECRET_PLACEHOLDER);

      emitExecutionFinished(sandbox, {
        trigger: 'leakFulfilled',
        ref: '/items/ok',
        params: {},
        startedAt: 1020,
        durationMs: 5,
        status: 'fulfilled',
        result: { leaked: rawSecret },
      });
      const historyJson = JSON.stringify(sandbox.history());
      expect(historyJson).not.toContain(rawSecret);
      expect(historyJson).toContain(REDACTED_SECRET_PLACEHOLDER);
    } finally {
      sandbox.dispose();
    }

    const written: string[] = [];
    const fakeStdout = {
      write(chunk: unknown): boolean {
        written.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        return true;
      },
    };
    const restore = installStreamSecretRedaction(redactor, { stdout: fakeStdout });
    fakeStdout.write(`str: ${rawSecret}\n`);
    fakeStdout.write(Buffer.from(`buf: ${rawSecret}\n`, 'utf8'));
    restore();
    fakeStdout.write(`after-restore: ${rawSecret}\n`);

    expect(written[0]).toBe(`str: ${REDACTED_SECRET_PLACEHOLDER}\n`);
    expect(written[1]).toBe(`buf: ${REDACTED_SECRET_PLACEHOLDER}\n`);
    expect(written[2]).toBe(`after-restore: ${rawSecret}\n`);
  });

  test('isolated Functions child loads .secret.local for defineSecret/defineJsonSecret without leaking secrets to stdout, stderr, or IPC events', async () => {
    const fixtureDir = tempDirs.makeTempDir();
    const sourceDir = join(fixtureDir, 'functions');
    const libDir = join(sourceDir, 'lib');
    mkdirSync(join(fixtureDir, 'public'), { recursive: true });
    mkdirSync(join(sourceDir, 'node_modules'), { recursive: true });
    mkdirSync(libDir, { recursive: true });
    writeFileSync(join(fixtureDir, 'public/index.html'), '<!doctype html><body>secrets</body>');
    writeFileSync(
      join(fixtureDir, 'firebase.json'),
      JSON.stringify({ hosting: { public: 'public' } }),
    );
    writeFileSync(
      join(sourceDir, 'package.json'),
      JSON.stringify({ name: 'secret-fn', private: true, type: 'commonjs', main: 'lib/index.cjs' }),
    );
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(sourceDir, 'node_modules/firebase-functions'),
    );

    const synthApiSecret = 'synth_api_secret_value_8192';
    const synthNestedSecret = 'synth_nested_json_secret_9311';
    const expectedHash = createHash('sha256')
      .update(`${synthApiSecret}:${synthNestedSecret}`)
      .digest('hex');

    writeFileSync(join(sourceDir, '.env.local'), 'SYNTH_API_SECRET=from-env-local-fallback\n');
    writeFileSync(
      join(sourceDir, '.secret.local'),
      [
        `SYNTH_API_SECRET=${synthApiSecret}`,
        `SYNTH_JSON_SECRET=${JSON.stringify({ apiKey: synthNestedSecret, mode: 'sandbox' })}`,
      ].join('\n'),
    );

    writeFileSync(
      join(libDir, 'index.cjs'),
      [
        "const { createHash } = require('node:crypto');",
        "const { onRequest } = require('firebase-functions/v2/https');",
        "const { defineSecret, defineJsonSecret } = require('firebase-functions/params');",
        "const apiSecret = defineSecret('SYNTH_API_SECRET');",
        "const jsonSecret = defineJsonSecret('SYNTH_JSON_SECRET');",
        "const missingSecret = defineSecret('SYNTH_MISSING_SECRET');",
        'exports.checkSecrets = onRequest({ secrets: [apiSecret, jsonSecret] }, (_req, res) => {',
        '  const raw = apiSecret.value();',
        '  const parsed = jsonSecret.value();',
        '  console.log("debug-secret:", raw, parsed.apiKey);',
        '  console.error("stderr-secret:", raw, parsed.apiKey);',
        '  setTimeout(() => { throw new Error("async-boom:" + raw + ":" + parsed.apiKey); }, 10);',
        '  const digest = createHash("sha256").update(raw + ":" + parsed.apiKey).digest("hex");',
        '  res.json({ digest, mode: parsed.mode, missingEmpty: missingSecret.value() === "" });',
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
      persistenceKeyPrefix: 'functions-secret-local',
      instanceId: 'functions-secret-local-instance',
    });
    const peer = await connectFunctionsWorkerPeer({
      url: `${runtime.handle.url.replace(/^http/, 'ws')}/__pyric/sandbox`,
      ctx,
      sandboxId: 'functions-secret-local-peer',
      cwd: fixtureDir,
    });
    activePeers.push(peer);

    const childEvents: FunctionsChildEvent[] = [];
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
      instance: 'demo-secrets-default-rtdb',
      projectId: 'demo-secrets',
      location: 'us-central1',
      onEvent: (event) => childEvents.push(event),
    });
    activeHandles.push(handle);

    let stdoutLog = '';
    let stderrLog = '';
    handle.child.stdout?.setEncoding('utf8');
    handle.child.stdout?.on('data', (chunk: string) => {
      stdoutLog += chunk;
    });
    handle.child.stderr?.setEncoding('utf8');
    handle.child.stderr?.on('data', (chunk: string) => {
      stderrLog += chunk;
    });

    const ready = await handle.ready;
    if (ready.http === undefined) {
      throw new Error('expected HTTP listener on ready child');
    }

    const response = await fetch(`http://127.0.0.1:${ready.http.port}/`, {
      headers: {
        'x-pyric-function-target': 'checkSecrets',
        [CHILD_TOKEN_HEADER]: ready.http.token,
      },
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload).toEqual({
      digest: expectedHash,
      mode: 'sandbox',
      missingEmpty: true,
    });

    const deadline = Date.now() + 3_000;
    while (
      Date.now() < deadline &&
      !childEvents.some((event) => event.type === 'uncaught-error')
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(stdoutLog).toContain(REDACTED_SECRET_PLACEHOLDER);
    expect(stdoutLog).not.toContain(synthApiSecret);
    expect(stdoutLog).not.toContain(synthNestedSecret);

    expect(stderrLog).toContain(REDACTED_SECRET_PLACEHOLDER);
    expect(stderrLog).not.toContain(synthApiSecret);
    expect(stderrLog).not.toContain(synthNestedSecret);

    const uncaught = childEvents.find((event) => event.type === 'uncaught-error');
    expect(uncaught).toBeDefined();
    const eventsJson = JSON.stringify(childEvents);
    expect(eventsJson).toContain(REDACTED_SECRET_PLACEHOLDER);
    expect(eventsJson).not.toContain(synthApiSecret);
    expect(eventsJson).not.toContain(synthNestedSecret);
  }, 20_000);

  test('startup fatal error during module load redacts .secret.local values from stderr and ready rejection', async () => {
    const fixtureDir = tempDirs.makeTempDir();
    const sourceDir = join(fixtureDir, 'functions');
    const libDir = join(sourceDir, 'lib');
    mkdirSync(join(fixtureDir, 'public'), { recursive: true });
    mkdirSync(join(sourceDir, 'node_modules'), { recursive: true });
    mkdirSync(libDir, { recursive: true });
    writeFileSync(join(fixtureDir, 'public/index.html'), '<!doctype html><body>fatal</body>');
    writeFileSync(
      join(fixtureDir, 'firebase.json'),
      JSON.stringify({ hosting: { public: 'public' } }),
    );
    writeFileSync(
      join(sourceDir, 'package.json'),
      JSON.stringify({ name: 'fatal-secret', private: true, type: 'commonjs', main: 'lib/index.cjs' }),
    );
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(sourceDir, 'node_modules/firebase-functions'),
    );

    const startupSecret = 'synth_startup_crash_secret_6420';
    writeFileSync(join(sourceDir, '.secret.local'), `BOOT_SECRET=${startupSecret}\n`);
    writeFileSync(
      join(libDir, 'index.cjs'),
      [
        "const { defineSecret } = require('firebase-functions/params');",
        "const boot = defineSecret('BOOT_SECRET');",
        'throw new Error("boot failed for " + boot.value());',
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
      persistenceKeyPrefix: 'functions-secret-fatal',
      instanceId: 'functions-secret-fatal-instance',
    });
    const peer = await connectFunctionsWorkerPeer({
      url: `${runtime.handle.url.replace(/^http/, 'ws')}/__pyric/sandbox`,
      ctx,
      sandboxId: 'functions-secret-fatal-peer',
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
      instance: 'demo-fatal-default-rtdb',
      projectId: 'demo-fatal',
      location: 'us-central1',
    });
    activeHandles.push(handle);

    let childStderr = '';
    handle.child.stderr?.setEncoding('utf8');
    handle.child.stderr?.on('data', (chunk: string) => {
      childStderr += chunk;
    });

    let caughtMessage = '';
    try {
      await handle.ready;
    } catch (error: unknown) {
      caughtMessage = error instanceof Error ? error.message : String(error);
    }
    await handle.exited;

    expect(caughtMessage).toContain(REDACTED_SECRET_PLACEHOLDER);
    expect(caughtMessage).not.toContain(startupSecret);
    expect(childStderr).toContain(REDACTED_SECRET_PLACEHOLDER);
    expect(childStderr).not.toContain(startupSecret);
  }, 20_000);
});
