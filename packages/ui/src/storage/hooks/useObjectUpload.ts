import { useCallback, useRef, useState } from 'react';
import {
  ref as refFn,
  uploadBytes,
  type FirebaseStorage,
  type FullMetadata,
  type SettableMetadata,
} from 'pyric/storage';
import { folderPlaceholderRef } from '../folderPlaceholder.js';
import { normalizeStoragePath } from './usePathState.js';
import type { UseStorageListResult } from './useStorageList.js';

export type UploadTaskStatus = 'running' | 'success' | 'error';

/**
 * One file's upload, TASK-SHAPED for resumable forward-compat: the
 * byte counters and the `onProgress` callback are in the type NOW so
 * a future `uploadBytesResumable`-backed implementation emits real
 * intermediate snapshots without a breaking change. Today
 * (`pyric/storage` has no resumable uploads — COMPAT) a task
 * completes in one tick: `onProgress` fires once at 0 bytes and once
 * at `totalBytes`.
 */
export interface UploadTask {
  /** Stable id — key task rows on this, not on `fullPath` (two
   *  uploads can target the same path). */
  id: string;
  /** Bucket-rooted destination path. */
  fullPath: string;
  status: UploadTaskStatus;
  bytesTransferred: number;
  totalBytes: number;
  /** Populated on `'success'`. */
  metadata?: FullMetadata;
  /** Populated on `'error'` — a typed `StorageError` from the
   *  sandbox (`.code` is `storage/<code>`, e.g.
   *  `storage/unauthorized` for a rules-denied write) or whatever
   *  the prod backend threw. */
  error?: Error;
}

/** Explicit-path upload input. `path` is relative to the hook's
 *  `path` option (the destination folder). */
export interface UploadEntry {
  path: string;
  data: Blob | Uint8Array | ArrayBuffer;
  metadata?: SettableMetadata;
}

/**
 * `upload()` accepts plain `File`s (destination = the file's
 * `webkitRelativePath` when present — folder drops keep their
 * structure — else its `name`) or explicit {@link UploadEntry}s.
 */
export type UploadInput = File | UploadEntry;

export interface UseObjectUploadOptions {
  /** Destination folder, bucket-rooted. Default `''` (root). Wire to
   *  `usePathState().path` so uploads land in the browsed folder. */
  path?: string;
  /**
   * Optimistic seam from `useStorageList`: each upload inserts its
   * path immediately and rolls back via `removeItem` on failure.
   * Caveat: rolling back an upload that was OVERWRITING an existing
   * object drops that object's row locally (the seam can't tell an
   * optimistic row from a listed one) — `refresh()` restores server
   * truth.
   */
  list?: Pick<UseStorageListResult, 'insertItem' | 'removeItem'>;
  /** Task-shaped progress callback (see {@link UploadTask}). */
  onProgress?: (task: UploadTask) => void;
  /** Fired once per task reaching `'success'`. */
  onComplete?: (task: UploadTask) => void;
  /** Fired once per task reaching `'error'`. */
  onError?: (task: UploadTask) => void;
}

export interface UseObjectUploadResult {
  /** Every task started by this hook instance, oldest first. */
  tasks: UploadTask[];
  /** `true` while any task is `'running'`. */
  isUploading: boolean;
  /**
   * Upload one or many files. Tasks run concurrently; the promise
   * resolves with the settled tasks once ALL finish and never
   * rejects — per-file failures land on `task.error` (and
   * `onError`), so one bad file doesn't mask the others.
   */
  upload: (input: UploadInput | UploadInput[]) => Promise<UploadTask[]>;
  /**
   * Create an empty folder under the hook's `path`: writes the GCS
   * placeholder convention — a zero-byte object named `<path>/`
   * (trailing slash). `listAll` hides the placeholder from `items`
   * at every level (it only surfaces as a prefix), so the folder
   * appears in the browser with no phantom file inside.
   *
   * Sandbox-only today: the JS-SDK-shaped `ref()` normalizes the
   * trailing slash away, so the placeholder is written through a
   * structural value-object reference the sandbox accepts; prod
   * targets reject it (the `pyric/storage` follow-up is a
   * first-class placeholder API routing prod through the REST
   * `name=<path>/` upload). Throws the underlying error after
   * rolling back the optimistic prefix insert.
   */
  createFolder: (name: string) => Promise<void>;
  /** Drop settled (`success`/`error`) tasks from `tasks`. */
  clearCompleted: () => void;
}

