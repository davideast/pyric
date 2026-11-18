import { afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface TempDirTracker {
  makeTempDir(prefix?: string): string;
  cleanupTempDirs(): void;
}

/**
 * Tracks temporary directories under `os.tmpdir()` and exposes an explicit
 * `cleanupTempDirs()` callback for `afterAll`, `finally`, or post-`server.stop()`
 * teardown.
 */
export function trackTempDirs(defaultPrefix = 'pyric-test-'): TempDirTracker {
  const dirs: string[] = [];
  return {
    makeTempDir(prefix = defaultPrefix): string {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    },
    cleanupTempDirs(): void {
      while (dirs.length > 0) {
        const dir = dirs.pop();
        if (dir !== undefined) {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    },
  };
}

/**
 * Registers an `afterEach` hook that removes every temporary directory allocated
 * through the returned `makeTempDir` function. Call after any server `afterEach`
 * hook is registered, or use `trackTempDirs()` when servers stop in `afterAll`.
 */
export function useTempDirs(defaultPrefix = 'pyric-test-'): (prefix?: string) => string {
  const tracker = trackTempDirs(defaultPrefix);
  afterEach(() => {
    tracker.cleanupTempDirs();
  });
  return tracker.makeTempDir;
}
