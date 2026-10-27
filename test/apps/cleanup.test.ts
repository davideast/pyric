import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanUpApp, removeTree, summarize, type RunRemove } from './cleanup.ts';

/** Trees made undeletable by a test, unlocked and removed after it. */
const locked: Array<{ work: string; stuck: string }> = [];
afterEach(async () => {
  for (const { work, stuck } of locked.splice(0)) {
    if (existsSync(stuck)) chmodSync(stuck, 0o755);
    await removeTree(work);
  }
});

/** A tree shaped like an installed app: nested packages, a `.bin` link, and a link between packages. */
function appTree(): string {
  const work = mkdtempSync(join(tmpdir(), 'pyric-cleanup-test-'));
  const lib = join(work, 'app', 'node_modules', 'a', 'lib');
  mkdirSync(lib, { recursive: true });
  mkdirSync(join(work, 'app', 'node_modules', 'b'));
  mkdirSync(join(work, 'app', 'node_modules', '.bin'));
  writeFileSync(join(lib, 'index.js'), '');
  symlinkSync('../a/lib/index.js', join(work, 'app', 'node_modules', '.bin', 'a'));
  symlinkSync('../a', join(work, 'app', 'node_modules', 'b', 'a'));
  return work;
}

/** A tree `rm -rf` cannot remove: a file inside a directory nobody may write to. */
function undeletableTree(): string {
  const work = appTree();
  const stuck = join(work, 'app', 'stuck');
  mkdirSync(stuck);
  writeFileSync(join(stuck, 'held'), '');
  chmodSync(stuck, 0o555);
  locked.push({ work, stuck });
  return work;
}

const isRoot = process.getuid?.() === 0;

describe('removeTree', () => {
  test('removes an installed tree, links included, and leaves what the links point at outside it', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'pyric-cleanup-target-'));
    const work = appTree();
    symlinkSync(outside, join(work, 'app', 'outside'));

    expect(await removeTree(work)).toBeUndefined();
    expect(existsSync(work)).toBe(false);
    expect(existsSync(outside)).toBe(true);
    expect(await removeTree(outside)).toBeUndefined();
  });

  test('succeeds for a tree that is already gone', async () => {
    expect(await removeTree(join(tmpdir(), 'pyric-cleanup-never-made'))).toBeUndefined();
  });

  test.skipIf(isRoot)('resolves to the path and rm\'s reason when the tree cannot be removed, without throwing', async () => {
    const work = undeletableTree();

    const failure = await removeTree(work, undefined, 0);

    expect(failure).toContain(`could not remove ${work} after 3 attempts`);
    expect(failure).toContain('Permission denied');
    expect(existsSync(join(work, 'app', 'stuck', 'held'))).toBe(true);
  });

  test('retries a failed attempt, so a writer that is still exiting does not leave the tree', async () => {
    const calls: string[][] = [];
    const flaky: RunRemove = async (args) => {
      calls.push(args);
      return calls.length === 1 ? { code: 1, output: 'rm: cannot remove: Directory not empty' } : { code: 0, output: '' };
    };

    expect(await removeTree('/tmp/pyric-app-x', flaky, 0)).toBeUndefined();
    expect(calls).toEqual([['-rf', '--', '/tmp/pyric-app-x'], ['-rf', '--', '/tmp/pyric-app-x']]);
  });

  test('reports an rm that cannot start', async () => {
    const missing: RunRemove = async () => { throw new Error('spawn rm ENOENT'); };

    expect(await removeTree('/tmp/pyric-app-x', missing, 0)).toBe('could not remove /tmp/pyric-app-x after 3 attempts: rm did not start: spawn rm ENOENT');
  });
});

describe('cleanUpApp', () => {
  test('removes the tree when closing the app throws, and reports both steps', async () => {
    const work = appTree();

    const failures = await cleanUpApp({
      close: async () => { throw new Error('browser context did not close'); },
      remove: () => removeTree(work),
    });

    expect(failures).toEqual(["closing the app's browser and processes failed: browser context did not close"]);
    expect(existsSync(work)).toBe(false);
  });

  test.skipIf(isRoot)('reports a tree it could not remove instead of rejecting', async () => {
    const work = undeletableTree();

    const failures = await cleanUpApp({ close: async () => {}, remove: () => removeTree(work, undefined, 0) });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(`could not remove ${work}`);
  });

  test('reports a removal that rejects, as fs.promises.rm did with EFAULT in #1354', async () => {
    const efault = Object.assign(new Error("EFAULT: bad address in system call argument, rm '/tmp/pyric-app-x'"), { code: 'EFAULT' });

    const failures = await cleanUpApp({ close: async () => {}, remove: async () => { throw efault; } });

    expect(failures).toEqual(["removing the app's directory failed: EFAULT: bad address in system call argument, rm '/tmp/pyric-app-x'"]);
  });

  test('reports nothing when both steps succeed', async () => {
    expect(await cleanUpApp({ close: async () => {}, remove: async () => undefined })).toEqual([]);
  });
});

describe('summarize', () => {
  const passed = { ok: true, cleanupFailures: [] };

  test('passes a run whose apps passed and cleaned up', () => {
    const { lines, exitCode } = summarize([{ name: 'a', ...passed }, { name: 'b', ...passed }], '9.0', '');

    expect(lines).toEqual(['✓ 2 apps passed (9.0s)']);
    expect(exitCode).toBe(0);
  });

  test('fails a run whose apps all passed when one left its tree, on its own line after the verdicts', () => {
    const results = [
      { name: 'a', ...passed },
      { name: 'rtdb-verify-reads-and-denials', ok: true, cleanupFailures: ['could not remove /tmp/pyric-app-x after 3 attempts: rm exited with code 1'] },
    ];

    const { lines, exitCode } = summarize(results, '9.0', '');

    expect(lines).toEqual([
      '✓ 2 apps passed (9.0s)',
      '✗ cleanup failed for 1 of 2 apps: rtdb-verify-reads-and-denials',
      '  rtdb-verify-reads-and-denials: could not remove /tmp/pyric-app-x after 3 attempts: rm exited with code 1',
    ]);
    expect(exitCode).toBe(1);
  });

  test('keeps a failed app\'s verdict next to another app\'s cleanup failure', () => {
    const results = [
      { name: 'a', ok: false, step: 'open the page', cleanupFailures: [] },
      { name: 'b', ok: true, cleanupFailures: ['closing failed'] },
    ];

    const { lines, exitCode } = summarize(results, '9.0', ' (1 slow app skipped)');

    expect(lines).toEqual([
      '✗ 1 of 2 apps failed (9.0s): a at "open the page" (1 slow app skipped)',
      '✗ cleanup failed for 1 of 2 apps: b',
      '  b: closing failed',
    ]);
    expect(exitCode).toBe(1);
  });
});
