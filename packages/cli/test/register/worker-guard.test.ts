/**
 * The register's worker-thread coverage (`src/register/worker-guard.ts`, #1442).
 *
 * `guardWorkerArguments` and `installWorkerGuard` snapshot caller options once,
 * inject a canonical synchronous `--require` preload ahead of caller preloads
 * and `--`, guard CommonJS `eval: true` workers against hoisted `require`, and
 * propagate pinned variables and `PYRIC_SANDBOX_FORCE=1` across custom,
 * inherited (`undefined`/`null`), and `SHARE_ENV` environments.
 */
import { describe, expect, it } from 'bun:test';
import {
  clearPinnedInheritedVariables,
  pinInheritedVariables,
} from '../../src/register/child-process-guard.js';
import { guardWorkerArguments, installWorkerGuard } from '../../src/register/worker-guard.js';

const REGISTER_PATH = '/app/node_modules/@pyric/cli/dist/register/index.js';
const REGISTER_URL = `file://${REGISTER_PATH}`;
const CANONICAL_NODE_OPTIONS = `--require ${REGISTER_PATH} --import ${REGISTER_URL}`;
const CANONICAL_EXEC_ARGV = ['--require', REGISTER_PATH, '--import', REGISTER_URL];
const LIVE_URL = 'file:///app/node_modules/@pyric/live/dist/register.js';
const LIVE_EVAL_PATH = '/app/node_modules/@pyric/live/dist/register-eval-worker.js';
const LIVE_EVAL_URL = `file://${LIVE_EVAL_PATH}`;
const PREFIX = `typeof require === 'function' && require(${JSON.stringify(REGISTER_PATH)});`;

