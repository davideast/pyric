/**
 * The register's child-process coverage (`src/register/child-process-guard.ts`, #1618).
 *
 * A child of a registered process starts with the register in its
 * `NODE_OPTIONS` and with the parent's `PYRIC_*` variables it lacks, whatever
 * env the caller gave it.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  clearPinnedInheritedVariables,
  formatNodeOptionValue,
  guardChildEnv,
  guardEnvPairs,
  guardSpawnOptions,
  guardSyncArguments,
  hasForeignRegisterPreload,
  hasPreloadBeforeRegister,
  hasPreloadBeforeRegisterTokens,
  hasSandboxRegisterAheadOfLive,
  installChildProcessGuard,
  isSandboxParent,
  loadsRegister,
  pinInheritedVariables,
  withCanonicalRegisterExecArgv,
  withCanonicalRegisterNodeOptions,
} from '../../src/register/child-process-guard.js';

/** The marks `activation.ts` sets when the sandbox register or the live register activates. */
const SANDBOX_MARK = Symbol.for('pyric.register.active');
const LIVE_MARK = Symbol.for('pyric.register.live.active');
const marks = globalThis as unknown as Record<symbol, unknown>;

function clearMarks(): void {
  delete marks[SANDBOX_MARK];
  delete marks[LIVE_MARK];
}

const REGISTER_PATH = '/app/node_modules/@pyric/cli/dist/register/index.js';
const REGISTER_URL = `file://${REGISTER_PATH}`;
const IMPORT = `--import ${REGISTER_URL}`;
const CANONICAL = `--require ${REGISTER_PATH} --import ${REGISTER_URL}`;
const LIVE_URL = 'file:///app/node_modules/@pyric/live/dist/register.js';
const LIVE_EVAL_PATH = '/app/node_modules/@pyric/live/dist/register-eval-worker.js';
const LIVE_EVAL_URL = `file://${LIVE_EVAL_PATH}`;
const LIVE_IMPORT = `--import ${LIVE_URL}`;
const LIVE_REQUIRE = `--require ${LIVE_EVAL_PATH}`;
const PARENT = { PATH: '/bin', PYRIC_SANDBOX: 'remote:http://127.0.0.1:4000', PYRIC_AI_MODE: 'sandbox', HOME: '/home/a' };

