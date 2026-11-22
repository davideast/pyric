import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  acquireViteLiveProcessStop,
  acquireViteProcessStop,
} from '../../src/serve/vite-process-stop.js';
import { suppliedRows } from '../../src/serve/vite-supplied-rows.js';
import {
  VITE_WORKER_STOP_AI_MODE_ENV,
  VITE_WORKER_STOP_MODE_ENV,
  VITE_WORKER_STOP_PROJECT_ROOT_ENV,
  guardViteWorkerArguments,
  readViteWorkerStopEnv,
  restoreSharedViteWorkerEnv,
  type ActiveViteStopConfig,
} from '../../src/serve/vite-worker-stop.js';

const CLI_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIST_PRELOAD_URL = new URL('../../dist/serve/vite-process-stop.js', import.meta.url).href;
const FAKE_PRELOAD_URL = pathToFileURL('/app/node_modules/@pyric/cli/dist/serve/vite-process-stop.js').href;
const FAKE_PRELOAD_PATH = fileURLToPath(FAKE_PRELOAD_URL);
const FAKE_SHARE_ENV = Symbol.for('nodejs.worker_threads.SHARE_ENV');

const SANDBOX_CONFIG: ActiveViteStopConfig = {
  kind: 'sandbox',
  aiMode: 'sandbox',
  projectRoot: '/app',
};

const LIVE_CONFIG: ActiveViteStopConfig = { kind: 'live' };

