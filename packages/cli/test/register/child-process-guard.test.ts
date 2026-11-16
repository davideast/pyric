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
} from '../../src/register/child-process-guard.js';

/** The marks `activation.ts` sets when the sandbox register or the live register activates. */
const SANDBOX_MARK = Symbol.for('pyric.register.active');
const LIVE_MARK = Symbol.for('pyric.register.live.active');
const marks = globalThis as unknown as Record<symbol, unknown>;

function clearMarks(): void {
  delete marks[SANDBOX_MARK];
  delete marks[LIVE_MARK];
}

const REGISTER_URL = 'file:///app/node_modules/@pyric/cli/dist/register/index.js';
const IMPORT = `--import ${REGISTER_URL}`;
const PARENT = { PATH: '/bin', PYRIC_SANDBOX: 'remote:http://127.0.0.1:4000', PYRIC_AI_MODE: 'sandbox', HOME: '/home/a' };

describe('guardChildEnv', () => {
  it('adds the register and the parent sandbox to an env of only PATH', () => {
    expect(guardChildEnv({ PATH: '/usr/bin' }, PARENT, REGISTER_URL)).toEqual({
      PATH: '/usr/bin',
      PYRIC_SANDBOX: 'remote:http://127.0.0.1:4000',
      PYRIC_AI_MODE: 'sandbox',
      NODE_OPTIONS: IMPORT,
    });
  });

  it('appends the register to NODE_OPTIONS the caller replaced', () => {
    const env = guardChildEnv({ ...PARENT, NODE_OPTIONS: '--max-old-space-size=4096' }, PARENT, REGISTER_URL);
    expect(env.NODE_OPTIONS).toBe(`--max-old-space-size=4096 ${IMPORT}`);
  });

  it('canonicalizes own bare and filesystem preloads (both --import and -r/--require) and injects active register ahead of foreign preloads without rewriting the foreign specifier', () => {
    const LIVE_URL = 'file:///app/node_modules/@pyric/live/dist/register.js';
    const LIVE_IMPORT = `--import ${LIVE_URL}`;
    expect(guardChildEnv({ NODE_OPTIONS: IMPORT }, PARENT, REGISTER_URL).NODE_OPTIONS).toBe(IMPORT);
    expect(guardChildEnv({ NODE_OPTIONS: '--import @pyric/cli/register' }, PARENT, REGISTER_URL).NODE_OPTIONS).toBe(
      IMPORT,
    );
    expect(
      guardChildEnv({ NODE_OPTIONS: '--import=@pyric/cli/register --no-warnings' }, PARENT, REGISTER_URL).NODE_OPTIONS,
    ).toBe(`--import=${REGISTER_URL} --no-warnings`);
    expect(
      guardChildEnv(
        { NODE_OPTIONS: '--import=/app/node_modules/@pyric/cli/dist/register/index.js --no-warnings' },
        PARENT,
        REGISTER_URL,
      ).NODE_OPTIONS,
    ).toBe(`--import=${REGISTER_URL} --no-warnings`);
    expect(guardChildEnv({ NODE_OPTIONS: '-r @pyric/cli/register' }, PARENT, REGISTER_URL).NODE_OPTIONS).toBe(IMPORT);
    expect(guardChildEnv({ NODE_OPTIONS: '--require=@pyric/cli/register' }, PARENT, REGISTER_URL).NODE_OPTIONS).toBe(
      IMPORT,
    );
    // Foreign register preloads are kept verbatim AND never suppress injecting the active parent register ahead of them.
    for (const foreign of [
      '--import @pyric/live/register',
      '--import=@pyric/live/register',
      `--import ${LIVE_URL}`,
      '-r @pyric/live/register',
      '--import /tmp/decoy/packages/live/dist/register/index.js',
    ]) {
      expect(guardChildEnv({ NODE_OPTIONS: foreign }, PARENT, REGISTER_URL).NODE_OPTIONS).toBe(`${IMPORT} ${foreign}`);
    }
    for (const foreign of [
      '--import @pyric/cli/register',
      '--import=@pyric/cli/register',
      IMPORT,
      '-r @pyric/cli/register',
      '--import /tmp/decoy/packages/cli/dist/register/index.js',
    ]) {
      expect(guardChildEnv({ NODE_OPTIONS: foreign }, PARENT, LIVE_URL).NODE_OPTIONS).toBe(`${LIVE_IMPORT} ${foreign}`);
    }
    // Foreign followed by own still places the active parent register first and deduplicates own.
    expect(
      guardChildEnv(
        { NODE_OPTIONS: '--import @pyric/live/register --import @pyric/cli/register' },
        PARENT,
        REGISTER_URL,
      ).NODE_OPTIONS,
    ).toBe(`${IMPORT} --import @pyric/live/register`);
    expect(
      guardChildEnv(
        { NODE_OPTIONS: '--import @pyric/cli/register --import @pyric/live/register' },
        PARENT,
        LIVE_URL,
      ).NODE_OPTIONS,
    ).toBe(`${LIVE_IMPORT} --import @pyric/cli/register`);
    expect(guardChildEnv({ NODE_OPTIONS: '--import @pyric/live/register' }, PARENT, LIVE_URL).NODE_OPTIONS).toBe(
      LIVE_IMPORT,
    );
    expect(
      guardChildEnv(
        { NODE_OPTIONS: '--import file:///app/custom-register.mjs' },
        PARENT,
        REGISTER_URL,
      ).NODE_OPTIONS,
    ).toBe(`${IMPORT} --import file:///app/custom-register.mjs`);
    expect(
      guardChildEnv(
        { NODE_OPTIONS: '--no-warnings --import=file:///app/custom-register.mjs --import @pyric/cli/register' },
        PARENT,
        REGISTER_URL,
      ).NODE_OPTIONS,
    ).toBe(`--no-warnings ${IMPORT} --import=file:///app/custom-register.mjs`);
    expect(
      guardChildEnv(
        { NODE_OPTIONS: '--require file:///app/early.cjs' },
        PARENT,
        REGISTER_URL,
      ).NODE_OPTIONS,
    ).toBe(`${IMPORT} --require file:///app/early.cjs`);
    expect(
      guardChildEnv(
        { NODE_OPTIONS: '-r file:///app/early.cjs --import @pyric/live/register' },
        PARENT,
        LIVE_URL,
      ).NODE_OPTIONS,
    ).toBe(`${LIVE_IMPORT} -r file:///app/early.cjs`);
  });

  it('detects any preload scheduled ahead of the active register', () => {
    expect(hasPreloadBeforeRegister('', REGISTER_URL)).toBe(false);
    expect(hasPreloadBeforeRegister('--max-old-space-size=4096', REGISTER_URL)).toBe(false);
    expect(hasPreloadBeforeRegister(`${IMPORT} --import file:///app/custom.mjs`, REGISTER_URL)).toBe(false);
    expect(hasPreloadBeforeRegister('--import @pyric/cli/register --import file:///app/custom.mjs', REGISTER_URL)).toBe(false);
    expect(hasPreloadBeforeRegister('--import file:///app/custom.mjs', REGISTER_URL)).toBe(true);
    expect(hasPreloadBeforeRegister('--import=file:///app/custom.mjs', REGISTER_URL)).toBe(true);
    expect(hasPreloadBeforeRegister('--import file:///app/custom.mjs --import @pyric/cli/register', REGISTER_URL)).toBe(true);
    expect(hasPreloadBeforeRegister('-r file:///app/early.cjs', REGISTER_URL)).toBe(true);
    expect(hasPreloadBeforeRegisterTokens(['--no-warnings'], REGISTER_URL)).toBe(false);
    expect(hasPreloadBeforeRegisterTokens(['--import', REGISTER_URL, '--import', 'file:///app/early.mjs'], REGISTER_URL)).toBe(false);
    expect(hasPreloadBeforeRegisterTokens(['--import', 'file:///app/early.mjs', '--import', REGISTER_URL], REGISTER_URL)).toBe(true);
  });

  it('recognizes only the active register in loadsRegister and distinguishes foreign preloads and preload order', () => {
    const LIVE_URL = 'file:///app/node_modules/@pyric/live/dist/register.js';
    expect(loadsRegister(IMPORT, REGISTER_URL)).toBe(true);
    expect(loadsRegister('--import=/app/node_modules/@pyric/cli/dist/register/index.js', REGISTER_URL)).toBe(true);
    expect(loadsRegister('--import "/app/node_modules/@pyric/cli/dist/register/index.js"', REGISTER_URL)).toBe(true);
    expect(loadsRegister('--import @pyric/cli/register', REGISTER_URL)).toBe(true);
    expect(loadsRegister('-r @pyric/cli/register', REGISTER_URL)).toBe(true);
    expect(loadsRegister('--require /app/node_modules/@pyric/cli/dist/register/index.js', REGISTER_URL)).toBe(true);
    expect(loadsRegister('--require=/app/node_modules/@pyric/cli/dist/register/index.js', REGISTER_URL)).toBe(true);
    // Foreign registers and unverified decoys never satisfy loadsRegister for the active register.
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
    expect(hasForeignRegisterPreload('-r /app/node_modules/@pyric/live/dist/register-eval-worker.js', REGISTER_URL)).toBe(true);
    expect(hasForeignRegisterPreload('--import @pyric/cli/register', LIVE_URL)).toBe(true);
    expect(hasForeignRegisterPreload('--import @pyric/cli/register', REGISTER_URL)).toBe(false);
    expect(hasForeignRegisterPreload('--import file:///app/custom-register.mjs', REGISTER_URL)).toBe(false);

    expect(
      hasSandboxRegisterAheadOfLive(
        `${IMPORT} -r /app/node_modules/@pyric/live/dist/register-eval-worker.js`,
        [],
        REGISTER_URL,
      ),
    ).toBe(true);
    expect(
      hasSandboxRegisterAheadOfLive(
        `--import ${LIVE_URL} --import @pyric/cli/register`,
        [],
        REGISTER_URL,
      ),
    ).toBe(false);
    expect(
      hasSandboxRegisterAheadOfLive(
        '',
        ['--import', REGISTER_URL, '-r', '/app/node_modules/@pyric/live/dist/register-eval-worker.js'],
        REGISTER_URL,
      ),
    ).toBe(true);
  });

  it('keeps a PYRIC_ variable the caller set, and fills one set empty', () => {
    const env = guardChildEnv({ PYRIC_AI_MODE: 'production', PYRIC_SANDBOX: '' }, PARENT, REGISTER_URL);
    expect(env.PYRIC_AI_MODE).toBe('production');
    expect(env.PYRIC_SANDBOX).toBe('remote:http://127.0.0.1:4000');
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
      NODE_OPTIONS: IMPORT,
    });
  });

  it('keeps a PYRIC_SANDBOX_FORCE the caller set for the child', () => {
    const env = guardChildEnv({ NODE_ENV: 'production', PYRIC_SANDBOX_FORCE: '0' }, PARENT, REGISTER_URL, true);
    expect(env.PYRIC_SANDBOX_FORCE).toBe('0');
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
      `NODE_OPTIONS=--max-old-space-size=4096 ${IMPORT}`,
      'PYRIC_SANDBOX=remote:http://127.0.0.1:4000',
      'PYRIC_AI_MODE=sandbox',
    ]);
  });
});