describe('guardChildEnv', () => {
  it('adds the register and the parent sandbox to an env of only PATH', () => {
    expect(guardChildEnv({ PATH: '/usr/bin' }, PARENT, REGISTER_URL)).toEqual({
      PATH: '/usr/bin',
      PYRIC_SANDBOX: 'remote:http://127.0.0.1:4000',
      PYRIC_AI_MODE: 'sandbox',
      NODE_OPTIONS: CANONICAL,
    });
  });

  it('prepends canonical register preload ahead of caller NODE_OPTIONS', () => {
    const env = guardChildEnv({ ...PARENT, NODE_OPTIONS: '--max-old-space-size=4096' }, PARENT, REGISTER_URL);
    expect(env.NODE_OPTIONS).toBe(`${CANONICAL} --max-old-space-size=4096`);
  });

  it('canonicalizes own preloads (--import and -r/--require) and injects active register ahead of foreign and caller preloads', () => {
    expect(guardChildEnv({ NODE_OPTIONS: CANONICAL }, PARENT, REGISTER_URL).NODE_OPTIONS).toBe(CANONICAL);
    expect(guardChildEnv({ NODE_OPTIONS: IMPORT }, PARENT, REGISTER_URL).NODE_OPTIONS).toBe(CANONICAL);
    expect(guardChildEnv({ NODE_OPTIONS: '--import @pyric/cli/register' }, PARENT, REGISTER_URL).NODE_OPTIONS).toBe(
      CANONICAL,
    );
    expect(
      guardChildEnv({ NODE_OPTIONS: '--import=@pyric/cli/register --no-warnings' }, PARENT, REGISTER_URL).NODE_OPTIONS,
    ).toBe(`${CANONICAL} --no-warnings`);
    expect(
      guardChildEnv(
        { NODE_OPTIONS: `--import=${REGISTER_PATH} --no-warnings` },
        PARENT,
        REGISTER_URL,
      ).NODE_OPTIONS,
    ).toBe(`${CANONICAL} --no-warnings`);
    expect(guardChildEnv({ NODE_OPTIONS: '-r @pyric/cli/register' }, PARENT, REGISTER_URL).NODE_OPTIONS).toBe(CANONICAL);
    expect(guardChildEnv({ NODE_OPTIONS: '--require=@pyric/cli/register' }, PARENT, REGISTER_URL).NODE_OPTIONS).toBe(
      CANONICAL,
    );
    for (const foreign of [
      '--import @pyric/live/register',
      '--import=@pyric/live/register',
      `--import ${LIVE_URL}`,
      '-r @pyric/live/register',
      '--import /tmp/decoy/packages/live/dist/register/index.js',
    ]) {
      expect(guardChildEnv({ NODE_OPTIONS: foreign }, PARENT, REGISTER_URL).NODE_OPTIONS).toBe(`${CANONICAL} ${foreign}`);
    }
    for (const foreign of [
      '--import @pyric/cli/register',
      '--import=@pyric/cli/register',
      IMPORT,
      '-r @pyric/cli/register',
      '--import /tmp/decoy/packages/cli/dist/register/index.js',
    ]) {
      expect(guardChildEnv({ NODE_OPTIONS: foreign }, PARENT, LIVE_URL).NODE_OPTIONS).toBe(`${LIVE_IMPORT} ${foreign}`);
      expect(guardChildEnv({ NODE_OPTIONS: foreign }, PARENT, LIVE_URL, false, LIVE_EVAL_URL).NODE_OPTIONS).toBe(
        `${LIVE_REQUIRE} ${foreign}`,
      );
    }
    expect(
      guardChildEnv(
        { NODE_OPTIONS: '--import @pyric/live/register --import @pyric/cli/register' },
        PARENT,
        REGISTER_URL,
      ).NODE_OPTIONS,
    ).toBe(`${CANONICAL} --import @pyric/live/register`);
    expect(
      guardChildEnv(
        { NODE_OPTIONS: '--import @pyric/cli/register --import @pyric/live/register' },
        PARENT,
        LIVE_URL,
        false,
        LIVE_EVAL_URL,
      ).NODE_OPTIONS,
    ).toBe(`${LIVE_REQUIRE} --import @pyric/cli/register`);
    expect(
      guardChildEnv({ NODE_OPTIONS: '--import @pyric/live/register' }, PARENT, LIVE_URL, false, LIVE_EVAL_URL)
        .NODE_OPTIONS,
    ).toBe(LIVE_REQUIRE);
    expect(
      guardChildEnv(
        { NODE_OPTIONS: '--no-warnings --import=file:///app/custom-register.mjs --import @pyric/cli/register' },
        PARENT,
        REGISTER_URL,
      ).NODE_OPTIONS,
    ).toBe(`${CANONICAL} --no-warnings --import=file:///app/custom-register.mjs`);
    expect(
      guardChildEnv(
        { NODE_OPTIONS: '--require file:///app/early.cjs' },
        PARENT,
        REGISTER_URL,
      ).NODE_OPTIONS,
    ).toBe(`${CANONICAL} --require file:///app/early.cjs`);
    expect(
      guardChildEnv(
        { NODE_OPTIONS: '-r file:///app/early.cjs --import @pyric/live/register' },
        PARENT,
        LIVE_URL,
        false,
        LIVE_EVAL_URL,
      ).NODE_OPTIONS,
    ).toBe(`${LIVE_REQUIRE} -r file:///app/early.cjs`);
  });

  it('quotes filesystem paths containing spaces or quotes in NODE_OPTIONS and stays idempotent', () => {
    const spacedUrl = 'file:///app/my%20dir/dist/register/index.js';
    const spacedPath = '/app/my dir/dist/register/index.js';
    expect(formatNodeOptionValue(spacedPath)).toBe(`"${spacedPath}"`);
    const once = withCanonicalRegisterNodeOptions('--no-warnings', spacedUrl);
    expect(once).toBe(`--require "${spacedPath}" --import ${spacedUrl} --no-warnings`);
    expect(withCanonicalRegisterNodeOptions(once, spacedUrl)).toBe(once);
    expect(loadsRegister(once, spacedUrl)).toBe(true);
  });

  it('stops preload parsing at -- in execArgv and places canonical register preload ahead of --', () => {
    expect(withCanonicalRegisterExecArgv(['--'], REGISTER_URL)).toEqual([
      '--require',
      REGISTER_PATH,
      '--import',
      REGISTER_URL,
      '--',
    ]);
    expect(withCanonicalRegisterExecArgv(['--', '--import', REGISTER_URL], REGISTER_URL)).toEqual([
      '--require',
      REGISTER_PATH,
      '--import',
      REGISTER_URL,
      '--',
      '--import',
      REGISTER_URL,
    ]);
    expect(withCanonicalRegisterExecArgv(['-r', 'early.cjs', '--', 'script-arg'], LIVE_URL, LIVE_EVAL_URL)).toEqual([
      '--require',
      LIVE_EVAL_PATH,
      '-r',
      'early.cjs',
      '--',
      'script-arg',
    ]);
    expect(hasPreloadBeforeRegisterTokens(['--', '-r', 'early.cjs'], REGISTER_URL)).toBe(false);
    expect(hasSandboxRegisterAheadOfLive('', ['--', '--import', REGISTER_URL], REGISTER_URL)).toBe(false);
  });

  it('detects any preload scheduled ahead of the active register across both --require and --import phases', () => {
    expect(hasPreloadBeforeRegister('', REGISTER_URL)).toBe(false);
    expect(hasPreloadBeforeRegister('--max-old-space-size=4096', REGISTER_URL)).toBe(false);
    expect(hasPreloadBeforeRegister(`${CANONICAL} -r file:///app/early.cjs`, REGISTER_URL)).toBe(false);
    expect(hasPreloadBeforeRegister(`${IMPORT} --import file:///app/custom.mjs`, REGISTER_URL)).toBe(false);
    expect(hasPreloadBeforeRegister('--import @pyric/cli/register --import file:///app/custom.mjs', REGISTER_URL)).toBe(
      false,
    );
    // `-r` runs before `--import` even when placed after `--import <register>`.
    expect(hasPreloadBeforeRegister(`${IMPORT} -r file:///app/early.cjs`, REGISTER_URL)).toBe(true);
    expect(hasPreloadBeforeRegisterTokens(['--import', REGISTER_URL, '-r', 'file:///app/early.cjs'], REGISTER_URL)).toBe(
      true,
    );
    expect(hasPreloadBeforeRegister('--import file:///app/custom.mjs', REGISTER_URL)).toBe(true);
    expect(hasPreloadBeforeRegister('--import=file:///app/custom.mjs', REGISTER_URL)).toBe(true);
    expect(hasPreloadBeforeRegister('--import file:///app/custom.mjs --import @pyric/cli/register', REGISTER_URL)).toBe(
      true,
    );
    expect(hasPreloadBeforeRegister('-r file:///app/early.cjs', REGISTER_URL)).toBe(true);
    expect(hasPreloadBeforeRegisterTokens(['--no-warnings'], REGISTER_URL)).toBe(false);
    expect(
      hasPreloadBeforeRegisterTokens(['--require', REGISTER_PATH, '-r', 'file:///app/early.cjs'], REGISTER_URL),
    ).toBe(false);
    expect(
      hasPreloadBeforeRegisterTokens(['--import', REGISTER_URL, '--import', 'file:///app/early.mjs'], REGISTER_URL),
    ).toBe(false);
    expect(
      hasPreloadBeforeRegisterTokens(['--import', 'file:///app/early.mjs', '--import', REGISTER_URL], REGISTER_URL),
    ).toBe(true);
  });

  it('recognizes only the active register in loadsRegister and distinguishes foreign preloads and preload order', () => {
    expect(loadsRegister(IMPORT, REGISTER_URL)).toBe(true);
    expect(loadsRegister(`--import=${REGISTER_PATH}`, REGISTER_URL)).toBe(true);
    expect(loadsRegister(`--import "${REGISTER_PATH}"`, REGISTER_URL)).toBe(true);
    expect(loadsRegister('--import @pyric/cli/register', REGISTER_URL)).toBe(true);
    expect(loadsRegister('-r @pyric/cli/register', REGISTER_URL)).toBe(true);
    expect(loadsRegister(`--require ${REGISTER_PATH}`, REGISTER_URL)).toBe(true);
    expect(loadsRegister(`--require=${REGISTER_PATH}`, REGISTER_URL)).toBe(true);
    expect(loadsRegister(`--require ${LIVE_EVAL_PATH}`, LIVE_URL, LIVE_EVAL_URL)).toBe(true);
    expect(loadsRegister('--import @pyric/live/register', REGISTER_URL)).toBe(false);
    expect(loadsRegister(`--import ${LIVE_URL}`, REGISTER_URL)).toBe(false);
    expect(loadsRegister('--import /tmp/decoy/packages/live/dist/register/index.js', REGISTER_URL)).toBe(false);
    expect(loadsRegister('--import /tmp/decoy/packages/cli/dist/register/index.js', REGISTER_URL)).toBe(false);
    expect(loadsRegister('--import @pyric/cli/register', LIVE_URL)).toBe(false);
    expect(loadsRegister('--import @pyric/live/register', LIVE_URL)).toBe(true);
    expect(loadsRegister('--import file:///app/custom-register.mjs', REGISTER_URL)).toBe(false);
    expect(loadsRegister('--import tsx/register', REGISTER_URL)).toBe(false);
    expect(loadsRegister('-r tsx/cjs', REGISTER_URL)).toBe(false);

    expect(hasForeignRegisterPreload('--import @pyric/live/register', REGISTER_URL)).toBe(true);
    expect(hasForeignRegisterPreload(`-r ${LIVE_EVAL_PATH}`, REGISTER_URL)).toBe(true);
    expect(hasForeignRegisterPreload('--import @pyric/cli/register', LIVE_URL)).toBe(true);
    expect(hasForeignRegisterPreload('--import @pyric/cli/register', REGISTER_URL)).toBe(false);
    expect(hasForeignRegisterPreload('--import file:///app/custom-register.mjs', REGISTER_URL)).toBe(false);

    expect(hasSandboxRegisterAheadOfLive(`${CANONICAL} -r ${LIVE_EVAL_PATH}`, [], REGISTER_URL)).toBe(true);
    expect(hasSandboxRegisterAheadOfLive(`${IMPORT} -r ${LIVE_EVAL_PATH}`, [], REGISTER_URL)).toBe(true);
    expect(hasSandboxRegisterAheadOfLive(`${LIVE_REQUIRE} -r @pyric/cli/register`, [], REGISTER_URL)).toBe(false);
    expect(hasSandboxRegisterAheadOfLive(`--import ${LIVE_URL} --import @pyric/cli/register`, [], REGISTER_URL)).toBe(
      false,
    );
    expect(hasSandboxRegisterAheadOfLive('', ['--import', REGISTER_URL, '-r', LIVE_EVAL_PATH], REGISTER_URL)).toBe(
      true,
    );
  });

  it('keeps a PYRIC_ variable the caller set, fills PYRIC_SANDBOX when empty, and preserves an explicit empty PYRIC_GUARD_ALLOW (#1652)', () => {
    const parentWithAllow = { ...PARENT, PYRIC_GUARD_ALLOW: 'example.com' };
    const env = guardChildEnv(
      { PYRIC_AI_MODE: 'production', PYRIC_SANDBOX: '', PYRIC_GUARD_ALLOW: '' },
      parentWithAllow,
      REGISTER_URL,
    );
    expect(env.PYRIC_AI_MODE).toBe('production');
    expect(env.PYRIC_SANDBOX).toBe('remote:http://127.0.0.1:4000');
    expect(env.PYRIC_GUARD_ALLOW).toBe('');

    const inheritedAllow = guardChildEnv({ PATH: '/usr/bin' }, parentWithAllow, REGISTER_URL);
    expect(inheritedAllow.PYRIC_GUARD_ALLOW).toBe('example.com');

    const pairs = guardEnvPairs(['PATH=/usr/bin', 'PYRIC_GUARD_ALLOW='], parentWithAllow, REGISTER_URL);
    expect(pairs).toContain('PYRIC_GUARD_ALLOW=');
    expect(pairs).not.toContain('PYRIC_GUARD_ALLOW=example.com');
  });

  it('unfolds Next 15 merged --import and --require values in NODE_OPTIONS (#1470)', () => {
    const userImport = 'file:///app/user-preload.mjs';
    const userRequire = '/app/safety-preload.cjs';
    const spacedUserImport = '/app/my dir/user-preload.mjs';

    const foldedSpaceImport = `--require=${REGISTER_PATH} --import="${REGISTER_URL} ${userImport}" --enable-source-maps`;
    expect(loadsRegister(foldedSpaceImport, REGISTER_URL)).toBe(true);
    expect(withCanonicalRegisterNodeOptions(foldedSpaceImport, REGISTER_URL)).toBe(
      `${CANONICAL} --import ${userImport} --enable-source-maps`,
    );

    const foldedEqualsImport = `--require=${REGISTER_PATH} --import="${userImport} ${REGISTER_URL}"`;
    expect(loadsRegister(foldedEqualsImport, REGISTER_URL)).toBe(true);
    expect(withCanonicalRegisterNodeOptions(foldedEqualsImport, REGISTER_URL)).toBe(
      `${CANONICAL} --import ${userImport}`,
    );

    const foldedSpacedImport = `--import="${REGISTER_URL} ${spacedUserImport}"`;
    expect(withCanonicalRegisterNodeOptions(foldedSpacedImport, REGISTER_URL)).toBe(
      `${CANONICAL} --import "${spacedUserImport}"`,
    );

    const foldedRequire = `--require="${REGISTER_PATH} ${userRequire}" --import=${REGISTER_URL}`;
    expect(withCanonicalRegisterNodeOptions(foldedRequire, REGISTER_URL)).toBe(
      `${CANONICAL} --require ${userRequire}`,
    );

    const foldedReverseRequire = `--require="${userRequire} ${REGISTER_PATH}"`;
    expect(withCanonicalRegisterNodeOptions(foldedReverseRequire, REGISTER_URL)).toBe(
      `${CANONICAL} --require ${userRequire}`,
    );
  });

  it('copies no other parent variable and never changes the caller env', () => {
    const childEnv = { PATH: '/usr/bin' };
    const env = guardChildEnv(childEnv, PARENT, REGISTER_URL);
    expect(env.HOME).toBeUndefined();
    expect(childEnv).toEqual({ PATH: '/usr/bin' });
  });
});

