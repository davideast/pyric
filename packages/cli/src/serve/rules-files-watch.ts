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

/** The file-system calls a missing-file watch makes, replaceable in tests. */
export interface WatchFileSystem {
  watch(path: string, listener: (event: string, name: string | Buffer | null) => void): FSWatcher;
  existsSync(path: string): boolean;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * Watch `file`, which may or may not exist. The file is watched through its
 * directory, so `listener` fires when the file is created, changed, deleted,
 * or atomically replaced. A missing directory is watched through its nearest
 * existing ancestor; as each missing path segment appears the watch moves
 * down to it, and `listener` fires if the file itself appeared with it.
 */
export const watchFileOrWhenCreatedWith = (fileSystem: WatchFileSystem): WatchFile => (file, listener) => {
  const events = new EventEmitter();
  let current: FSWatcher | null = null;
  let closed = false;
  const directory = dirname(file);
  const fileName = basename(file);

  const attach = (): void => {
    current?.close();
    current = null;
    let target = directory;
    for (;;) {
      const next = target === directory ? null : descendantOf(target);
      try {
        current = next === null
          ? fileSystem.watch(directory, (_event, name) => {
            // A null name cannot be ruled out as the file, so it counts.
            const isFile = name === null || String(name) === fileName;
            if (!isFile || closed) return;
            listener();
          })
          : fileSystem.watch(target, (_event, name) => {
            const isNext = name !== null && String(name) === basename(next);
            if (!isNext || !fileSystem.existsSync(next) || closed) return;
            // Move the watch after this callback returns: attach() closes the
            // watcher that is delivering this event.
            setImmediate(() => {
              if (closed) return;
              attach();
              // The directory and the file can appear together, as with
              // `mkdir -p` followed by a write before the watch moves down.
              if (next === directory && fileSystem.existsSync(file)) listener();
            });
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

const watchFileOrWhenCreated = watchFileOrWhenCreatedWith({ watch, existsSync });

/**
 * Watch a set of rules files that can change as the rules change: the rules
 * source and the module files it imports. `onChange` fires when any watched
 * file changes, is deleted, or is created after it did not exist; call `sync()`
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
