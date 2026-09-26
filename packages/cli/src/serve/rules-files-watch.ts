import { watch, type FSWatcher } from 'node:fs';

/** The watch primitive, replaceable in tests. */
export type WatchFile = (file: string, listener: () => void) => Pick<FSWatcher, 'close' | 'on'>;

export interface RulesFilesWatch {
  /** Start watching files `files()` now lists, and stop watching files it no longer lists. */
  sync(): void;
  close(): void;
}

/**
 * Watch a set of rules files that can change as the rules change: the rules
 * source and the module files it imports. `onChange` fires when any watched
 * file changes; call `sync()` after a reload so newly imported files are
 * watched and dropped ones are released.
 */
export function watchRulesFiles(
  files: () => readonly string[],
  onChange: (file: string) => void,
  onError: (error: unknown) => void,
  watchFile: WatchFile = (file, listener) => watch(file, listener),
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
