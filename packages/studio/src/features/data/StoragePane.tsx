/**
 * Live Storage viewer (F2), styled to `mocks/c-storage.html`.
 *
 * Composes `@pyric/ui/storage` over the Studio sandbox's `FirebaseStorage`
 * handle: a `PathBreadcrumb` + action row (New folder / Upload files) on top,
 * then a two-column body: an `ObjectBrowser` (folders-first listing,
 * name/type/size/updated columns, a read-denied row treatment driven by
 * `useStorageRulesGate`) on the left — wrapped in an `UploadDropzone` so
 * files and folders drop straight into the browsed folder — and an
 * `ObjectInspector` (content-type preview + metadata table + custom
 * metadata) on the right. When a `gs://` / storage-path cross-reference is
 * clicked elsewhere in Studio, `focusPath` drives the browser to that
 * object's folder and selects it.
 *
 * CREATE FOLDER (VS Code style): the "New folder" affordance discloses an
 * inline input that accepts nested paths — `stuff/things/cool` creates the
 * whole chain and navigates into the deepest folder. Mechanism: client-side
 * pending prefixes (`pendingPrefixReducer`), NOT placeholder objects — the
 * sandbox store stays clean; a pending folder materializes when the first
 * upload lands in it and disappears on reload if abandoned. The UI says so:
 * the pending empty state explains the lifecycle. (See
 * `@pyric/ui/storage`'s `pendingPrefixes.ts` for the
 * full decision record; the placeholder-object alternative remains available
 * as `useObjectUpload.createFolder`.)
 *
 * UPLOADS: the Upload button (multi-select file input) and the dropzone
 * (files AND folder trees via `webkitGetAsEntry`) both feed
 * `useObjectUpload` — concurrent per-file tasks, one failure never aborts
 * the rest; failures surface as a single inline error line (no tray UI).
 * Name collisions auto-rename with OS-copy semantics (`planBatchNames`):
 * `photo.png` → `photo (1).png`, `photo (1).png` → `photo (2).png`;
 * dropped folders rename at their root segment, keeping contents intact.
 *
 * Styling only: all data logic stays in the `@pyric/ui/storage` hooks +
 * components + pure modules. Visual roles come from `storage.css`
 * (token-driven).
 */

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  ObjectBrowser,
  ObjectInspector,
  PathBreadcrumb,
  UploadDropzone,
  useObjectUpload,
  useStorageList,
  useStorageRulesGate,
  usePathState,
  normalizeStoragePath,
  planBatchNames,
  pendingPrefixReducer,
  initialPendingPrefixes,
  pendingChildFolders,
  isPendingPrefix,
  folderInputError,
  type DroppedFile,
  type StorageListEntry,
} from '@pyric/ui/storage';
import type { FirebaseStorage, FullMetadata, StorageReference } from 'pyric/storage';
import { useDataNav } from './navigation.js';
import './storage.css';

export interface StoragePaneProps {
  storage: FirebaseStorage;
  /** An object path to focus (from a `gs://` cross-reference jump). */
  focusPath: string | null;
}

/** Parent folder of an object path (`a/b/c.png` → `a/b`; `c.png` → ``). */
function parentFolder(objectPath: string): string {
  const norm = normalizeStoragePath(objectPath);
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? '' : norm.slice(0, idx);
}

/** `a/b` + `c` → `a/b/c`; root-safe. */
function joinPath(base: string, child: string): string {
  if (base === '') return child;
  if (child === '') return base;
  return `${base}/${child}`;
}