describe('guardChildEnv in a parent the sandbox register is active in (#2340)', () => {
  it('forces the sandbox in a child whose env sets NODE_ENV=production', () => {
    const env = guardChildEnv({ PATH: '/usr/bin', NODE_ENV: 'production' }, PARENT, REGISTER_URL, true);
    expect(env).toEqual({
      PATH: '/usr/bin',
      NODE_ENV: 'production',
      PYRIC_SANDBOX: 'remote:http://127.0.0.1:4000',
      PYRIC_AI_MODE: 'sandbox',
      PYRIC_SANDBOX_FORCE: '1',
      NODE_OPTIONS: CANONICAL,
    });
  });

  it('keeps a PYRIC_SANDBOX_FORCE the caller set for the child', () => {
    const env = guardChildEnv({ NODE_ENV: 'production', PYRIC_SANDBOX_FORCE: '0' }, PARENT, REGISTER_URL, true);
    expect(env.PYRIC_SANDBOX_FORCE).toBe('0');
  });

  it('snapshots caller env getters once when checking PYRIC_SANDBOX_FORCE', () => {
    let reads = 0;
    const getterEnv = {
      NODE_ENV: 'production',
      get PYRIC_SANDBOX_FORCE() {
        reads += 1;
        return reads === 1 ? '' : '0';
      },
    };
    const env = guardChildEnv(getterEnv, PARENT, REGISTER_URL, true);
    expect(reads).toBe(1);
    expect(env.PYRIC_SANDBOX_FORCE).toBe('1');
  });

  it('forces the sandbox when the parent env holds a force value other than 1', () => {
    for (const value of ['true', '']) {
      const parent = { ...PARENT, PYRIC_SANDBOX_FORCE: value };
      const env = guardChildEnv({ PATH: '/usr/bin', NODE_ENV: 'production' }, parent, REGISTER_URL, true);
      expect(env.PYRIC_SANDBOX_FORCE).toBe('1');
    }
  });

  it('forces the sandbox when the caller passes an empty PYRIC_SANDBOX_FORCE', () => {
    const env = guardChildEnv({ NODE_ENV: 'production', PYRIC_SANDBOX_FORCE: '' }, PARENT, REGISTER_URL, true);
    expect(env.PYRIC_SANDBOX_FORCE).toBe('1');
  });

  it('adds no force when the parent is not an active sandbox', () => {
    const env = guardChildEnv({ NODE_ENV: 'production' }, PARENT, REGISTER_URL, false);
    expect(env.PYRIC_SANDBOX_FORCE).toBeUndefined();
  });
});

