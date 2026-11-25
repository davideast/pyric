// `runReproduce` when a try's sandbox outlives SIGKILL (`stop()` returns
// `still-running`): the try must be marked `invalid`, stopping further tries,
// even when the phase script appeared to reproduce or threw beforehand (#1788).
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EgressNamespace, SandboxStop } from './namespace.ts';
import type { CheckedRepro } from './reproduce-check.ts';
import type { ReproduceOptions } from './reproduce-options.ts';
import { REPRO_LOG, REPRO_PHASE_LOG, runReproduce, type TryRecord } from './reproduce.ts';

const SAVED_ENV = {
  PYRIC_BUILDERS_DIR: process.env.PYRIC_BUILDERS_DIR,
  PYRIC_BUILDERS_DATA_DIR: process.env.PYRIC_BUILDERS_DATA_DIR,
  PYRIC_HEAVY_RUN_DIR: process.env.PYRIC_HEAVY_RUN_DIR,
  PYRIC_HEAVY_RUN_SLOT: process.env.PYRIC_HEAVY_RUN_SLOT,
};

function restoreVar(name: keyof typeof SAVED_ENV): void {
  const value = SAVED_ENV[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  restoreVar('PYRIC_BUILDERS_DIR');
  restoreVar('PYRIC_BUILDERS_DATA_DIR');
  restoreVar('PYRIC_HEAVY_RUN_DIR');
  restoreVar('PYRIC_HEAVY_RUN_SLOT');
});

interface Fixture {
  root: string;
  options: ReproduceOptions;
  checked: CheckedRepro;
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'builders-reproduce-stop-'));
  process.env.PYRIC_BUILDERS_DIR = join(root, 'scratch');
  process.env.PYRIC_BUILDERS_DATA_DIR = join(root, 'data');
  process.env.PYRIC_HEAVY_RUN_DIR = join(root, 'slots');
  delete process.env.PYRIC_HEAVY_RUN_SLOT;

  const script = join(root, 'repro.mjs');
  writeFileSync(script, 'process.exit(1);\n');
  const appArchive = join(root, 'app.tgz');
  writeFileSync(appArchive, '');

  const problem = {
    id: 'p1',
    summary: 'planted problem',
    step: 1,
    docsLedMeToExpect: null,
    whatHappened: 'it broke',
    errorText: 'boom',
    logs: [],
    reproHint: 'node repro.mjs',
  };

  const checked: CheckedRepro = {
    kept: {
      builder: null,
      harness: {
        run: 'r1-1-haiku',
        round: 'r1',
        provenance: { commit: 'abc1234', tarballs: {} },
        automaticProblems: [],
      },
    },
    target: { kind: 'builder-problem', selector: 'p1', slug: 'p1', problem },
    appArchive,
    tarballs: new Map(),
    packagesDir: root,
  };

  const options: ReproduceOptions = {
    list: false,
    round: 'r1',
    run: 'r1-1-haiku',
    problem: 'p1',
    script,
    register: false,
    minutes: 1,
  };

  return { root, options, checked };
}

function stubNamespace(stopResult: SandboxStop): EgressNamespace {
  return {
    pid: 0,
    enter: (command, args) => ({ command, args: [...args] }),
    stop: async () => stopResult,
  };
}

interface KeptReproFile {
  result: string;
  tries: TryRecord[];
}

function readKeptRepro(root: string): { dir: string; repro: KeptReproFile } {
  const base = join(root, 'data', 'runs', 'r1', 'r1-1-haiku', 'repros', 'p1');
  const [stamp] = readdirSync(base);
  const dir = join(base, stamp ?? '');
  const repro = JSON.parse(readFileSync(join(dir, 'repro.json'), 'utf8')) as KeptReproFile;
  return { dir, repro };
}

describe('runReproduce when the sandbox stop returns still-running', () => {
  test('marks a try invalid and stops at try 1 even when the script exited 1, while an exited stop reproduces', async () => {
    const stillRunning = createFixture();
    let attempts = 0;

    const result = await runReproduce(stillRunning.options, {
      check: () => stillRunning.checked,
      startNamespace: async () => stubNamespace('still-running'),
      runInSandbox: async (_namespace, dirs) => {
        attempts += 1;
        writeFileSync(dirs.phaseResult, `${JSON.stringify({ code: 1, timedOut: false, error: null, wallMs: 50 })}\n`);
        writeFileSync(join(dirs.logs, REPRO_LOG), 'Error: boom\n');
        return 'phase output\n';
      },
    });

    expect(result).toBe('invalid');
    expect(attempts).toBe(1);
    const kept = readKeptRepro(stillRunning.root);
    expect(kept.repro.result).toBe('invalid');
    expect(kept.repro.tries).toHaveLength(1);
    expect(kept.repro.tries[0]?.outcome).toBe('invalid');
    expect(kept.repro.tries[0]?.sandboxLeftRunning).toBe(true);
    expect(kept.repro.tries[0]?.reason).toContain('still running after SIGKILL');
    expect(existsSync(join(kept.dir, 'try-1', 'logs', REPRO_LOG))).toBe(false);

    const exited = createFixture();
    const control = await runReproduce(exited.options, {
      check: () => exited.checked,
      startNamespace: async () => stubNamespace('exited'),
      runInSandbox: async (_namespace, dirs) => {
        writeFileSync(dirs.phaseResult, `${JSON.stringify({ code: 1, timedOut: false, error: null, wallMs: 50 })}\n`);
        writeFileSync(join(dirs.logs, REPRO_LOG), 'Error: boom\n');
        return 'phase output\n';
      },
    });
    expect(control).toBe('reproduced');
    expect(readKeptRepro(exited.root).repro.tries[0]?.sandboxLeftRunning).toBe(false);
  });

  test('never touches a symlink planted in the scratch directory when stop returns still-running', async () => {
    const stillRunning = createFixture();
    const hostDecoy = join(stillRunning.root, 'host-decoy');
    writeFileSync(hostDecoy, 'untouched\n');

    const result = await runReproduce(stillRunning.options, {
      check: () => stillRunning.checked,
      startNamespace: async () => stubNamespace('still-running'),
      runInSandbox: async (_namespace, dirs) => {
        writeFileSync(dirs.phaseResult, `${JSON.stringify({ code: 1, timedOut: false, error: null, wallMs: 50 })}\n`);
        symlinkSync(hostDecoy, join(dirs.logs, REPRO_PHASE_LOG));
        return 'phase output\n';
      },
    });

    expect(result).toBe('invalid');
    expect(readFileSync(hostDecoy, 'utf8')).toBe('untouched\n');
  });

  test('marks a try invalid and stops at try 1 when runInSandbox throws and stop returns still-running', async () => {
    const fixture = createFixture();
    let attempts = 0;

    const result = await runReproduce(fixture.options, {
      check: () => fixture.checked,
      startNamespace: async () => stubNamespace('still-running'),
      runInSandbox: async () => {
        attempts += 1;
        throw new Error('cold cache failure');
      },
    });

    expect(result).toBe('invalid');
    expect(attempts).toBe(1);
    const kept = readKeptRepro(fixture.root);
    expect(kept.repro.result).toBe('invalid');
    expect(kept.repro.tries).toHaveLength(1);
    expect(kept.repro.tries[0]?.outcome).toBe('invalid');
    expect(kept.repro.tries[0]?.reason).toContain('still running after SIGKILL');
  });
});