describe('guardViteWorkerArguments and Vite worker env helpers', () => {
  it('injects canonical preload into NODE_OPTIONS and propagates sandbox config without mutating caller env', () => {
    const callerEnv: Record<string, string | undefined> = {
      KEEP: '1',
      [VITE_WORKER_STOP_MODE_ENV]: '',
      [VITE_WORKER_STOP_AI_MODE_ENV]: 'production',
      NODE_OPTIONS: '--require /tmp/attacker.cjs',
    };
    const [source, options] = guardViteWorkerArguments(
      '/app/worker.js',
      { env: callerEnv },
      FAKE_PRELOAD_URL,
      SANDBOX_CONFIG,
      { PATH: '/usr/bin' },
    );
    expect(source).toBe('/app/worker.js');
    expect(options.execArgv).toBeUndefined();
    const childEnv = options.env as Record<string, string | undefined>;
    expect(childEnv).not.toBe(callerEnv);
    expect(callerEnv[VITE_WORKER_STOP_MODE_ENV]).toBe('');
    expect(childEnv.KEEP).toBe('1');
    expect(childEnv[VITE_WORKER_STOP_MODE_ENV]).toBe('sandbox');
    expect(childEnv[VITE_WORKER_STOP_AI_MODE_ENV]).toBe('sandbox');
    expect(childEnv[VITE_WORKER_STOP_PROJECT_ROOT_ENV]).toBe('/app');
    expect(childEnv.NODE_OPTIONS).toBe(
      `--require ${FAKE_PRELOAD_PATH} --import ${FAKE_PRELOAD_URL} --require /tmp/attacker.cjs`,
    );
  });

  it('clones parent env when options.env is omitted or null and leaves parent env untouched', () => {
    const parentEnv: Record<string, string | undefined> = { PATH: '/usr/bin' };
    const [, omitted] = guardViteWorkerArguments('/app/w.js', undefined, FAKE_PRELOAD_URL, SANDBOX_CONFIG, parentEnv);
    const [, nulled] = guardViteWorkerArguments('/app/w.js', { env: null }, FAKE_PRELOAD_URL, LIVE_CONFIG, parentEnv);
    expect(parentEnv[VITE_WORKER_STOP_MODE_ENV]).toBeUndefined();
    expect(parentEnv.NODE_OPTIONS).toBeUndefined();

    const omittedEnv = omitted.env as Record<string, string | undefined>;
    expect(omittedEnv.PATH).toBe('/usr/bin');
    expect(omittedEnv[VITE_WORKER_STOP_MODE_ENV]).toBe('sandbox');
    expect(omittedEnv.NODE_OPTIONS).toContain(`--require ${FAKE_PRELOAD_PATH}`);

    const nulledEnv = nulled.env as Record<string, string | undefined>;
    expect(nulledEnv[VITE_WORKER_STOP_MODE_ENV]).toBe('live');
    expect(nulledEnv[VITE_WORKER_STOP_AI_MODE_ENV]).toBeUndefined();
    expect(nulledEnv[VITE_WORKER_STOP_PROJECT_ROOT_ENV]).toBeUndefined();
  });

  it('records SHARE_ENV writes and restores parentEnv cleanly on release', () => {
    const parentEnv: Record<string, string | undefined> = {
      NODE_OPTIONS: '--no-warnings',
      OTHER: 'keep',
    };
    const backup = new Map<string, string | undefined>();
    const [, options] = guardViteWorkerArguments(
      '/app/w.js',
      { env: FAKE_SHARE_ENV },
      FAKE_PRELOAD_URL,
      SANDBOX_CONFIG,
      parentEnv,
      backup,
      ['--no-warnings'],
    );
    expect(options.env).toBe(FAKE_SHARE_ENV);
    expect(options.execArgv).toEqual([
      '--require',
      FAKE_PRELOAD_PATH,
      '--import',
      FAKE_PRELOAD_URL,
      '--no-warnings',
    ]);
    expect(parentEnv[VITE_WORKER_STOP_MODE_ENV]).toBe('sandbox');
    expect(parentEnv.NODE_OPTIONS).toBe(
      `--require ${FAKE_PRELOAD_PATH} --import ${FAKE_PRELOAD_URL} --no-warnings`,
    );

    // Second SHARE_ENV write with live config must not clobber the original backup.
    guardViteWorkerArguments('/app/w.js', { env: FAKE_SHARE_ENV }, FAKE_PRELOAD_URL, LIVE_CONFIG, parentEnv, backup);
    expect(parentEnv[VITE_WORKER_STOP_MODE_ENV]).toBe('live');

    restoreSharedViteWorkerEnv(backup, parentEnv);
    expect(parentEnv[VITE_WORKER_STOP_MODE_ENV]).toBeUndefined();
    expect(parentEnv[VITE_WORKER_STOP_AI_MODE_ENV]).toBeUndefined();
    expect(parentEnv[VITE_WORKER_STOP_PROJECT_ROOT_ENV]).toBeUndefined();
    expect(parentEnv.NODE_OPTIONS).toBe('--no-warnings');
    expect(parentEnv.OTHER).toBe('keep');
    expect(backup.size).toBe(0);
  });

  it('prefixes eval source keeping use strict first, canonicalizes explicit execArgv, and snapshots getters once', () => {
    let evalReads = 0;
    let execArgvReads = 0;
    let envReads = 0;
    const trickyOptions = {
      get eval() {
        evalReads += 1;
        return evalReads === 1;
      },
      get execArgv() {
        execArgvReads += 1;
        return execArgvReads === 1 ? ['--require', '/tmp/before.cjs', '--', 'arg'] : [];
      },
      get env() {
        envReads += 1;
        return envReads === 1 ? { NODE_OPTIONS: '--import /tmp/before.mjs' } : {};
      },
    };
    const [source, options] = guardViteWorkerArguments(
      "'use strict';\nconst x = 1;",
      trickyOptions,
      FAKE_PRELOAD_URL,
      SANDBOX_CONFIG,
      {},
    );
    expect(evalReads).toBe(1);
    expect(execArgvReads).toBe(1);
    expect(envReads).toBe(1);
    expect(typeof source).toBe('string');
    const sourceText = source as string;
    expect(sourceText.startsWith("'use strict';\n")).toBe(true);
    expect(sourceText).toContain(`require(${JSON.stringify(FAKE_PRELOAD_PATH)})`);
    expect(options.eval).toBe(true);
    expect(options.execArgv).toEqual([
      '--require',
      FAKE_PRELOAD_PATH,
      '--import',
      FAKE_PRELOAD_URL,
      '--require',
      '/tmp/before.cjs',
      '--',
      'arg',
    ]);
    const childEnv = options.env as Record<string, string | undefined>;
    expect(childEnv.NODE_OPTIONS).toBe(
      `--require ${FAKE_PRELOAD_PATH} --import ${FAKE_PRELOAD_URL} --import /tmp/before.mjs`,
    );
  });

  it('readViteWorkerStopEnv parses sandbox, production AI, live, and empty envs', () => {
    expect(readViteWorkerStopEnv({})).toBeNull();
    expect(readViteWorkerStopEnv({ [VITE_WORKER_STOP_MODE_ENV]: 'invalid' })).toBeNull();
    expect(readViteWorkerStopEnv({ [VITE_WORKER_STOP_MODE_ENV]: 'live' })).toEqual({ kind: 'live' });
    expect(
      readViteWorkerStopEnv({
        [VITE_WORKER_STOP_MODE_ENV]: 'sandbox',
        [VITE_WORKER_STOP_AI_MODE_ENV]: 'production',
        [VITE_WORKER_STOP_PROJECT_ROOT_ENV]: '/proj',
      }),
    ).toEqual({ kind: 'sandbox', aiMode: 'production', projectRoot: '/proj' });
  });

  it('installs once on stand-in workerThreads, switches leases dynamically, and passes through when released', () => {
    const calls: Array<{ source: unknown; options: unknown; argCount: number }> = [];
    class FakeWorker {
      constructor(source: unknown, options?: unknown) {
        calls.push({ source, options, argCount: arguments.length });
      }
    }
    const fakeThreads: { Worker: unknown } = { Worker: FakeWorker };
    const slot: Record<symbol, unknown> = {};
    let registerActive = false;

    const releaseSandbox = acquireViteProcessStop({
      slot,
      registerHooks: () => undefined,
      registerActive: () => registerActive,
      getAiMode: () => 'sandbox',
      projectRoot: '/proj',
      write: () => undefined,
      workerThreads: fakeThreads,
      workerPreloadUrl: FAKE_PRELOAD_URL,
    });
    const Guarded = fakeThreads.Worker as new (source: unknown, options?: unknown) => object;
    expect(new Guarded('/a.js') instanceof FakeWorker).toBe(true);
    const firstEnv = (calls[0]?.options as { env?: Record<string, string> } | undefined)?.env;
    expect(firstEnv?.[VITE_WORKER_STOP_MODE_ENV]).toBe('sandbox');

    const releaseLive = acquireViteLiveProcessStop(
      suppliedRows((spec) => Object.assign(new Error(spec), { code: 'PYRIC_LIVE_REFUSED' })),
      {
        slot,
        registerHooks: () => undefined,
        registerActive: () => registerActive,
        write: () => undefined,
        workerThreads: fakeThreads,
        workerPreloadUrl: FAKE_PRELOAD_URL,
      },
    );
    new Guarded('/b.js');
    const secondEnv = (calls[1]?.options as { env?: Record<string, string> } | undefined)?.env;
    expect(secondEnv?.[VITE_WORKER_STOP_MODE_ENV]).toBe('live');

    registerActive = true;
    new Guarded('/c.js');
    expect(calls[2]).toEqual({ source: '/c.js', options: undefined, argCount: 1 });
    registerActive = false;

    releaseLive();
    releaseSandbox();
    new Guarded('/d.js');
    expect(calls[3]).toEqual({ source: '/d.js', options: undefined, argCount: 1 });
  });
});