/** Last path segment (task rows show the file name, not the full path). */
function lastSegment(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

/** Standard metadata fields, in the mock's order. Reads `FullMetadata` only. */
const META_FIELDS: ReadonlyArray<{
  key: string;
  label: string;
  value: (md: FullMetadata) => string | undefined;
}> = [
  { key: 'size', label: 'size', value: (md) => `${md.size} bytes` },
  { key: 'contentType', label: 'content type', value: (md) => md.contentType },
  { key: 'timeCreated', label: 'created', value: (md) => md.timeCreated },
  { key: 'updated', label: 'updated', value: (md) => md.updated },
  { key: 'md5Hash', label: 'md5', value: (md) => md.md5Hash },
  { key: 'cacheControl', label: 'cache control', value: (md) => md.cacheControl },
  { key: 'fullPath', label: 'path', value: (md) => `gs://${md.bucket}/${md.fullPath}` },
];

/** Grouped metadata table: standard fields, then a custom-metadata group. */
function renderMetadata(metadata: FullMetadata): ReactNode {
  const custom = Object.entries(metadata.customMetadata ?? {});
  return (
    <dl data-pyric-object-metadata>
      <div data-storage-meta-group>Metadata</div>
      {META_FIELDS.map(({ key, label, value }) => {
        const v = value(metadata);
        if (v === undefined) return null;
        return (
          <div key={key} data-pyric-metadata-field={key}>
            <dt>{label}</dt>
            <dd>{v}</dd>
          </div>
        );
      })}
      {custom.length > 0 ? (
        <div data-storage-meta-group>Custom metadata</div>
      ) : null}
      {custom.map(([k, v]) => (
        <div
          key={`custom:${k}`}
          data-pyric-metadata-field="customMetadata"
          data-pyric-metadata-key={k}
        >
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Inline line-style glyphs (stroke-only, current-color) for the name cell —
 *  no icon library; drawn to match the product's line weight. */
function FolderGlyph() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinejoin="round"
    >
      <path d="M1.75 4.25c0-.55.45-1 1-1h3.4l1.5 1.7h5.6c.55 0 1 .45 1 1v6.05c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1z" />
    </svg>
  );
}

function FileGlyph() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinejoin="round"
    >
      <path d="M4.25 1.75h5l3 3v9.5h-8z" />
      <path d="M9.25 1.75v3h3" />
    </svg>
  );
}

/** Row label slot: the 4-column cells inside each entry button. Folder rows
 *  get a folder glyph, file rows a file glyph. Pending (session-only) folders
 *  render like any other folder — the mechanism stays; no badge. */
function renderEntry(entry: StorageListEntry): ReactNode {
  const isFolder = entry.kind === 'folder';
  return (
    <>
      <span className="storage__cell-name">
        <span className="storage__ic" aria-hidden>
          {isFolder ? <FolderGlyph /> : <FileGlyph />}
        </span>
        <span className="storage__nm">{entry.name}</span>
        {isFolder ? (
          <span aria-hidden className="storage__chev">
            ›
          </span>
        ) : null}
      </span>
      <span className="storage__cell-type">{isFolder ? 'folder' : 'file'}</span>
      <span className="storage__cell-size" />
      <span className="storage__cell-updated" />
    </>
  );
}

export function LiveStoragePane({ storage, focusPath }: StoragePaneProps) {
  const nav = useDataNav();
  const pathState = usePathState();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // Selecting an object writes the hash (#storage/<path>) so it's deep-linkable
  // + reload-persistent; folder navigation / back clears it. The `focusPath`
  // seed below reads the hash (descend + select on a deep-link/cross-ref).
  const selectObject = (objectPath: string | null) => {
    setSelectedPath(objectPath);
    nav.navigate({ view: 'storage', objectPath });
  };
  const list = useStorageList(storage, pathState.path);
  // Pre-flight read verdicts → the read-denied row treatment (advisory).
  const gate = useStorageRulesGate(storage);

  // Session-only created folders (see the pending-prefix decision above).
  const [pending, dispatchPending] = useReducer(
    pendingPrefixReducer,
    initialPendingPrefixes,
  );
  const uploader = useObjectUpload(storage, {
    path: pathState.path,
    list,
    // A landed upload makes its folder chain real — retire it from pending
    // so the row's provenance flips from "session" to server truth.
    onComplete: (task) =>
      dispatchPending({ type: 'materialize', path: parentFolder(task.fullPath) }),
  });

  // External evidence beats session state: when the real listing surfaces a
  // folder we were still holding as pending (another tab/agent wrote into it,
  // or a refresh raced our materialize dispatch), retire it — otherwise the
  // row wears a false "session-only" badge over a server-truth folder.
  useEffect(() => {
    if (list.status !== 'success') return;
    for (const entry of list.entries) {
      if (entry.kind === 'folder' && isPendingPrefix(pending, entry.fullPath)) {
        dispatchPending({ type: 'materialize', path: entry.fullPath });
      }
    }
  }, [list.status, list.entries, pending]);

  // Create-folder disclosure (inline row, not a modal — C3).
  const [creating, setCreating] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [folderError, setFolderError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Merge pending child folders into the listing (dedup against real
  // prefixes), keeping the folders-first, name-sorted row order.
  const entries = useMemo<StorageListEntry[]>(() => {
    const names = pendingChildFolders(pending, pathState.path).filter(
      (name) => !list.entries.some((e) => e.kind === 'folder' && e.name === name),
    );
    if (names.length === 0) return list.entries;
    const synthetic = names.map((name) => {
      const fullPath = joinPath(pathState.path, name);
      return {
        kind: 'folder' as const,
        name,
        fullPath,
        // Folder rows navigate via `fullPath` and never dereference `.ref`
        // (see ObjectBrowser) — a structural stub keeps the entry total.
        ref: { fullPath, name } as unknown as StorageReference,
      };
    });
    const folders = [
      ...list.entries.filter((e) => e.kind === 'folder'),
      ...synthetic,
    ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return [...folders, ...list.entries.filter((e) => e.kind === 'object')];
  }, [list.entries, pending, pathState.path]);

  // Upload a batch into the browsed folder, OS-copy renaming collisions
  // against the folder's direct children (real + pending + this batch).
  const uploadFiles = (files: DroppedFile[]) => {
    const taken = new Set(entries.map((e) => e.name));
    const paths = planBatchNames(
      files.map((f) => f.relativePath),
      taken,
    );
    void uploader.upload(files.map((f, i) => ({ path: paths[i], data: f.file })));
  };

  const submitFolder = (e: FormEvent) => {
    e.preventDefault();
    const err = folderInputError(folderName);
    if (err) {
      setFolderError(err);
      return;
    }
    const full = joinPath(pathState.path, normalizeStoragePath(folderName));
    dispatchPending({ type: 'create', path: full });
    // VS Code semantics: creating `stuff/things/cool` lands you inside it.
    pathState.setPath(full);
    selectObject(null);
    setFolderName('');
    setFolderError(null);
    setCreating(false);
  };

  // Honor a cross-ref jump: descend to the object's folder and select it.
  useEffect(() => {
    if (focusPath) {
      const norm = normalizeStoragePath(focusPath);
      pathState.setPath(parentFolder(norm));
      setSelectedPath(norm);
    }
    // pathState.setPath is stable; focusPath is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPath]);

  const failed = uploader.tasks.filter((t) => t.status === 'error');
  // Advisory pre-flight for the drop target (the gate's canonical wiring —
  // see UploadDropzone's `disabledReason` doc). Conservative: no size or
  // contentType is known before the drop.
  const writeVerdict = gate.verdictFor(pathState.path);

  return (
    <div className="storage">
      <div className="storage__sub">
        <PathBreadcrumb
          path={pathState.path}
          rootLabel="files"
          onNavigate={(p) => {
            pathState.setPath(p);
            selectObject(null);
          }}
        />
        <div className="storage__actions">
          <button
            type="button"
            className="storage__action"
            aria-expanded={creating}
            onClick={() => {
              setCreating((v) => !v);
              setFolderError(null);
            }}
          >
            New folder
          </button>
          <button
            type="button"
            className="storage__action storage__action--upload"
            onClick={() => fileInputRef.current?.click()}
          >
            Upload files
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const picked = Array.from(e.currentTarget.files ?? []);
              if (picked.length > 0) {
                uploadFiles(picked.map((f) => ({ file: f, relativePath: f.name })));
              }
              e.currentTarget.value = '';
            }}
          />
        </div>
      </div>

      {creating ? (
        <form className="storage__newfolder" onSubmit={submitFolder}>
          <input
            autoFocus
            className="storage__newfolder-input"
            placeholder="folder or nested/path/of/folders"
            aria-label="New folder name"
            value={folderName}
            onChange={(e) => {
              setFolderName(e.currentTarget.value);
              setFolderError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setCreating(false);
            }}
          />
          <button type="submit" className="storage__newfolder-btn">
            Create
          </button>
          {folderError ? (
            <span className="storage__newfolder-err" role="alert">
              {folderError}
            </span>
          ) : (
            <span className="storage__newfolder-note">
              Nested paths create the whole chain. Empty folders last this
              session only — upload a file to keep one.
            </span>
          )}
        </form>
      ) : null}

      {failed.length > 0 ? (
        <p className="storage__upload-err" role="alert">
          {failed.length === 1
            ? `Upload failed: ${lastSegment(failed[0]!.fullPath)} — ${
                failed[0]!.error?.message ?? 'error'
              }`
            : `${failed.length} uploads failed: ${failed
                .map((t) => lastSegment(t.fullPath))
                .join(', ')}`}
          <button
            type="button"
            className="storage__upload-err-dismiss"
            onClick={uploader.clearCompleted}
          >
            Dismiss
          </button>
        </p>
      ) : null}

      <div
        className="storage__body"
        data-storage-level={selectedPath ? 'inspector' : 'browser'}
      >
        <UploadDropzone
          className="storage__browser"
          onFiles={uploadFiles}
          disabled={!writeVerdict.upload}
          disabledReason={writeVerdict.reasons.write.join('; ')}
        >
          <div className="storage__lhead">
            <span>name</span>
            <span>type</span>
            <span>size</span>
            <span>updated</span>
          </div>
          <ObjectBrowser
            entries={entries}
            status={list.status}
            error={list.error}
            gate={gate}
            selectedPath={selectedPath ?? undefined}
            renderEntry={renderEntry}
            onNavigate={(p) => {
              pathState.enter(p);
              selectObject(null);
            }}
            onSelect={(ref) => selectObject(ref.fullPath)}
            emptyState={
              <p className="storage__empty">
                {isPendingPrefix(pending, pathState.path)
                  ? 'Empty folder — session-only until a file is uploaded ' +
                    'here. Drop files anywhere in this pane, or use Upload files.'
                  : 'No files yet. Drop files here or use Upload files; files ' +
                    'your app uploads to Storage also appear here.'}
              </p>
            }
          />
          <div className="storage__dropcue" aria-hidden>
            Drop to upload to /{pathState.path || ''}
          </div>
        </UploadDropzone>

        <div className="storage__inspector">
          {selectedPath ? (
            <>
              <button
                type="button"
                className="storage__back"
                onClick={() => selectObject(null)}
                aria-label="Back to files"
              >
                ‹ Files
              </button>
              <ObjectInspector
                storage={storage}
                path={selectedPath}
                renderMetadata={renderMetadata}
              />
            </>
          ) : (
            <p className="storage__inspector-hint">
              Select an object to inspect its preview and metadata.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
