/**
 * A real watcher closed in the tick that opened it must not stop a later
 * `Bun.build` in the same process (#1593, #2588). Covers both the child
 * `--preload` reproduction and every `fs.watch` import form under `bun test`,
 * where `syncBuiltinESMExports()` does not rewrite named or namespace ESM
 * bindings.
 */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fsDefault, * as fsNamespace from 'node:fs';
import { mkdtempSync, rmSync, watch as namedNodeFsWatch, type FSWatcher } from 'node:fs';
import { watch as namedFsWatch } from 'fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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

test('bun test preload intercepts close() across named, namespace, default, and CJS fs.watch imports (#2588)', async () => {
  const require = createRequire(import.meta.url);
  const cjsFs = require('node:fs') as { watch: typeof namedNodeFsWatch };
  const directory = mkdtempSync(join(tmpdir(), 'pyric-watcher-preload-'));
  const forms: Array<[string, () => FSWatcher]> = [
    ['named node:fs', () => namedNodeFsWatch(directory, () => {})],
    ['named fs', () => namedFsWatch(directory, () => {})],
    ['namespace node:fs', () => fsNamespace.watch(directory, () => {})],
    ['default node:fs', () => fsDefault.watch(directory, () => {})],
    ['cjs node:fs', () => cjsFs.watch(directory, () => {})],
  ];

  try {
    for (const [label, open] of forms) {
      const watcher = open();
      let closeCount = 0;
      watcher.on('change', () => {});
      watcher.on('close', () => {
        closeCount += 1;
      });
      watcher.close();
      watcher.close();
      await Promise.resolve();
      // Native FSWatcher.prototype.close() leaves change listeners attached and
      // installs no error absorber; the patched close() strips change listeners,
      // absorbs post-close errors, and emits close once.
      expect({ label, change: watcher.listenerCount('change'), error: watcher.listenerCount('error'), closeCount })
        .toEqual({ label, change: 0, error: 1, closeCount: 1 });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