describe('guardWorkerArguments', () => {
  it('prefixes eval source with a require of the register that ESM source skips', () => {
    const [source, options] = guardWorkerArguments('console.log(1)', { eval: true }, REGISTER_URL);
    expect(source).toBe(`${PREFIX}\nconsole.log(1)`);
    expect(options).toEqual({ eval: true });
  });

  it('matches Node truthiness for non-boolean options.eval values and snapshots getters/Proxies once', () => {
    for (const truthy of [1, 'yes', 'false', {}, []]) {
      const [source, options] = guardWorkerArguments('console.log(1)', { eval: truthy }, REGISTER_URL);
      expect(source, String(truthy)).toBe(`${PREFIX}\nconsole.log(1)`);
      expect(options?.eval, String(truthy)).toBe(true);
    }
    for (const falsy of [false, 0, '', null, undefined, Number.NaN]) {
      const [source] = guardWorkerArguments('/app/worker.js', { eval: falsy }, REGISTER_URL);
      expect(source, String(falsy)).toBe('/app/worker.js');
    }

    let evalReads = 0;
    const flippingEval = {
      get eval() {
        evalReads += 1;
        return evalReads > 1;
      },
    };
    const [source, options] = guardWorkerArguments('/app/worker.js', flippingEval, REGISTER_URL);
    expect(evalReads).toBe(1);
    expect(source).toBe('/app/worker.js');
    expect(options?.eval).toBe(false);
    expect(options?.eval).toBe(false);

    let execReads = 0;
    const flippingExecArgv = {
      get execArgv() {
        execReads += 1;
        return execReads === 1 ? undefined : ['-r', '/tmp/early.cjs'];
      },
    };
    const [, snapExecOpts] = guardWorkerArguments('/app/worker.js', flippingExecArgv, REGISTER_URL);
    expect(execReads).toBe(1);
    expect(snapExecOpts?.execArgv).toBeUndefined();

    let elemReads = 0;
    const getterArray: unknown[] = [];
    Object.defineProperty(getterArray, 0, {
      enumerable: true,
      get() {
        elemReads += 1;
        return elemReads === 1 ? '--no-warnings' : '-r';
      },
    });
    const [, elemOpts] = guardWorkerArguments('/app/worker.js', { execArgv: getterArray }, REGISTER_URL);
    expect(elemReads).toBe(1);
    expect(elemOpts?.execArgv).toEqual([...CANONICAL_EXEC_ARGV, '--no-warnings']);

    let envReads = 0;
    const flippingEnv = {
      get env() {
        envReads += 1;
        return envReads === 1 ? null : { PATH: '/usr/bin', NODE_ENV: 'production' };
      },
    };
    const [, snapEnvOpts] = guardWorkerArguments('/app/worker.js', flippingEnv, REGISTER_URL, { PYRIC_SANDBOX: 'local' }, true);
    expect(envReads).toBe(1);
    expect(snapEnvOpts?.env).toBeNull();

    let proxyReads = 0;
    const proxyOpts = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'execArgv') {
            proxyReads += 1;
            return proxyReads === 1 ? undefined : ['-r', '/tmp/early.cjs'];
          }
          return undefined;
        },
      },
    );
    const [, snapProxyOpts] = guardWorkerArguments('/app/worker.js', proxyOpts, REGISTER_URL);
    expect(proxyReads).toBe(1);
    expect(snapProxyOpts?.execArgv).toBeUndefined();
  });

  it('keeps a leading use strict directive first', () => {
    const [source] = guardWorkerArguments(`'use strict';\nconsole.log(1)`, { eval: true }, REGISTER_URL);
    expect(source).toBe(`'use strict';\n${PREFIX}\nconsole.log(1)`);
  });

  it('prepends canonical register preload to explicit execArgv ahead of caller preloads and --', () => {
    const [, options] = guardWorkerArguments('/app/worker.js', { execArgv: ['--no-warnings'] }, REGISTER_URL);
    expect(options).toEqual({ execArgv: [...CANONICAL_EXEC_ARGV, '--no-warnings'] });

    const [, preloadOpts] = guardWorkerArguments(
      '/app/worker.js',
      { execArgv: ['--import', 'file:///app/early.mjs'] },
      REGISTER_URL,
    );
    expect(preloadOpts).toEqual({
      execArgv: [...CANONICAL_EXEC_ARGV, '--import', 'file:///app/early.mjs'],
    });

    const [, attachedOpts] = guardWorkerArguments(
      '/app/worker.js',
      { execArgv: ['--import=file:///app/early.mjs', '--import', '@pyric/cli/register'] },
      REGISTER_URL,
    );
    expect(attachedOpts).toEqual({
      execArgv: [...CANONICAL_EXEC_ARGV, '--import=file:///app/early.mjs'],
    });

    const [, dashDashOpts] = guardWorkerArguments(
      '/app/worker.js',
      { execArgv: ['--', '--import', REGISTER_URL] },
      REGISTER_URL,
    );
    expect(dashDashOpts).toEqual({
      execArgv: [...CANONICAL_EXEC_ARGV, '--', '--import', REGISTER_URL],
    });

    const [, requireOpts] = guardWorkerArguments(
      '/app/worker.js',
      { execArgv: ['-r', '/app/early.cjs'] },
      LIVE_URL,
      {},
      false,
      LIVE_EVAL_URL,
    );
    expect(requireOpts).toEqual({
      execArgv: ['--require', LIVE_EVAL_PATH, '-r', '/app/early.cjs'],
    });
  });

  it('deduplicates canonical, bare, and filesystem register preloads in explicit execArgv', () => {
    for (const execArgv of [
      CANONICAL_EXEC_ARGV,
      ['--import', REGISTER_URL],
      ['--import', '@pyric/cli/register'],
      [`--import=${REGISTER_PATH}`],
    ]) {
      const [, options] = guardWorkerArguments('/app/worker.js', { execArgv }, REGISTER_URL);
      expect(options).toEqual({ execArgv: CANONICAL_EXEC_ARGV });
    }
  });

  it('leaves a file worker that inherits the parent execArgv alone', () => {
    expect(guardWorkerArguments('/app/worker.js', undefined, REGISTER_URL)).toEqual(['/app/worker.js', undefined]);
    const url = new URL('file:///app/worker.js');
    expect(guardWorkerArguments(url, { workerData: 1 }, REGISTER_URL)).toEqual([url, { workerData: 1 }]);
  });

  it('copies the sandbox variables into a worker given its own env (#1621)', () => {
    const parentEnv = { PATH: '/bin', PYRIC_SANDBOX: 'local', PYRIC_SANDBOX_INSTANCE: 'abc', HOME: '/home/app' };
    const [, options] = guardWorkerArguments('/app/worker.js', { env: { PATH: '/usr/bin' } }, REGISTER_URL, parentEnv, false);
    expect(options).toEqual({ env: { PATH: '/usr/bin', PYRIC_SANDBOX: 'local', PYRIC_SANDBOX_INSTANCE: 'abc' } });
  });

  it('preserves canonical NODE_OPTIONS register preload when parent loaded register via NODE_OPTIONS and worker passes custom env', () => {
    for (const parentNodeOptions of [
      `--import ${REGISTER_URL}`,
      `--import=${REGISTER_PATH}`,
      '--import @pyric/cli/register',
      `--require ${REGISTER_PATH}`,
      `--require=${REGISTER_PATH}`,
      `-r ${REGISTER_PATH}`,
      '-r @pyric/cli/register',
      '--require=@pyric/cli/register',
    ]) {
      const parentEnv = {
        PATH: '/bin',
        PYRIC_SANDBOX: 'local',
        NODE_OPTIONS: parentNodeOptions,
      };
      const [, options] = guardWorkerArguments('/app/worker.js', { env: { PATH: '/usr/bin' } }, REGISTER_URL, parentEnv, true);
      expect(options).toEqual({
        env: {
          PATH: '/usr/bin',
          PYRIC_SANDBOX: 'local',
          PYRIC_SANDBOX_FORCE: '1',
          NODE_OPTIONS: CANONICAL_NODE_OPTIONS,
        },
      });
    }
  });

  it('keeps a sandbox variable the caller set for the worker', () => {
    const parentEnv = { PYRIC_SANDBOX: 'local', PYRIC_AI_MODE: 'sandbox' };
    const [, options] = guardWorkerArguments('/app/worker.js', { env: { PYRIC_AI_MODE: 'production' } }, REGISTER_URL, parentEnv, false);
    expect(options).toEqual({ env: { PYRIC_AI_MODE: 'production', PYRIC_SANDBOX: 'local' } });
  });

  it('forces the sandbox in a worker whose env sets NODE_ENV=production when the register is active', () => {
    const env = { NODE_ENV: 'production' };
    const [, options] = guardWorkerArguments('/app/worker.js', { env }, REGISTER_URL, { PYRIC_SANDBOX: 'local' }, true);
    expect(options).toEqual({ env: { NODE_ENV: 'production', PYRIC_SANDBOX: 'local', PYRIC_SANDBOX_FORCE: '1' } });
  });

  it('keeps a PYRIC_SANDBOX_FORCE the caller set for the worker', () => {
    const env = { PYRIC_SANDBOX_FORCE: '0' };
    const [, options] = guardWorkerArguments('/app/worker.js', { env }, REGISTER_URL, { PYRIC_SANDBOX: 'local' }, true);
    expect(options).toEqual({ env: { PYRIC_SANDBOX_FORCE: '0', PYRIC_SANDBOX: 'local' } });
  });

  it('forces the sandbox in a worker whose caller passes an empty PYRIC_SANDBOX_FORCE', () => {
    const env = { NODE_ENV: 'production', PYRIC_SANDBOX_FORCE: '' };
    const [, options] = guardWorkerArguments('/app/worker.js', { env }, REGISTER_URL, { PYRIC_SANDBOX: 'local' }, true);
    expect(options).toEqual({ env: { NODE_ENV: 'production', PYRIC_SANDBOX_FORCE: '1', PYRIC_SANDBOX: 'local' } });
  });

  it('forces the sandbox in a worker when the parent env holds PYRIC_SANDBOX_FORCE=true', () => {
    const parentEnv = { PYRIC_SANDBOX: 'local', PYRIC_SANDBOX_FORCE: 'true' };
    const [, options] = guardWorkerArguments('/app/worker.js', { env: { NODE_ENV: 'production' } }, REGISTER_URL, parentEnv, true);
    expect(options).toEqual({ env: { NODE_ENV: 'production', PYRIC_SANDBOX: 'local', PYRIC_SANDBOX_FORCE: '1' } });
  });

  it('leaves a worker that shares the parent env alone, while setting PYRIC_SANDBOX_FORCE when parent sandbox is active', () => {
    const shared = Symbol('SHARE_ENV');
    const parentEnv: Record<string, string | undefined> = { PYRIC_SANDBOX: 'local' };
    const [, options] = guardWorkerArguments('/app/worker.js', { env: shared }, REGISTER_URL, parentEnv, true);
    expect(options).toEqual({ env: shared });
    expect(parentEnv.PYRIC_SANDBOX_FORCE).toBe('1');
  });

  it('forces the sandbox for default-env, env: null, and SHARE_ENV workers when parent NODE_ENV is mutated to production', () => {
    const prodParent: Record<string, string | undefined> = {
      PATH: '/bin',
      PYRIC_SANDBOX: 'local',
      NODE_ENV: 'production',
    };
    const expectedInherited = {
      PATH: '/bin',
      PYRIC_SANDBOX: 'local',
      NODE_ENV: 'production',
      PYRIC_SANDBOX_FORCE: '1',
    };
    const [, defaultOpts] = guardWorkerArguments('/app/worker.js', undefined, REGISTER_URL, prodParent, true);
    expect(defaultOpts).toEqual({ env: expectedInherited });
    expect(prodParent.PYRIC_SANDBOX_FORCE).toBeUndefined();

    const [, nullEnvOpts] = guardWorkerArguments('/app/worker.js', { env: null }, REGISTER_URL, prodParent, true);
    expect(nullEnvOpts).toEqual({ env: expectedInherited });

    const [, inactiveOpts] = guardWorkerArguments('/app/worker.js', undefined, REGISTER_URL, prodParent, false);
    expect(inactiveOpts).toBeUndefined();

    const shared = Symbol('SHARE_ENV');
    const sharedParent: Record<string, string | undefined> = {
      PATH: '/bin',
      PYRIC_SANDBOX: 'local',
      NODE_ENV: 'production',
    };
    const [, sharedOpts] = guardWorkerArguments('/app/worker.js', { env: shared }, REGISTER_URL, sharedParent, true);
    expect(sharedOpts).toEqual({ env: shared });
    expect(sharedParent.PYRIC_SANDBOX_FORCE).toBe('1');
  });

  it('guards caller NODE_OPTIONS preloads in custom-env, default-env, and SHARE_ENV workers even when parent loaded via CLI execArgv', () => {
    const early = '-r /app/early.cjs';
    const [, customOpts] = guardWorkerArguments(
      '/app/worker.js',
      { env: { PATH: '/usr/bin', NODE_OPTIONS: early } },
      REGISTER_URL,
      { PYRIC_SANDBOX: 'local' },
      true,
    );
    expect(customOpts).toEqual({
      env: {
        PATH: '/usr/bin',
        PYRIC_SANDBOX: 'local',
        PYRIC_SANDBOX_FORCE: '1',
        NODE_OPTIONS: `${CANONICAL_NODE_OPTIONS} ${early}`,
      },
    });

    const [, defaultOpts] = guardWorkerArguments(
      '/app/worker.js',
      undefined,
      REGISTER_URL,
      { PATH: '/bin', PYRIC_SANDBOX: 'local', NODE_OPTIONS: early },
      true,
    );
    expect(defaultOpts).toEqual({
      env: {
        PATH: '/bin',
        PYRIC_SANDBOX: 'local',
        PYRIC_SANDBOX_FORCE: '1',
        NODE_OPTIONS: `${CANONICAL_NODE_OPTIONS} ${early}`,
      },
    });

    const shared = Symbol('SHARE_ENV');
    const sharedParent: Record<string, string | undefined> = {
      PATH: '/bin',
      PYRIC_SANDBOX: 'local',
      NODE_OPTIONS: early,
    };
    guardWorkerArguments('/app/worker.js', { env: shared }, REGISTER_URL, sharedParent, true);
    expect(sharedParent.NODE_OPTIONS).toBe(`${CANONICAL_NODE_OPTIONS} ${early}`);
  });

  it('never changes the env object or options object the caller passed', () => {
    const env = { PATH: '/usr/bin' };
    guardWorkerArguments('/app/worker.js', { env }, REGISTER_URL, { PYRIC_SANDBOX: 'local' }, true);
    expect(env).toEqual({ PATH: '/usr/bin' });
    const options = { eval: true, execArgv: ['--no-warnings'] };
    guardWorkerArguments('console.log(1)', options, REGISTER_URL);
    expect(options).toEqual({ eval: true, execArgv: ['--no-warnings'] });
  });

  it('enforces pinned inherited variables on custom-env, default-env tampered, and SHARE_ENV workers', () => {
    const prevProject = process.env.PYRIC_PROJECT;
    try {
      pinInheritedVariables({ PYRIC_PROJECT: 'org-alpha' });
      const [, customOpts] = guardWorkerArguments(
        '/app/worker.js',
        { env: { PYRIC_PROJECT: 'org-beta', GCLOUD_PROJECT: 'org-beta' } },
        REGISTER_URL,
        { PYRIC_PROJECT: 'org-alpha' },
        false,
      );
      expect(customOpts).toEqual({
        env: { PYRIC_PROJECT: 'org-alpha', GCLOUD_PROJECT: 'org-beta' },
      });

      const tamperedParent: Record<string, string | undefined> = { PYRIC_PROJECT: 'org-beta' };
      const [, defaultTamperedOpts] = guardWorkerArguments(
        '/app/worker.js',
        undefined,
        REGISTER_URL,
        tamperedParent,
        false,
      );
      expect(defaultTamperedOpts).toEqual({ env: { PYRIC_PROJECT: 'org-alpha' } });

      const shared = Symbol('SHARE_ENV');
      const [, sharedOpts] = guardWorkerArguments(
        '/app/worker.js',
        { env: shared },
        REGISTER_URL,
        tamperedParent,
        false,
      );
      expect(sharedOpts).toEqual({ env: shared });
      expect(tamperedParent.PYRIC_PROJECT).toBe('org-alpha');
    } finally {
      clearPinnedInheritedVariables();
      if (prevProject === undefined) delete process.env.PYRIC_PROJECT;
      else process.env.PYRIC_PROJECT = prevProject;
    }
  });

  it('injects the active register ahead of foreign preloads in execArgv and worker env NODE_OPTIONS', () => {
    const [, liveExecOpts] = guardWorkerArguments(
      '/app/worker.js',
      { execArgv: ['--import', '@pyric/cli/register'] },
      LIVE_URL,
      {},
      false,
      LIVE_EVAL_URL,
    );
    expect(liveExecOpts).toEqual({
      execArgv: ['--require', LIVE_EVAL_PATH, '--import', '@pyric/cli/register'],
    });

    const [, sandboxExecOpts] = guardWorkerArguments(
      '/app/worker.js',
      { execArgv: ['--import', '/tmp/decoy/packages/live/dist/register/index.js'] },
      REGISTER_URL,
      { PYRIC_SANDBOX: 'local' },
      true,
    );
    expect(sandboxExecOpts).toEqual({
      execArgv: [...CANONICAL_EXEC_ARGV, '--import', '/tmp/decoy/packages/live/dist/register/index.js'],
    });

    const [, workerEnvForeign] = guardWorkerArguments(
      '/app/worker.js',
      { env: { PATH: '/usr/bin', NODE_OPTIONS: '--import @pyric/live/register' } },
      REGISTER_URL,
      { PYRIC_SANDBOX: 'local' },
      true,
    );
    expect(workerEnvForeign).toEqual({
      env: {
        PATH: '/usr/bin',
        PYRIC_SANDBOX: 'local',
        PYRIC_SANDBOX_FORCE: '1',
        NODE_OPTIONS: `${CANONICAL_NODE_OPTIONS} --import @pyric/live/register`,
      },
    });
  });

  it('restores NODE_OPTIONS register preload when parent loaded via NODE_OPTIONS and later deleted or replaced it', () => {
    const [, customOpts] = guardWorkerArguments(
      '/app/worker.js',
      { env: { PATH: '/usr/bin' } },
      REGISTER_URL,
      { PYRIC_SANDBOX: 'local' },
      true,
      REGISTER_URL,
      true,
    );
    expect(customOpts).toEqual({
      env: {
        PATH: '/usr/bin',
        PYRIC_SANDBOX: 'local',
        PYRIC_SANDBOX_FORCE: '1',
        NODE_OPTIONS: CANONICAL_NODE_OPTIONS,
      },
    });

    const [, defaultOpts] = guardWorkerArguments(
      '/app/worker.js',
      undefined,
      REGISTER_URL,
      { PATH: '/bin', PYRIC_SANDBOX: 'local' },
      true,
      REGISTER_URL,
      true,
    );
    expect(defaultOpts).toEqual({
      env: {
        PATH: '/bin',
        PYRIC_SANDBOX: 'local',
        PYRIC_SANDBOX_FORCE: '1',
        NODE_OPTIONS: CANONICAL_NODE_OPTIONS,
      },
    });

    const shared = Symbol('SHARE_ENV');
    const tamperedParent: Record<string, string | undefined> = { PATH: '/bin', PYRIC_SANDBOX: 'local' };
    const [, sharedOpts] = guardWorkerArguments(
      '/app/worker.js',
      { env: shared },
      REGISTER_URL,
      tamperedParent,
      true,
      REGISTER_URL,
      true,
    );
    expect(sharedOpts).toEqual({ env: shared });
    expect(tamperedParent.NODE_OPTIONS).toBe(CANONICAL_NODE_OPTIONS);
  });
});