interface WorkerProbeReport {
  readonly cjsEval: string;
  readonly cjsHoistedRequire: string;
  readonly esmEval: string;
  readonly mjsFile: string;
  readonly cjsFile: string;
  readonly dataUrl: string;
  readonly customEnvPreload: string;
  readonly nullEnv: string;
  readonly shareEnv: string;
  readonly execArgvPreload: string;
  readonly nestedWorker: string;
  readonly prodAiAllowed: string;
  readonly prodAiAdminStopped: string;
  readonly liveAdmin: string;
  readonly liveFirestore: string;
  readonly liveNested: string;
  readonly afterRelease: string;
  readonly envRestored: boolean;
}

const NODE_WORKER_PROBE = String.raw`
import { Worker, SHARE_ENV } from 'node:worker_threads';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [preloadUrl, tmpDir, cliPackageAnchor] = process.argv.slice(2);
const { acquireViteProcessStop, acquireViteLiveProcessStop } = await import(preloadUrl);
const { suppliedRows } = await import(new URL('./vite-supplied-rows.js', preloadUrl).href);
const realAdminAppUrl = pathToFileURL(createRequire(cliPackageAnchor).resolve('firebase-admin/app')).href;

function runWorker(source, options) {
  return new Promise((resolve) => {
    const w = options === undefined ? new Worker(source) : new Worker(source, options);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    w.on('message', (msg) => finish(String(msg)));
    w.on('error', (err) => finish('ERR:' + (err && err.code ? err.code : String(err))));
    w.on('exit', (code) => finish('EXIT:' + code));
  });
}

const priorNodeOptions = process.env.NODE_OPTIONS;
const priorStopMode = process.env.PYRIC_VITE_WORKER_STOP_MODE;

const attackerPreload = path.join(tmpDir, 'attacker-preload.cjs');
const mjsWorker = path.join(tmpDir, 'worker.mjs');
const cjsWorker = path.join(tmpDir, 'worker.cjs');
const nestedWorkerPath = path.join(tmpDir, 'nested.mjs');

let aiMode = 'sandbox';
const releaseSandbox = acquireViteProcessStop({
  getAiMode: () => aiMode,
  write: () => undefined,
});

const cjsEval = await runWorker(
  "const { parentPort } = require('node:worker_threads');" +
    "const { createRequire } = require('node:module');" +
    "const req = createRequire(" + JSON.stringify(cliPackageAnchor) + ");" +
    "try { req('firebase-admin/app'); parentPort.postMessage('LOADED'); }" +
    "catch (e) { parentPort.postMessage(e && e.code ? e.code : String(e)); }",
  { eval: true },
);

const cjsHoistedRequire = await runWorker(
  "function require() { return null; }" +
    "const mod = process.getBuiltinModule('node:module');" +
    "const wt = process.getBuiltinModule('node:worker_threads');" +
    "const req = mod.createRequire(" + JSON.stringify(cliPackageAnchor) + ");" +
    "try { req('firebase-admin/app'); wt.parentPort.postMessage('LOADED'); }" +
    "catch (e) { wt.parentPort.postMessage(e && e.code ? e.code : String(e)); }",
  { eval: true },
);

const esmEval = await runWorker(
  "import { parentPort } from 'node:worker_threads';" +
    "try { await import('firebase/firestore'); parentPort.postMessage('LOADED'); }" +
    "catch (e) { parentPort.postMessage(e && e.code ? e.code : String(e)); }",
  { eval: true, execArgv: ['--input-type=module'] },
);

const mjsFile = await runWorker(mjsWorker);
const cjsFile = await runWorker(cjsWorker);

const dataUrl = await runWorker(
  new URL(
    'data:text/javascript,' +
      encodeURIComponent(
        "import { parentPort } from 'node:worker_threads';" +
          "try { await import(" + JSON.stringify(realAdminAppUrl) + "); parentPort.postMessage('LOADED'); }" +
          "catch (e) { parentPort.postMessage(e && e.code ? e.code : String(e)); }",
      ),
  ),
);

const customEnvPreload = await runWorker(
  "const { parentPort } = require('node:worker_threads');" +
    "parentPort.postMessage(String(globalThis.__ATTACKER_RESULT));",
  {
    eval: true,
    env: {
      PATH: process.env.PATH,
      PYRIC_VITE_WORKER_STOP_MODE: '',
      PYRIC_VITE_WORKER_STOP_AI_MODE: 'production',
      NODE_OPTIONS: '--require ' + attackerPreload,
    },
  },
);

const nullEnv = await runWorker(mjsWorker, { env: null });
const shareEnv = await runWorker(mjsWorker, { env: SHARE_ENV });
const execArgvPreload = await runWorker(
  "const { parentPort } = require('node:worker_threads');" +
    "parentPort.postMessage(String(globalThis.__ATTACKER_RESULT));",
  {
    eval: true,
    execArgv: ['--require', attackerPreload, '--', 'ignored'],
  },
);
const nestedWorker = await runWorker(nestedWorkerPath);

aiMode = 'production';
const prodAiAllowed = await runWorker(
  "import { parentPort } from 'node:worker_threads';" +
    "try { await import('firebase/ai'); parentPort.postMessage('LOADED'); }" +
    "catch (e) { parentPort.postMessage(e && e.code ? e.code : String(e)); }",
  { eval: true, execArgv: ['--input-type=module'] },
);
const prodAiAdminStopped = await runWorker(mjsWorker);

const releaseLive = acquireViteLiveProcessStop(
  suppliedRows((specifier) => Object.assign(new Error('live refused ' + specifier), { code: 'PYRIC_LIVE_REFUSED' })),
  { write: () => undefined },
);
const liveAdmin = await runWorker(mjsWorker);
const liveFirestore = await runWorker(
  "import { parentPort } from 'node:worker_threads';" +
    "try { await import('firebase/firestore'); parentPort.postMessage('LOADED'); }" +
    "catch (e) { parentPort.postMessage(e && e.code ? e.code : String(e)); }",
  { eval: true, execArgv: ['--input-type=module'] },
);
const liveNested = await runWorker(nestedWorkerPath);

releaseLive();
releaseSandbox();

const envRestored =
  process.env.NODE_OPTIONS === priorNodeOptions &&
  process.env.PYRIC_VITE_WORKER_STOP_MODE === priorStopMode;

const afterRelease = await runWorker(mjsWorker);

process.stdout.write(
  JSON.stringify({
    cjsEval,
    cjsHoistedRequire,
    esmEval,
    mjsFile,
    cjsFile,
    dataUrl,
    customEnvPreload,
    nullEnv,
    shareEnv,
    execArgvPreload,
    nestedWorker,
    prodAiAllowed,
    prodAiAdminStopped,
    liveAdmin,
    liveFirestore,
    liveNested,
    afterRelease,
    envRestored,
  }),
);
`;