function joinPath(base: string, child: string): string {
  if (base === '') return child;
  if (child === '') return base;
  return `${base}/${child}`;
}

function sizeOf(data: Blob | Uint8Array | ArrayBuffer): number {
  if (data instanceof Blob) return data.size;
  return data.byteLength;
}

function toEntry(input: UploadInput): UploadEntry {
  if (input instanceof Blob) {
    // File (the only Blob subtype `UploadInput` admits). Folder
    // drops carry `webkitRelativePath`; plain picks carry `name`.
    const file = input as File;
    const rel = (file as { webkitRelativePath?: string }).webkitRelativePath;
    return { path: rel || file.name, data: file };
  }
  return input;
}

/**
 * Multi-file upload over the package's single Storage handle prop.
 * Headless: returns task state; render it however you like (the
 * `<UploadDropzone>` component is one producer of `upload()` calls).
 *
 * Optimistic-with-rollback: with the `list` seam wired, each upload's
 * row appears in `useStorageList` immediately and disappears again if
 * the write fails (typed `StorageError` on `task.error`).
 */
export function useObjectUpload(
  storage: FirebaseStorage | null | undefined,
  options: UseObjectUploadOptions = {},
): UseObjectUploadResult {
  const base = normalizeStoragePath(options.path ?? '');
  const [tasks, setTasks] = useState<UploadTask[]>([]);

  // Latest-value refs so `upload`/`createFolder` stay referentially
  // stable across option changes (same pattern as the house hooks'
  // generation tokens — the callbacks read current options at call
  // time).
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const patchTask = useCallback((next: UploadTask) => {
    setTasks((prev) => prev.map((t) => (t.id === next.id ? next : t)));
  }, []);

  const upload = useCallback(
    async (input: UploadInput | UploadInput[]): Promise<UploadTask[]> => {
      if (storage == null) {
        throw new Error('useObjectUpload: storage handle is null');
      }
      const inputs = Array.isArray(input) ? input : [input];
      const started = inputs.map((raw) => {
        const entry = toEntry(raw);
        const task: UploadTask = {
          id: crypto.randomUUID(),
          fullPath: joinPath(base, normalizeStoragePath(entry.path)),
          status: 'running',
          bytesTransferred: 0,
          totalBytes: sizeOf(entry.data),
        };
        return { task, entry };
      });

      setTasks((prev) => [...prev, ...started.map((s) => s.task)]);
      for (const { task } of started) {
        optionsRef.current.list?.insertItem(task.fullPath);
        optionsRef.current.onProgress?.(task);
      }

      return Promise.all(
        started.map(async ({ task, entry }) => {
          try {
            const result = await uploadBytes(
              refFn(storage, task.fullPath),
              entry.data,
              entry.metadata,
            );
            const done: UploadTask = {
              ...task,
              status: 'success',
              bytesTransferred: task.totalBytes,
              metadata: result.metadata,
            };
            patchTask(done);
            optionsRef.current.onProgress?.(done);
            optionsRef.current.onComplete?.(done);
            return done;
          } catch (e) {
            const failed: UploadTask = {
              ...task,
              status: 'error',
              error: e instanceof Error ? e : new Error(String(e)),
            };
            // Roll the optimistic row back before surfacing.
            optionsRef.current.list?.removeItem(task.fullPath);
            patchTask(failed);
            optionsRef.current.onError?.(failed);
            return failed;
          }
        }),
      );
    },
    [storage, base, patchTask],
  );

  const createFolder = useCallback(
    async (name: string): Promise<void> => {
      if (storage == null) {
        throw new Error('useObjectUpload: storage handle is null');
      }
      const folderPath = joinPath(base, normalizeStoragePath(name));
      if (folderPath === '') {
        throw new Error('createFolder: folder name is empty');
      }
      // Trailing slash → the seam inserts a prefix, not an item.
      optionsRef.current.list?.insertItem(`${folderPath}/`);
      try {
        await uploadBytes(
          folderPlaceholderRef(storage, folderPath),
          new Blob([]),
          // Matches the emulator UI's placeholder content type.
          { contentType: 'text/plain' },
        );
      } catch (e) {
        optionsRef.current.list?.removeItem(folderPath);
        throw e;
      }
    },
    [storage, base],
  );

  const clearCompleted = useCallback(() => {
    setTasks((prev) => prev.filter((t) => t.status === 'running'));
  }, []);

  return {
    tasks,
    isUploading: tasks.some((t) => t.status === 'running'),
    upload,
    createFolder,
    clearCompleted,
  };
}
