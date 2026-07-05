import { useCallback, useRef, useState, type DragEvent, type ReactNode } from 'react';

/** One dropped file, flattened from the drop's file/folder tree. */
export interface DroppedFile {
  file: File;
  /**
   * Path relative to the drop — `'a.txt'` for a plain file drop,
   * `'photos/cat.png'` for a file inside a dropped folder. Feed
   * straight into `useObjectUpload`:
   * `upload(files.map((f) => ({ path: f.relativePath, data: f.file })))`.
   */
  relativePath: string;
}

export interface UploadDropzoneProps {
  /**
   * Fired once per drop with the flattened file list (folder drops
   * are traversed recursively via `webkitGetAsEntry`; empty folders
   * yield nothing — wire `useObjectUpload.createFolder` to your own
   * "new folder" affordance instead). Not fired for empty drops.
   */
  onFiles: (files: DroppedFile[]) => void;
  /** Slot — the dropzone chrome ("Drop files here…", a browse
   *  `<input type="file">`, anything). The component owns only the
   *  drag wiring + `data-*` states. */
  children?: ReactNode;
  /** Ignore drops + suppress the dragging state. */
  disabled?: boolean;
  /**
   * Why the dropzone is disabled — stamped on
   * `data-disabled-reason` (and only while `disabled`) so the
   * chrome/styling can surface it. The canonical source is the rules
   * gate: `disabled={!gate.verdictFor(path).upload}` +
   * `disabledReason={gate.verdictFor(path).reasons.write.join('; ')}`.
   */
  disabledReason?: string;
  className?: string;
}

/**
 * Walk a `FileSystemEntry` tree depth-first, accumulating files with
 * folder-relative paths. `readEntries` is batched per spec (Chrome
 * caps a batch at 100) — loop until an empty batch.
 */
async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: DroppedFile[],
): Promise<void> {
  const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    out.push({ file, relativePath: path });
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) break;
      for (const child of batch) {
        await walkEntry(child, path, out);
      }
    }
  }
}

/**
 * Flatten a drop's `DataTransfer` into files. Prefers the
 * `webkitGetAsEntry` tree (the only channel that exposes folder
 * structure); items without it fall back to `getAsFile`, and a
 * `DataTransfer` with no usable `items` falls back to `files`.
 */
async function collectDroppedFiles(dt: DataTransfer): Promise<DroppedFile[]> {
  const out: DroppedFile[] = [];
  const items = dt.items ? Array.from(dt.items) : [];
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const getEntry = (
      item as { webkitGetAsEntry?: () => FileSystemEntry | null }
    ).webkitGetAsEntry;
    const entry = typeof getEntry === 'function' ? getEntry.call(item) : null;
    if (entry) {
      await walkEntry(entry, '', out);
    } else {
      const file = item.getAsFile?.();
      if (file) out.push({ file, relativePath: file.name });
    }
  }
  if (out.length === 0) {
    for (const file of Array.from(dt.files ?? [])) {
      out.push({ file, relativePath: file.name });
    }
  }
  return out;
}

/**
 * Headless drop target for file + folder uploads. Slot-based: the
 * children render the chrome; the component owns drag wiring and
 * stamps `data-dragging` while a drag hovers (a counter tracks
 * enter/leave pairs so crossing child elements doesn't flicker).
 *
 * Ships no visual styling. Consumers style via:
 * - `[data-pyric-ui="upload-dropzone"]` — the root
 * - `…[data-dragging]` — a drag is hovering
 * - `…[data-disabled]`
 * - `…[data-disabled-reason="…"]` — why (e.g. a denied write verdict)
 */
export function UploadDropzone({
  onFiles,
  children,
  disabled,
  disabledReason,
  className,
}: UploadDropzoneProps) {
  const [dragging, setDragging] = useState(false);
  // dragenter/dragleave fire for every child crossing — count the
  // pairs and only clear at depth 0.
  const depthRef = useRef(0);

  const handleDragEnter = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (disabled) return;
      depthRef.current += 1;
      setDragging(true);
    },
    [disabled],
  );

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    // Required — without preventDefault the browser refuses the drop.
    e.preventDefault();
  }, []);

  const handleDragLeave = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (disabled) return;
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current === 0) setDragging(false);
    },
    [disabled],
  );

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      depthRef.current = 0;
      setDragging(false);
      if (disabled) return;
      const dt = e.dataTransfer;
      if (!dt) return;
      void collectDroppedFiles(dt).then((files) => {
        if (files.length > 0) onFiles(files);
      });
    },
    [disabled, onFiles],
  );

  return (
    <div
      className={className}
      data-pyric-ui="upload-dropzone"
      data-dragging={dragging ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
      data-disabled-reason={disabled ? disabledReason : undefined}
      aria-disabled={disabled || undefined}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {children}
    </div>
  );
}
