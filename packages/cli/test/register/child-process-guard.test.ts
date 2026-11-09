/**
 * The register's child-process coverage (`src/register/child-process-guard.ts`, #1618).
 *
 * A child of a registered process starts with the register in its
 * `NODE_OPTIONS` and with the parent's `PYRIC_*` variables it lacks, whatever
 * env the caller gave it.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  guardChildEnv,
  guardEnvPairs,
  guardSpawnOptions,
  guardSyncArguments,
  installChildProcessGuard,
  isSandboxParent,
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

  it('leaves NODE_OPTIONS that already loads the register, by URL or by name', () => {
    for (const nodeOptions of [IMPORT, '--import @pyric/cli/register', '--import=@pyric/cli/register --no-warnings']) {
      expect(guardChildEnv({ NODE_OPTIONS: nodeOptions }, PARENT, REGISTER_URL).NODE_OPTIONS).toBe(nodeOptions);
    }
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
  });
});
