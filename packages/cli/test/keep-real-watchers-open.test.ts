/**
 * A real watcher closed in the tick that opened it must not stop a later
 * `Bun.build` in the same process (#1593). The child loads the same preload as
 * this suite, and a failure here leaves this process's bundler unharmed.
 */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const PRELOAD = resolve(import.meta.dir, 'keep-real-watchers-open.ts');
const FIXTURE = resolve(import.meta.dir, 'fixtures/watcher-close-then-build.ts');
/** Past the fixture's own 10 s limit, so a stall reports as `stalled`. */
const CHILD_TIMEOUT_MS = 20_000;

test('a build after a watcher closed at once still finishes', () => {
  const child = spawnSync(process.execPath, ['--preload', PRELOAD, FIXTURE], {
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
    env: process.env,
  });
  expect(child.stderr).toBe('');
  expect(child.stdout.trim()).toBe('built');
}, CHILD_TIMEOUT_MS + 1_000);
