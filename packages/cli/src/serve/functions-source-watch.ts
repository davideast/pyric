import { lstatSync, readdirSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

export interface FunctionsSourceWatch {
  close(): void;
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function isRealDirectory(candidatePath: string): boolean {
  try {
    return lstatSync(candidatePath).isDirectory();
  } catch (error: unknown) {
    void error;
    return false;
  }
}

function hasIgnoredSegment(rootDir: string, candidatePath: string): boolean {
  const relative = path.relative(rootDir, candidatePath);
  if (relative === '') return false;
  if (relative.startsWith('..') || path.isAbsolute(relative)) return true;
  const parts = relative.split(path.sep);
  return parts.includes('node_modules') || parts.includes('.git');
}

/**
 * Synchronously attach native directory watches across `sourceDir` (excluding
 * `node_modules` and `.git`) so edits immediately after dev-server startup or
 * inside Chokidar's 50 ms `EV_CHANGE` throttle / coarse `mtimeMs` window still
 * schedule a Functions reload (#1076). Rearms after `ENOENT` directory-open
 * races under Bun (`rules-files-watch.ts`).
 */
export function watchFunctionsSourceDirectory(
  sourceDir: string,
  onFileEvent: (filePath: string) => void,
): FunctionsSourceWatch {
  const rootDir = path.resolve(sourceDir);
  const watchers = new Map<string, FSWatcher>();
  let closed = false;

  const syncSubtree = (dir: string): void => {
    if (closed || hasIgnoredSegment(rootDir, dir) || !isRealDirectory(dir)) return;
    if (!watchers.has(dir)) {
      attachDirectory(dir);
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error: unknown) {
      void error;
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      syncSubtree(path.join(dir, entry.name));
    }
  };

  const attachDirectory = (dir: string): void => {
    if (closed) return;
    let watcher: FSWatcher;
    try {
      watcher = watch(dir, (_event, rawName) => {
        if (closed || watchers.get(dir) !== watcher) return;
        if (rawName === null) {
          onFileEvent(path.join(dir, '__changed__'));
          return;
        }
        const changedPath = path.join(dir, String(rawName));
        if (hasIgnoredSegment(rootDir, changedPath)) return;
        syncSubtree(changedPath);
        onFileEvent(changedPath);
      });
    } catch (error: unknown) {
      void error;
      return;
    }
    watcher.unref();
    watchers.set(dir, watcher);
    watcher.on('error', (error: unknown) => {
      if (closed || watchers.get(dir) !== watcher) return;
      watcher.close();
      watchers.delete(dir);
      if (isMissingError(error)) {
        setImmediate(() => {
          if (closed || !isRealDirectory(dir)) return;
          syncSubtree(dir);
          onFileEvent(path.join(dir, '__rearmed__'));
        });
      }
    });
  };

  syncSubtree(rootDir);

  return {
    close(): void {
      if (closed) return;
      closed = true;
      for (const watcher of watchers.values()) {
        watcher.close();
      }
      watchers.clear();
    },
  };
}
