/**
 * Preloaded by bunfig.toml for every `bun test` run in packages/cli. Under Bun
 * 1.3.11, closing an `fs.watch` watcher before Bun has finished opening the
 * entries of its directory leaves the bundler waiting forever: every later
 * `Bun.build` in that process hangs, and so can later module loading. A Vite
 * dev server or a rules/workspace watcher made and closed quickly does exactly
 * that, and whichever build came next in the shared test process timed out
 * (#1593, #2588).
 *
 * Under `bun test`, `syncBuiltinESMExports()` updates CJS/default `fs.watch`
 * (used by chokidar), but named and namespace ESM `import { watch } from
 * 'node:fs'` bindings keep calling the original function. Patching
 * `FSWatcher.prototype.close` intercepts `.close()` for every import form.
 *
 * A watcher left open and unref'd does no harm, so here `close()` only stops
 * delivering. The real watcher stays open and reachable until the process
 * exits.
 *
 * To remove this: on a newer Bun, take this file out of bunfig.toml and run
 * `bun run fixtures/watcher-close-then-build.ts` from this folder, which prints
 * `built` once that Bun has fixed this.
 */
import type { FSWatcher } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';

type Watch = (...args: unknown[]) => FSWatcher;
type WatcherPrototype = { close: (this: FSWatcher) => void; [PATCHED]?: boolean };

const PATCHED = Symbol.for('pyric.keepRealWatchersOpen');

/** Writable, unlike the bindings of an ESM import, and the object chokidar calls `watch` on. */
const fsModule = createRequire(import.meta.url)('node:fs') as { watch: Watch };
const realWatch = fsModule.watch;
const retained = new Set<FSWatcher>();
const closed = new Set<FSWatcher>();

function keepOpenOnClose(watcher: FSWatcher): void {
  if (closed.has(watcher)) return;
  closed.add(watcher);
  retained.add(watcher);
  watcher.removeAllListeners('change');
  watcher.removeAllListeners('error');
  // A watched directory deleted later still reports an error here.
  watcher.on('error', () => {});
  watcher.unref();
  queueMicrotask(() => {
    watcher.emit('close');
    watcher.removeAllListeners('close');
  });
}

const probe = realWatch(import.meta.dir, () => {});
probe.unref();
retained.add(probe);
const watcherProto = Object.getPrototypeOf(probe) as WatcherPrototype;
if (!watcherProto[PATCHED]) {
  watcherProto[PATCHED] = true;
  watcherProto.close = function close(): void {
    keepOpenOnClose(this);
  };
}

fsModule.watch = (...args) => {
  const watcher = realWatch(...args);
  retained.add(watcher);
  return watcher;
};
syncBuiltinESMExports();
