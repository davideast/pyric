import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'bun:test';

const CLI_ROOT = resolve(import.meta.dir, '../..');
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('~/.pyric/vite-worker salted bundle cleanup against a temporary HOME (#1218)', () => {
  it('prunes older salted bundles and disposes the active salted bundle in a temporary HOME while preserving unsalted bundles, unrelated directories, and symlinks', () => {
    const sandboxBase = makeTempDir('pyric-home-isolation-');
    // Separate child HOME and child TMPDIR so HOME is not inside the child's tmpdir().
    const tempHome = join(sandboxBase, 'home');
    const childTmpDir = join(sandboxBase, 'tmp');
    mkdirSync(tempHome, { recursive: true });
    mkdirSync(childTmpDir, { recursive: true });

    const externalDir = join(sandboxBase, 'external-target');
    mkdirSync(externalDir, { recursive: true });
    writeFileSync(join(externalDir, '.salted-worker'), 'external');

    const workerRoot = join(tempHome, '.pyric', 'vite-worker');
    mkdirSync(workerRoot, { recursive: true });

    const unrelatedDir = join(workerRoot, 'custom-notes');
    mkdirSync(unrelatedDir);
    writeFileSync(join(unrelatedDir, 'keep.txt'), 'keep');

    const symlinkEntry = join(workerRoot, 'linked-salted');
    symlinkSync(externalDir, symlinkEntry);

    const tinyWorkerEntry = join(sandboxBase, 'tiny-worker-entry.ts');
    writeFileSync(
      tinyWorkerEntry,
      'declare const __PYRIC_WORKER_VERSION__: string;\nglobalThis.__TINY_EPOCH__ = __PYRIC_WORKER_VERSION__;\n',
    );

    const liveProjectDir = join(tempHome, 'live-app');
    mkdirSync(liveProjectDir, { recursive: true });
    const deletedProjectPath = join(tempHome, 'deleted-app');

    const runtimeModuleUrl = pathToFileURL(
      join(CLI_ROOT, 'src/serve/vite-worker-runtime.ts'),
    ).href;
    const bundlerModuleUrl = pathToFileURL(join(CLI_ROOT, 'src/serve/bundler.ts')).href;
    const evictModuleUrl = pathToFileURL(
      join(CLI_ROOT, 'src/serve/bundle-cache-evict.ts'),
    ).href;

    const childScript = [
      "import { homedir } from 'node:os';",
      "import { join } from 'node:path';",
      "import { readdirSync, utimesSync } from 'node:fs';",
      `import { createViteWorkerRuntime } from ${JSON.stringify(runtimeModuleUrl)};`,
      `import { bundleWorker } from ${JSON.stringify(bundlerModuleUrl)};`,
      `import { isAllowlistedPyricCacheRoot, isDefaultViteWorkerCacheRoot } from ${JSON.stringify(evictModuleUrl)};`,
      `const entryPath = ${JSON.stringify(tinyWorkerEntry)};`,
      `const liveProject = ${JSON.stringify(liveProjectDir)};`,
      `const deadProject = ${JSON.stringify(deletedProjectPath)};`,
      "const root = join(homedir(), '.pyric', 'vite-worker');",
      'if (!isDefaultViteWorkerCacheRoot(root) || !isAllowlistedPyricCacheRoot(root)) {',
      "  throw new Error('Expected temp HOME vite-worker root to be allowlisted: ' + root);",
      '}',
      'const runtime = createViteWorkerRuntime({',
      "  cacheKey: 'hash0',",
      '  bundle: (opts) => bundleWorker({ ...opts, entryPath, minify: false }),',
      '});',
      'await runtime.prepare();',
      'await runtime.prepare(JSON.stringify({ projectKey: deadProject, ai: "dead" }));',
      'const deadDir = runtime.status().sdkDir;',
      'const oldDate = new Date(Date.now() - 3 * 3600 * 1000);',
      // Prepare 10 expired salted bundles (> DEFAULT_SALTED_WORKER_MAX_ENTRIES = 8).
      'for (let i = 1; i <= 10; i += 1) {',
      '  await runtime.prepare(JSON.stringify({ projectKey: liveProject, ai: `s${String(i)}` }));',
      '  const dir = runtime.status().sdkDir;',
      '  utimesSync(dir, oldDate, oldDate);',
      '}',
      // Next salted build triggers eviction of expired overflow salted dirs and the deleted-project dir.
      'await runtime.prepare(JSON.stringify({ projectKey: liveProject, ai: "s11" }));',
      'const activeBeforeDispose = runtime.status().sdkDir;',
      'const entriesBeforeDispose = readdirSync(root).sort();',
      'runtime.dispose?.();',
      'const entriesAfterDispose = readdirSync(root).sort();',
      'console.log(JSON.stringify({ deadDir, activeBeforeDispose, entriesBeforeDispose, entriesAfterDispose }));',
    ].join('\n');

    const result = spawnSync(process.execPath, ['-e', childScript], {
      cwd: CLI_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: tempHome,
        USERPROFILE: tempHome,
        TMPDIR: childTmpDir,
        TMP: childTmpDir,
        TEMP: childTmpDir,
      },
      timeout: 45_000,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const report = JSON.parse(result.stdout.trim()) as {
      deadDir: string;
      activeBeforeDispose: string;
      entriesBeforeDispose: string[];
      entriesAfterDispose: string[];
    };

    const saltedBefore = report.entriesBeforeDispose.filter((name) =>
      name.startsWith('hash0-'),
    );
    // 12 salted builds were created; eviction pruned deadDir + expired overflow down to <= 9 (8 retained + 1 active).
    expect(saltedBefore.length).toBeLessThanOrEqual(9);
    expect(existsSync(report.deadDir)).toBe(false);

    // Disposing the runtime removes its active salted directory immediately.
    expect(existsSync(report.activeBeforeDispose)).toBe(false);

    // Unsalted cache, unrelated directory, and symlink target all remain intact.
    const remaining = readdirSync(workerRoot);
    expect(remaining).toContain('hash0');
    expect(existsSync(join(unrelatedDir, 'keep.txt'))).toBe(true);
    expect(lstatSync(symlinkEntry).isSymbolicLink()).toBe(true);
    expect(existsSync(join(externalDir, '.salted-worker'))).toBe(true);
  }, 60_000);
});