describe('isSandboxParent', () => {
  afterEach(clearMarks);

  it('is true only when the sandbox register is active and the live register is not', () => {
    expect(isSandboxParent()).toBe(false);
    marks[SANDBOX_MARK] = true;
    expect(isSandboxParent()).toBe(true);
    marks[LIVE_MARK] = true;
    expect(isSandboxParent()).toBe(false);
    delete marks[SANDBOX_MARK];
    expect(isSandboxParent()).toBe(false);
  });
});

describe('guardEnvPairs', () => {
  it('guards the NAME=value pairs ChildProcess.prototype.spawn takes, keeping = in values', () => {
    const pairs = guardEnvPairs(['PATH=/usr/bin', 'A=b=c', 'NODE_OPTIONS=--max-old-space-size=4096'], PARENT, REGISTER_URL);
    expect(pairs).toEqual([
      'PATH=/usr/bin',
      'A=b=c',
      `NODE_OPTIONS=${CANONICAL} --max-old-space-size=4096`,
      'PYRIC_SANDBOX=remote:http://127.0.0.1:4000',
      'PYRIC_AI_MODE=sandbox',
    ]);
  });
});

describe('guardSpawnOptions', () => {
  it('guards envPairs and leaves options without them, as Bun passes, alone', () => {
    const guarded = guardSpawnOptions({ file: 'node', envPairs: ['PATH=/usr/bin'] }, REGISTER_URL) as { envPairs: string[] };
    expect(guarded.envPairs).toContain(`NODE_OPTIONS=${CANONICAL}`);
    const bunOptions = { file: 'node', env: { PATH: '/usr/bin' } };
    expect(guardSpawnOptions(bunOptions, REGISTER_URL)).toBe(bunOptions);
  });
});

