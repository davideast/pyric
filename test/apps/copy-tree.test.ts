import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { copyTree, type StartCopyWorker } from './copy-tree.ts';
import { SharedInstalls } from './shared-installs.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-copy-tree-test-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('copying an installed tree into an app', () => {
  test('files are copies the app can change alone, and symlinks stay symlinks', async () => {
    const from = tempDir();
    const to = join(tempDir(), 'node_modules');
    mkdirSync(join(from, 'vite/bin'), { recursive: true });
    mkdirSync(join(from, '.bin'));
    writeFileSync(join(from, 'vite/bin/vite.js'), 'console.log("vite")\n');
    symlinkSync('../vite/bin/vite.js', join(from, '.bin/vite'));
    await copyTree(from, to);
    expect(statSync(join(to, 'vite/bin/vite.js')).ino).not.toBe(statSync(join(from, 'vite/bin/vite.js')).ino);
    expect(lstatSync(join(to, '.bin/vite')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(to, '.bin/vite'))).toBe('../vite/bin/vite.js');
    writeFileSync(join(to, 'vite/bin/vite.js'), 'changed\n');
    expect(readFileSync(join(from, 'vite/bin/vite.js'), 'utf8')).toBe('console.log("vite")\n');
  });
});

describe('settling a copy from its worker', () => {
  type WorkerStep = ['result', { ok: boolean; message?: string }] | ['message', { ok: boolean; message?: string }] | ['exit', number];

  /**
   * A copy worker that does each step on its own later turn, `delayMs`
   * apart, the way a real one reports: `result` writes the result file, as
   * the real worker does before it posts its message.
   */
  function scriptedWorker(steps: readonly WorkerStep[], delayMs = 0): StartCopyWorker {
    return (_from, _to, resultFile) => {
      const worker = Object.assign(new EventEmitter(), { terminate: () => undefined });
      steps.forEach(([step, value], index) => setTimeout(() => {
        if (step === 'result') writeFileSync(resultFile, JSON.stringify(value));
        else worker.emit(step, value);
      }, (index + 1) * delayMs));
      return worker;
    };
  }

  /** Starts each worker in `starts` in turn, and counts them. */
  function inTurn(starts: readonly StartCopyWorker[]): { startWorker: StartCopyWorker; started: () => number } {
    let count = 0;
    const startWorker: StartCopyWorker = (from, to, resultFile) => {
      const start = starts[count] ?? starts[starts.length - 1];
      if (!start) throw new Error('inTurn requires at least one worker');
      count += 1;
      return start(from, to, resultFile);
    };
    return { startWorker, started: () => count };
  }

  const to = () => join(tempDir(), 'to');
  const lines = (): { report: (line: string) => void; reported: string[] } => {
    const reported: string[] = [];
    return { report: (line) => reported.push(line), reported };
  };

  test('a worker whose clean exit is handled before its result settles as success (#1280)', async () => {
    const { startWorker, started } = inTurn([scriptedWorker([['result', { ok: true }], ['exit', 0], ['message', { ok: true }]], 20)]);
    const { report, reported } = lines();
    await expect(copyTree('/from', to(), { startWorker, report })).resolves.toBeUndefined();
    expect({ started: started(), reported }).toEqual({ started: 1, reported: [] });
  });

  test('a worker whose message never arrives settles from the result it wrote', async () => {
    await expect(copyTree('/from', to(), { startWorker: scriptedWorker([['result', { ok: true }], ['exit', 0]]) })).resolves.toBeUndefined();
    const failed = copyTree('/from', to(), { startWorker: scriptedWorker([['result', { ok: false, message: 'ENOSPC' }], ['exit', 0]]) });
    await expect(failed).rejects.toThrow('failed: ENOSPC');
  });

  test('a worker that exits with code 0 and no result did not copy: a real worker then copies the tree, and the retry is reported', async () => {
    const from = tempDir();
    const target = to();
    mkdirSync(join(from, 'vite/bin'), { recursive: true });
    writeFileSync(join(from, 'vite/bin/vite.js'), 'console.log("vite")\n');
    // The first worker leaves part of a tree and exits cleanly with no result, as on CI. The second is the real one.
    const exitsEarly: StartCopyWorker = (source, dest, resultFile) => {
      mkdirSync(join(dest, 'left-by-the-first-worker'), { recursive: true });
      return scriptedWorker([['exit', 0]])(source, dest, resultFile);
    };
    const realWorker: StartCopyWorker = (source, dest, resultFile) =>
      new Worker(new URL('./copy-tree-worker.ts', import.meta.url), { workerData: { from: source, to: dest, resultFile } });
    const { startWorker, started } = inTurn([exitsEarly, realWorker]);
    const { report, reported } = lines();
    await copyTree(from, target, { startWorker, report });
    expect(started()).toBe(2);
    expect(readFileSync(join(target, 'vite/bin/vite.js'), 'utf8')).toBe('console.log("vite")\n');
    expect(existsSync(join(target, 'left-by-the-first-worker'))).toBe(false);
    expect(existsSync(`${target}.copy-result.json`)).toBe(false);
    expect(reported).toEqual([`[runner] infrastructure retry: the copy worker for ${target} exited with code 0 before it finished; copying once more`]);
  });

  test('a second worker that also exits with code 0 and no result fails the copy, and there is no third', async () => {
    const { startWorker, started } = inTurn([scriptedWorker([['exit', 0]])]);
    const { report, reported } = lines();
    await expect(copyTree('/from', to(), { startWorker, report })).rejects.toThrow('the copy worker exited with code 0 before it finished, on each of 2 attempts');
    expect({ started: started(), retries: reported.length }).toEqual({ started: 2, retries: 1 });
  });

  test('a worker that exits with another code fails the copy at once', async () => {
    const { startWorker, started } = inTurn([scriptedWorker([['exit', 1]])]);
    const { report, reported } = lines();
    await expect(copyTree('/from', to(), { startWorker, report })).rejects.toThrow('the copy worker exited with code 1 before it finished');
    expect({ started: started(), reported }).toEqual({ started: 1, reported: [] });
  });

  test('a failed result fails the copy at once, and a later exit does not change it', async () => {
    const { startWorker, started } = inTurn([scriptedWorker([['message', { ok: false, message: 'ENOSPC' }], ['exit', 0]])]);
    const { report, reported } = lines();
    await expect(copyTree('/from', to(), { startWorker, report })).rejects.toThrow('failed: ENOSPC');
    expect({ started: started(), reported }).toEqual({ started: 1, reported: [] });
  });

  test('a real copy that fails says why, and is not run again', async () => {
    const { report, reported } = lines();
    const missing = join(tempDir(), 'no-such-tree');
    await expect(copyTree(missing, to(), { report })).rejects.toThrow(/copying .*no-such-tree to .* failed: .*ENOENT/);
    expect(reported).toEqual([]);
  });

  test('SharedInstalls recovers when the first copy worker exits 0 early, and reports the retry (#2189, #2560, #2620)', async () => {
    const appDir = join(tempDir(), 'app');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'package.json'), JSON.stringify({ private: true, dependencies: { vite: '7.3.2' } }));
    const exitsEarly: StartCopyWorker = (source, dest, resultFile) => {
      mkdirSync(join(dest, 'partial-from-exit-0'), { recursive: true });
      return scriptedWorker([['exit', 0]])(source, dest, resultFile);
    };
    const realWorker: StartCopyWorker = (source, dest, resultFile) =>
      new Worker(new URL('./copy-tree-worker.ts', import.meta.url), { workerData: { from: source, to: dest, resultFile } });
    const { startWorker, started } = inTurn([exitsEarly, realWorker]);
    const { report, reported } = lines();
    const shared = new SharedInstalls(tempDir(), async (cwd) => {
      mkdirSync(join(cwd, 'node_modules/vite'), { recursive: true });
      writeFileSync(join(cwd, 'node_modules/vite/package.json'), '{"name":"vite"}\n');
      writeFileSync(join(cwd, 'package-lock.json'), '{"lockfileVersion":3}\n');
      return { code: 0, output: 'added 1 package\n' };
    }, { report, startCopyWorker: startWorker });
    const result = await shared.install(appDir, 'rtdb-legacy-default-url');
    expect(result.code).toBe(0);
    expect(started()).toBe(2);
    expect(readFileSync(join(appDir, 'node_modules/vite/package.json'), 'utf8')).toBe('{"name":"vite"}\n');
    expect(readFileSync(join(appDir, 'package-lock.json'), 'utf8')).toBe('{"lockfileVersion":3}\n');
    expect(existsSync(join(appDir, 'node_modules/partial-from-exit-0'))).toBe(false);
    expect(reported).toHaveLength(2);
    expect(reported[0]).toMatch(/^\[runner\] dependency set [0-9a-f]{16} for rtdb-legacy-default-url: installed in place, \d+\.\d s$/);
    expect(reported[1]).toBe(`[runner] infrastructure retry: the copy worker for ${join(appDir, 'node_modules')} exited with code 0 before it finished; copying once more`);
  });

  test('SharedInstalls fails with the shared npm log if both copy workers exit 0 without a result (#2189)', async () => {
    const appDir = join(tempDir(), 'app');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'package.json'), JSON.stringify({ private: true, dependencies: { vite: '7.3.2' } }));
    const { startWorker, started } = inTurn([scriptedWorker([['exit', 0]])]);
    const shared = new SharedInstalls(tempDir(), async (cwd) => {
      mkdirSync(join(cwd, 'node_modules'), { recursive: true });
      return { code: 0, output: 'added 205 packages\n' };
    }, { startCopyWorker: startWorker });
    const result = await shared.install(appDir, 'live-mode-rtdb');
    expect({ code: result.code, started: started() }).toEqual({ code: 1, started: 2 });
    expect(result.output).toContain('added 205 packages');
    expect(result.output).toContain('the copy worker exited with code 0 before it finished, on each of 2 attempts');
  });
});