describe('installWorkerGuard', () => {
  class FakeWorker {
    readonly args: unknown[];
    constructor(...args: unknown[]) {
      this.args = args;
    }
  }

  it('replaces Worker with a subclass that guards eval workers with both prefix and --require execArgv', () => {
    const workerThreads: { Worker: typeof FakeWorker } = { Worker: FakeWorker };
    installWorkerGuard(REGISTER_URL, workerThreads);
    const worker = new workerThreads.Worker('console.log(1)', { eval: true });
    expect(worker).toBeInstanceOf(FakeWorker);
    expect(worker.args[0]).toBe(`${PREFIX}\nconsole.log(1)`);
    const opts = worker.args[1] as { eval?: boolean; execArgv?: unknown[] };
    expect(opts.eval).toBe(true);
    expect(opts.execArgv?.slice(0, 4)).toEqual(CANONICAL_EXEC_ARGV);
  });

  it('snapshots getter options once across GuardedWorker and super()', () => {
    const workerThreads: { Worker: typeof FakeWorker } = { Worker: FakeWorker };
    installWorkerGuard(REGISTER_URL, workerThreads);
    let execReads = 0;
    let envReads = 0;
    const worker = new workerThreads.Worker('/app/worker.js', {
      get execArgv() {
        execReads += 1;
        return execReads === 1 ? undefined : ['-r', '/tmp/early.cjs'];
      },
      get env() {
        envReads += 1;
        return envReads === 1 ? null : { PATH: '/usr/bin', NODE_ENV: 'production' };
      },
    });
    expect(execReads).toBe(1);
    expect(envReads).toBe(1);
    const opts = worker.args[1] as { execArgv?: unknown; env?: unknown };
    expect(opts.execArgv).toBeUndefined();
    expect(opts.env).toBeNull();
  });

  it('wraps only once', () => {
    const workerThreads: { Worker: typeof FakeWorker } = { Worker: FakeWorker };
    installWorkerGuard(REGISTER_URL, workerThreads);
    const once = workerThreads.Worker;
    installWorkerGuard(REGISTER_URL, workerThreads);
    expect(workerThreads.Worker).toBe(once);
  });
});