describe('guardSyncArguments', () => {
  const guarded = { ...PARENT, NODE_OPTIONS: CANONICAL };

  it('adds options with the parent env when a call names none', () => {
    expect(guardSyncArguments(true, ['node'], PARENT, REGISTER_URL)).toEqual(['node', { env: guarded }]);
    expect(guardSyncArguments(true, ['node', ['a.js']], PARENT, REGISTER_URL)).toEqual(['node', ['a.js'], { env: guarded }]);
    expect(guardSyncArguments(false, ['node a.js'], PARENT, REGISTER_URL)).toEqual(['node a.js', { env: guarded }]);
  });

  it('finds options with or without args, and after a null args', () => {
    const options = { cwd: '/app', env: { PATH: '/usr/bin' } };
    const env = { PATH: '/usr/bin', PYRIC_SANDBOX: PARENT.PYRIC_SANDBOX, PYRIC_AI_MODE: 'sandbox', NODE_OPTIONS: CANONICAL };
    expect(guardSyncArguments(true, ['node', options], PARENT, REGISTER_URL)).toEqual(['node', { cwd: '/app', env }]);
    expect(guardSyncArguments(true, ['node', null, options], PARENT, REGISTER_URL)).toEqual(['node', null, { cwd: '/app', env }]);
    expect(guardSyncArguments(false, ['node a.js', options], PARENT, REGISTER_URL)).toEqual(['node a.js', { cwd: '/app', env }]);
    expect(options).toEqual({ cwd: '/app', env: { PATH: '/usr/bin' } });
  });
});

