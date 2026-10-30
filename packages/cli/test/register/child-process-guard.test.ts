/**
 * The register's child-process coverage (`src/register/child-process-guard.ts`, #1618).
 *
 * A child of a registered process starts with the register in its
 * `NODE_OPTIONS` and with the parent's `PYRIC_*` variables it lacks, whatever
 * env the caller gave it. The app scenario `net-guard-block-address-forms`
 * checks the same through real `spawn`, `fork`, `spawnSync`, `execFile` and
 * `execSync` children.
 */
import { describe, expect, it } from 'bun:test';
import {
  guardChildEnv,
  guardEnvPairs,
  guardSpawnOptions,
  guardSyncArguments,
  installChildProcessGuard,
} from '../../src/register/child-process-guard.js';

const REGISTER_URL = 'file:///app/node_modules/@pyric/cli/dist/register/index.js';
const IMPORT = `--import ${REGISTER_URL}`;
const PARENT = { PATH: '/bin', PYRIC_SANDBOX: 'remote:http://127.0.0.1:4000', PYRIC_GUARD: 'block', HOME: '/home/a' };

describe('guardChildEnv', () => {
  it('adds the register and the parent sandbox to an env of only PATH', () => {
    expect(guardChildEnv({ PATH: '/usr/bin' }, PARENT, REGISTER_URL)).toEqual({
      PATH: '/usr/bin',
      PYRIC_SANDBOX: 'remote:http://127.0.0.1:4000',
      PYRIC_GUARD: 'block',
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
    const env = guardChildEnv({ PYRIC_GUARD: 'warn', PYRIC_SANDBOX: '' }, PARENT, REGISTER_URL);
    expect(env.PYRIC_GUARD).toBe('warn');
    expect(env.PYRIC_SANDBOX).toBe('remote:http://127.0.0.1:4000');
  });

  it('copies no other parent variable and never changes the caller env', () => {
    const childEnv = { PATH: '/usr/bin' };
    const env = guardChildEnv(childEnv, PARENT, REGISTER_URL);
    expect(env.HOME).toBeUndefined();
    expect(childEnv).toEqual({ PATH: '/usr/bin' });
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
      'PYRIC_GUARD=block',
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
    const env = { PATH: '/usr/bin', PYRIC_SANDBOX: PARENT.PYRIC_SANDBOX, PYRIC_GUARD: 'block', NODE_OPTIONS: IMPORT };
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
});
