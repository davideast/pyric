/**
 * The register's worker-thread coverage (`src/register/worker-guard.ts`, #1442).
 *
 * Node runs `--import` preloads in a worker built from a file, a `data:` URL
 * or ESM source, but not in one built from CommonJS source with `eval: true`,
 * and not in one given an `execArgv` without the import when the register came
 * from the command line. `guardWorkerArguments` closes both, and leaves every
 * other worker as the caller built it.
 */
import { describe, expect, it } from 'bun:test';
import {
  clearPinnedInheritedVariables,
  pinInheritedVariables,
} from '../../src/register/child-process-guard.js';
import { guardWorkerArguments, installWorkerGuard } from '../../src/register/worker-guard.js';

const REGISTER_URL = 'file:///app/node_modules/@pyric/cli/dist/register/index.js';
const REGISTER_PATH = '/app/node_modules/@pyric/cli/dist/register/index.js';
const PREFIX = `typeof require === 'function' && require(${JSON.stringify(REGISTER_PATH)});`;

describe('guardWorkerArguments', () => {
  it('prefixes eval source with a require of the register that ESM source skips', () => {
    const [source, options] = guardWorkerArguments('console.log(1)', { eval: true }, REGISTER_URL);
    expect(source).toBe(`${PREFIX}\nconsole.log(1)`);
    expect(options).toEqual({ eval: true });
  });

  it('matches Node truthiness for non-boolean options.eval values and freezes eval getters', () => {
    for (const truthy of [1, 'yes', 'false', {}, []]) {
      const [source] = guardWorkerArguments('console.log(1)', { eval: truthy }, REGISTER_URL);
      expect(source, String(truthy)).toBe(`${PREFIX}\nconsole.log(1)`);
    }
    for (const falsy of [false, 0, '', null, undefined, Number.NaN]) {
      const [source] = guardWorkerArguments('/app/worker.js', { eval: falsy }, REGISTER_URL);
      expect(source, String(falsy)).toBe('/app/worker.js');
    }

    let reads = 0;
    const flipping = {
      get eval() {
        reads += 1;
        return reads > 1;
      },
    };
    const [source, options] = guardWorkerArguments('/app/worker.js', flipping, REGISTER_URL);
    expect(source).toBe('/app/worker.js');
    expect(options?.eval).toBe(false);
    expect(options?.eval).toBe(false);
  });

  it('keeps a leading use strict directive first', () => {
    const [source] = guardWorkerArguments(`'use strict';\nconsole.log(1)`, { eval: true }, REGISTER_URL);
    expect(source).toBe(`'use strict';\n${PREFIX}\nconsole.log(1)`);
  });

  it('adds the register import to an explicit execArgv and places it before caller preloads', () => {
    const [, options] = guardWorkerArguments('/app/worker.js', { execArgv: ['--no-warnings'] }, REGISTER_URL);
    expect(options).toEqual({ execArgv: ['--no-warnings', '--import', REGISTER_URL] });

    const [, preloadOpts] = guardWorkerArguments(
      '/app/worker.js',
      { execArgv: ['--import', 'file:///app/early.mjs'] },
      REGISTER_URL,
    );
    expect(preloadOpts).toEqual({
      execArgv: ['--import', REGISTER_URL, '--import', 'file:///app/early.mjs'],
    });

    const [, attachedOpts] = guardWorkerArguments(
      '/app/worker.js',
      { execArgv: ['--import=file:///app/early.mjs', '--import', '@pyric/cli/register'] },
      REGISTER_URL,
    );
    expect(attachedOpts).toEqual({
      execArgv: ['--import', REGISTER_URL, '--import=file:///app/early.mjs'],
    });
  });

  it('leaves an explicit execArgv that already imports the register alone, and canonicalizes bare or filesystem register imports', () => {
    const execArgv = ['--import', REGISTER_URL];
    const [, options] = guardWorkerArguments('/app/worker.js', { execArgv }, REGISTER_URL);
    expect(options).toEqual({ execArgv: ['--import', REGISTER_URL] });

    const [, bareOpts] = guardWorkerArguments(
      '/app/worker.js',
      { execArgv: ['--import', '@pyric/cli/register'] },
      REGISTER_URL,
    );
    expect(bareOpts).toEqual({ execArgv: ['--import', REGISTER_URL] });

    const [, fsOpts] = guardWorkerArguments(
      '/app/worker.js',
      { execArgv: [`--import=${REGISTER_PATH}`] },
      REGISTER_URL,
    );
    expect(fsOpts).toEqual({ execArgv: [`--import=${REGISTER_URL}`] });
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

  it('preserves NODE_OPTIONS register import when parent loaded register via NODE_OPTIONS (URL, filesystem path, bare name, or -r/--require) and worker passes custom env', () => {
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
          NODE_OPTIONS: `--import ${REGISTER_URL}`,
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

  it('forces the sandbox for default-env and SHARE_ENV workers when parent NODE_ENV is mutated to production', () => {
    const prodParent: Record<string, string | undefined> = {
      PATH: '/bin',
      PYRIC_SANDBOX: 'local',
      NODE_ENV: 'production',
    };
    const [, defaultOpts] = guardWorkerArguments('/app/worker.js', undefined, REGISTER_URL, prodParent, true);
    expect(defaultOpts).toEqual({
      env: {
        PATH: '/bin',
        PYRIC_SANDBOX: 'local',
        NODE_ENV: 'production',
        PYRIC_SANDBOX_FORCE: '1',
      },
    });
    expect(prodParent.PYRIC_SANDBOX_FORCE).toBeUndefined();

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
    const early = '--import file:///app/early.mjs';
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
        NODE_OPTIONS: `--import ${REGISTER_URL} ${early}`,
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
        NODE_OPTIONS: `--import ${REGISTER_URL} ${early}`,
      },
    });

    const shared = Symbol('SHARE_ENV');
    const sharedParent: Record<string, string | undefined> = {
      PATH: '/bin',
      PYRIC_SANDBOX: 'local',
      NODE_OPTIONS: early,
    };
    guardWorkerArguments('/app/worker.js', { env: shared }, REGISTER_URL, sharedParent, true);
    expect(sharedParent.NODE_OPTIONS).toBe(`--import ${REGISTER_URL} ${early}`);
  });

  it('never changes the env object the caller passed', () => {
    const env = { PATH: '/usr/bin' };
    guardWorkerArguments('/app/worker.js', { env }, REGISTER_URL, { PYRIC_SANDBOX: 'local' }, true);
    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('never changes the options object the caller passed', () => {
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
    const LIVE_URL = 'file:///app/node_modules/@pyric/live/dist/register.js';

    const [, liveExecOpts] = guardWorkerArguments(
      '/app/worker.js',
      { execArgv: ['--import', '@pyric/cli/register'] },
      LIVE_URL,
      {},
      false,
    );
    expect(liveExecOpts).toEqual({
      execArgv: ['--import', LIVE_URL, '--import', '@pyric/cli/register'],
    });

    const [, sandboxExecOpts] = guardWorkerArguments(
      '/app/worker.js',
      { execArgv: ['--import', '/tmp/decoy/packages/live/dist/register/index.js'] },
      REGISTER_URL,
      { PYRIC_SANDBOX: 'local' },
      true,
    );
    expect(sandboxExecOpts).toEqual({
      execArgv: ['--import', REGISTER_URL, '--import', '/tmp/decoy/packages/live/dist/register/index.js'],
    });

    // Even when parent loaded via CLI execArgv (empty parentEnv.NODE_OPTIONS), a foreign NODE_OPTIONS in custom env is guarded.
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
        NODE_OPTIONS: `--import ${REGISTER_URL} --import @pyric/live/register`,
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
        NODE_OPTIONS: `--import ${REGISTER_URL}`,
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
        NODE_OPTIONS: `--import ${REGISTER_URL}`,
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
    expect(tamperedParent.NODE_OPTIONS).toBe(`--import ${REGISTER_URL}`);
  });
});

describe('installWorkerGuard', () => {
  class FakeWorker {
    readonly args: unknown[];
    constructor(...args: unknown[]) {
      this.args = args;
    }
  }

  it('replaces Worker with a subclass that guards its arguments', () => {
    const workerThreads: { Worker: typeof FakeWorker } = { Worker: FakeWorker };
    installWorkerGuard(REGISTER_URL, workerThreads);
    const worker = new workerThreads.Worker('console.log(1)', { eval: true });
    expect(worker).toBeInstanceOf(FakeWorker);
    expect(worker.args[0]).toBe(`${PREFIX}\nconsole.log(1)`);
  });

  it('wraps only once', () => {
    const workerThreads: { Worker: typeof FakeWorker } = { Worker: FakeWorker };
    installWorkerGuard(REGISTER_URL, workerThreads);
    const once = workerThreads.Worker;
    installWorkerGuard(REGISTER_URL, workerThreads);
    expect(workerThreads.Worker).toBe(once);
  });
});