describe('installChildProcessGuard', () => {
  function standIn() {
    const calls: unknown[][] = [];
    class ChildProcess {
      spawn(options: unknown): unknown {
        calls.push(['spawn', options]);
        return this;
      }
    }
    const record = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); };
    return {
      calls,
      module: { ChildProcess, spawnSync: record('spawnSync'), execSync: record('execSync'), execFileSync: record('execFileSync') },
    };
  }

  it('guards async spawns and the sync exports, once', () => {
    const { calls, module } = standIn();
    installChildProcessGuard(REGISTER_URL, module);
    const wrapped = module.spawnSync;
    installChildProcessGuard(REGISTER_URL, module);
    expect(module.spawnSync).toBe(wrapped);

    new module.ChildProcess().spawn({ file: 'node', envPairs: ['PATH=/usr/bin'] });
    (module.execSync as (command: string) => void)('node a.js');
    const [spawnCall, execCall] = calls as [[string, { envPairs: string[] }], [string, string, { env: Record<string, string> }]];
    expect(spawnCall[1].envPairs).toContain(`NODE_OPTIONS=${CANONICAL}`);
    expect(execCall[2].env.NODE_OPTIONS).toContain(CANONICAL);
  });

  it('threads syncRegisterUrl into live child process spawns', () => {
    const { calls, module } = standIn();
    installChildProcessGuard(LIVE_URL, module, LIVE_EVAL_URL);
    new module.ChildProcess().spawn({ file: 'node', envPairs: ['PATH=/usr/bin'] });
    (module.spawnSync as (cmd: string, args: string[], opts: unknown) => void)('node', ['-r', 'early.cjs'], {
      env: { PATH: '/usr/bin' },
    });
    const [spawnCall, syncCall] = calls as [
      [string, { envPairs: string[] }],
      [string, string, string[], { env: Record<string, string> }],
    ];
    expect(spawnCall[1].envPairs).toContain(`NODE_OPTIONS=${LIVE_REQUIRE}`);
    expect(syncCall[3].env.NODE_OPTIONS).toBe(LIVE_REQUIRE);
  });

  it('refuses bun, bunx, and deno child processes with PYRIC_UNSUPPORTED_RUNTIME (#1652)', () => {
    const { calls, module } = standIn();
    installChildProcessGuard(REGISTER_URL, module);
    const expectUnsupported = (fn: () => void): void => {
      let caught: (Error & { code?: string }) | undefined;
      try {
        fn();
      } catch (error) {
        caught = error as Error & { code?: string };
      }
      expect(caught?.code).toBe('PYRIC_UNSUPPORTED_RUNTIME');
      expect(caught?.message).toContain('@pyric/cli/register: stopped before starting');
    };

    expectUnsupported(() => {
      new module.ChildProcess().spawn({ file: '/usr/local/bin/bun', args: ['my-proc', 'probe.mjs'], envPairs: [] });
    });
    expectUnsupported(() => {
      new module.ChildProcess().spawn({ file: '/bin/sh', args: ['/bin/sh', '-c', 'bun probe.mjs'], envPairs: [] });
    });
    expectUnsupported(() => {
      (module.spawnSync as (cmd: string, args: string[]) => void)('bun', ['probe.mjs']);
    });
    expectUnsupported(() => {
      (module.execFileSync as (cmd: string, args: string[]) => void)('bunx', ['tsx', 'probe.ts']);
    });
    expectUnsupported(() => {
      (module.execSync as (cmd: string) => void)('deno run probe.ts');
    });
    expect(calls).toEqual([]);
  });

  describe('with the register marks set', () => {
    afterEach(clearMarks);

    /** The env an async spawn and an execSync got, from a child env with NODE_ENV=production. */
    function childEnvs(): { spawned: string[]; executed: Record<string, string> } {
      const { calls, module } = standIn();
      installChildProcessGuard(REGISTER_URL, module);
      new module.ChildProcess().spawn({ file: 'node', envPairs: ['PATH=/usr/bin', 'NODE_ENV=production'] });
      (module.execSync as (command: string, options: unknown) => void)('node a.js', { env: { NODE_ENV: 'production' } });
      const [spawnCall, execCall] = calls as [[string, { envPairs: string[] }], [string, string, { env: Record<string, string> }]];
      return { spawned: spawnCall[1].envPairs, executed: execCall[2].env };
    }

    it('forces the sandbox in every child of an active sandbox parent (#2340)', () => {
      marks[SANDBOX_MARK] = true;
      const { spawned, executed } = childEnvs();
      expect(spawned).toContain('PYRIC_SANDBOX_FORCE=1');
      expect(executed.PYRIC_SANDBOX_FORCE).toBe('1');
    });

    it('adds no force in a live mode parent', () => {
      marks[LIVE_MARK] = true;
      const { spawned, executed } = childEnvs();
      expect(spawned.some((pair) => pair.startsWith('PYRIC_SANDBOX_FORCE='))).toBe(false);
      expect(executed.PYRIC_SANDBOX_FORCE).toBeUndefined();
    });

    it('overwrites caller-forged values for pinned inherited variables across child env and envPairs', () => {
      const prevProject = process.env.PYRIC_PROJECT;
      try {
        pinInheritedVariables({ PYRIC_PROJECT: 'org-alpha' });
        const env = guardChildEnv({ PYRIC_PROJECT: 'org-beta', GCLOUD_PROJECT: 'org-beta' }, PARENT, REGISTER_URL, false);
        expect(env.PYRIC_PROJECT).toBe('org-alpha');
        expect(env.GCLOUD_PROJECT).toBe('org-beta');
        const pairs = guardEnvPairs(['PYRIC_PROJECT=org-beta', 'GCLOUD_PROJECT=org-beta'], PARENT, REGISTER_URL, false);
        expect(pairs).toContain('PYRIC_PROJECT=org-alpha');
        expect(pairs).toContain('GCLOUD_PROJECT=org-beta');
      } finally {
        clearPinnedInheritedVariables();
        if (prevProject === undefined) delete process.env.PYRIC_PROJECT;
        else process.env.PYRIC_PROJECT = prevProject;
      }
    });
  });
});