describe('standalone Vite process stop in real Node worker_threads (#1447)', () => {
  it('stops real Firebase SDK imports across eval, file, data URL, custom/null/SHARE_ENV, preload, and nested workers, then releases cleanly', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'pyric-vite-worker-stop-'));
    try {
      const cliPackageAnchor = path.join(CLI_ROOT, 'package.json');
      writeFileSync(
        path.join(tmpDir, 'attacker-preload.cjs'),
        [
          "const { createRequire } = require('node:module');",
          `const req = createRequire(${JSON.stringify(cliPackageAnchor)});`,
          "try { req('firebase-admin/app'); globalThis.__ATTACKER_RESULT = 'LOADED'; }",
          "catch (e) { globalThis.__ATTACKER_RESULT = e && e.code ? e.code : String(e); }",
        ].join('\n'),
        'utf8',
      );
      writeFileSync(
        path.join(tmpDir, 'worker.mjs'),
        [
          "import { parentPort } from 'node:worker_threads';",
          "import { createRequire } from 'node:module';",
          `const req = createRequire(${JSON.stringify(cliPackageAnchor)});`,
          "try { req('firebase-admin/app'); parentPort.postMessage('LOADED'); }",
          "catch (e) { parentPort.postMessage(e && e.code ? e.code : String(e)); }",
        ].join('\n'),
        'utf8',
      );
      writeFileSync(
        path.join(tmpDir, 'worker.cjs'),
        [
          "const { parentPort } = require('node:worker_threads');",
          "const { createRequire } = require('node:module');",
          `const req = createRequire(${JSON.stringify(cliPackageAnchor)});`,
          "try { req('firebase-admin/app'); parentPort.postMessage('LOADED'); }",
          "catch (e) { parentPort.postMessage(e && e.code ? e.code : String(e)); }",
        ].join('\n'),
        'utf8',
      );
      writeFileSync(
        path.join(tmpDir, 'nested.mjs'),
        [
          "import { Worker, parentPort } from 'node:worker_threads';",
          `const inner = new Worker(${JSON.stringify(path.join(tmpDir, 'worker.mjs'))});`,
          "inner.on('message', (msg) => parentPort.postMessage(String(msg)));",
          "inner.on('error', (err) => parentPort.postMessage('ERR:' + (err && err.code ? err.code : String(err))));",
        ].join('\n'),
        'utf8',
      );

      const probeFile = path.join(tmpDir, 'probe.mjs');
      writeFileSync(probeFile, NODE_WORKER_PROBE, 'utf8');

      const env: Record<string, string | undefined> = {
        ...process.env,
        NODE_OPTIONS: undefined,
        PYRIC_SANDBOX: undefined,
        PYRIC_VITE_WORKER_STOP_MODE: undefined,
        PYRIC_VITE_WORKER_STOP_AI_MODE: undefined,
        PYRIC_VITE_WORKER_STOP_PROJECT_ROOT: undefined,
      };
      const result = spawnSync(
        process.env.PYRIC_TEST_NODE ?? 'node',
        ['--max-old-space-size=4096', probeFile, DIST_PRELOAD_URL, tmpDir, cliPackageAnchor],
        {
          cwd: CLI_ROOT,
          env,
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      expect(result.status, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`).toBe(0);
      const report = JSON.parse(result.stdout) as WorkerProbeReport;
      expect(report).toEqual({
        cjsEval: 'PYRIC_REAL_SDK_STOPPED',
        cjsHoistedRequire: 'PYRIC_REAL_SDK_STOPPED',
        esmEval: 'PYRIC_REAL_SDK_STOPPED',
        mjsFile: 'PYRIC_REAL_SDK_STOPPED',
        cjsFile: 'PYRIC_REAL_SDK_STOPPED',
        dataUrl: 'PYRIC_REAL_SDK_STOPPED',
        customEnvPreload: 'PYRIC_REAL_SDK_STOPPED',
        nullEnv: 'PYRIC_REAL_SDK_STOPPED',
        shareEnv: 'PYRIC_REAL_SDK_STOPPED',
        execArgvPreload: 'PYRIC_REAL_SDK_STOPPED',
        nestedWorker: 'PYRIC_REAL_SDK_STOPPED',
        prodAiAllowed: 'LOADED',
        prodAiAdminStopped: 'PYRIC_REAL_SDK_STOPPED',
        liveAdmin: 'PYRIC_LIVE_REFUSED',
        liveFirestore: 'PYRIC_LIVE_REFUSED',
        liveNested: 'PYRIC_LIVE_REFUSED',
        afterRelease: 'LOADED',
        envRestored: true,
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60_000);
});
