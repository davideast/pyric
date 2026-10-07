/**
 * Debounced write-back for the file editor. Holds the pending timer and
 * the last content known to be on disk per path. A pending save is
 * dropped when the file on disk no longer matches that baseline, because
 * the disk content came from a newer writer (an agent tool, a git
 * checkout) and the pending text was typed against the superseded
 * version.
 *
 * The check runs in two places so neither ordering loses the newer
 * write: `observe` when the editor reloads a file, and again immediately
 * before the save touches the disk.
 */

export interface DebouncedFileWriterOptions {
  delayMs: number;
  read: (path: string) => Promise<string>;
  write: (path: string, content: string) => Promise<void>;
  onWritten: (path: string, content: string) => void;
  onError: (err: unknown) => void;
}

export interface DebouncedFileWriter {
  /** Schedule a save of `content` to `path`, replacing any pending save. */
  schedule(path: string, content: string): void;
  /**
   * Record content just read from `path`. Returns true when it differs
   * from the last known on-disk content, in which case a pending save
   * for that path is dropped.
   */
  observe(path: string, content: string): boolean;
  hasPending(path: string): boolean;
  cancel(): void;
}

export function createDebouncedFileWriter(opts: DebouncedFileWriterOptions): DebouncedFileWriter {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingPath: string | null = null;
  const baselines = new Map<string, string>();

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pendingPath = null;
  };

  return {
    schedule(path, content) {
      clearTimer();
      pendingPath = path;
      timer = setTimeout(async () => {
        timer = null;
        pendingPath = null;
        try {
          const baseline = baselines.get(path);
          if (content === baseline) return;
          if (baseline !== undefined) {
            const onDisk = await opts.read(path).catch(() => baseline);
            if (onDisk !== baseline) {
              baselines.set(path, onDisk);
              return;
            }
          }
          await opts.write(path, content);
          baselines.set(path, content);
          opts.onWritten(path, content);
        } catch (err) {
          opts.onError(err);
        }
      }, opts.delayMs);
    },
    observe(path, content) {
      const baseline = baselines.get(path);
      baselines.set(path, content);
      const external = baseline !== undefined && baseline !== content;
      if (external && pendingPath === path) clearTimer();
      return external;
    },
    hasPending: (path) => pendingPath === path,
    cancel: clearTimer,
  };
}
