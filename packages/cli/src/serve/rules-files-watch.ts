import { EventEmitter } from 'node:events';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';

/** The watch primitive, replaceable in tests. */
export type WatchFile = (file: string, listener: () => void) => Pick<FSWatcher, 'close' | 'on'>;

export interface RulesFilesWatch {
  /** Start watching files `files()` now lists, and stop watching files it no longer lists. */
  sync(): void;
  close(): void;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * Watch `file`, which may not exist yet. A missing file is watched through its
 * nearest existing ancestor directory; as each missing path segment appears
 * the watch moves down to it, and `listener` fires when the file itself
 * appears. From then on the file is watched directly.
 */
const watchFileOrWhenCreated: WatchFile = (file, listener) => {
  const events = new EventEmitter();
  let current: FSWatcher | null = null;
  let closed = false;

  const attach = (): void => {
    current?.close();
    current = null;
    let target = file;
    for (;;) {
      const next = target === file ? null : descendantOf(target);
      try {
        current = next === null
          ? watch(file, listener)
          : watch(target, (_event, name) => {
            const isNext = name !== null && String(name) === basename(next);
            if (!isNext || !existsSync(next) || closed) return;
            attach();
            if (next === file) listener();
          });
        break;
      } catch (error) {
        const parent = dirname(target);
        const isRoot = parent === target;
        if (!isMissing(error) || isRoot) throw error;
        target = parent;
      }
    }
    current.on('error', (error) => events.emit('error', error));
  };

  // The path one segment below `dir` on the way to `file`.
  const descendantOf = (dir: string): string => {
    let child = file;
    while (dirname(child) !== dir) child = dirname(child);
    return child;
  };

  attach();
  const handle = {
    close() {
      closed = true;
      current?.close();
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      events.on(event, handler);
      return handle;
    },
  };
  return handle as unknown as Pick<FSWatcher, 'close' | 'on'>;
};

/**
 * Watch a set of rules files that can change as the rules change: the rules
 * source and the module files it imports. `onChange` fires when any watched
 * file changes or a watched file that did not exist is created; call `sync()`
 * after a reload so newly imported files are watched and dropped ones are
 * released.
 */
export function watchRulesFiles(
  files: () => readonly string[],
  onChange: (file: string) => void,
  onError: (error: unknown) => void,
  watchFile: WatchFile = watchFileOrWhenCreated,
): RulesFilesWatch {
  const watchers = new Map<string, Pick<FSWatcher, 'close' | 'on'>>();
  const sync = (): void => {
    const wanted = new Set(files());
    for (const [file, watcher] of watchers) {
      if (wanted.has(file)) continue;
      watcher.close();
      watchers.delete(file);
    }
    for (const file of wanted) {
      if (watchers.has(file)) continue;
      const watcher = watchFile(file, () => onChange(file));
      watcher.on('error', onError);
      watchers.set(file, watcher);
    }
  };
  sync();
  return {
    sync,
    close() {
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}
