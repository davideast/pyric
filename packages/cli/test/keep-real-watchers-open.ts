/**
 * Preloaded by bunfig.toml for every `bun test` run in packages/cli. Under Bun
 * 1.3.11, closing an `fs.watch` watcher before Bun has finished opening the
 * entries of its directory leaves the bundler waiting forever: every later
 * `Bun.build` in that process hangs, and so can later module loading. A Vite
 * dev server made and closed quickly does exactly that, through chokidar, and
 * whichever build came next in the shared test process timed out.
 *
 * A watcher left open does no harm, so here `close()` only stops delivering.
 * The real watcher stays open and reachable until the process exits.
 *
 * To remove this: on a newer Bun, take this file out of bunfig.toml and run
 * `bun run fixtures/watcher-close-then-build.ts` from this folder, which prints
 * `built` once that Bun has fixed this.
 */
import type { FSWatcher } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';

type Watch = (...args: unknown[]) => FSWatcher;

/** Writable, unlike the bindings of an ESM import, and the object chokidar calls `watch` on. */
const fsModule = createRequire(import.meta.url)('node:fs') as { watch: Watch };
const realWatch = fsModule.watch;
const retained: FSWatcher[] = [];

fsModule.watch = (...args) => {
  const watcher = realWatch(...args);
  retained.push(watcher);
  watcher.close = () => {
    watcher.removeAllListeners();
    // A watched directory deleted later still reports an error here.
    watcher.on('error', () => {});
    queueMicrotask(() => watcher.emit('close'));
  };
  return watcher;
};
syncBuiltinESMExports();