describe('guardSpawnOptions', () => {
  it('guards envPairs and leaves options without them, as Bun passes, alone', () => {
    const guarded = guardSpawnOptions({ file: 'node', envPairs: ['PATH=/usr/bin'] }, REGISTER_URL) as { envPairs: string[] };
    expect(guarded.envPairs).toContain(`NODE_OPTIONS=${IMPORT}`);
    const bunOptions = { file: 'node', env: { PATH: '/usr/bin' } };
    expect(guardSpawnOptions(bunOptions, REGISTER_URL)).toBe(bunOptions);
  });
});

describe('guardSyncArguments', () => {
  const guarded = { ...PARENT, NODE_OPTIONS: IMPORT };

  it('adds options with the parent env when a call names none', () => {
    expect(guardSyncArguments(true, ['node'], PARENT, REGISTER_URL)).toEqual(['node', { env: guarded }]);
    expect(guardSyncArguments(true, ['node', ['a.js']], PARENT, REGISTER_URL)).toEqual(['node', ['a.js'], { env: guarded }]);
    expect(guardSyncArguments(false, ['node a.js'], PARENT, REGISTER_URL)).toEqual(['node a.js', { env: guarded }]);
  });

  it('finds options with or without args, and after a null args', () => {
    const options = { cwd: '/app', env: { PATH: '/usr/bin' } };
    const env = { PATH: '/usr/bin', PYRIC_SANDBOX: PARENT.PYRIC_SANDBOX, PYRIC_AI_MODE: 'sandbox', NODE_OPTIONS: IMPORT };
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
    expect(spawnCall[1].envPairs).toContain(`NODE_OPTIONS=${IMPORT}`);
    expect(execCall[2].env.NODE_OPTIONS).toContain(IMPORT);
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
