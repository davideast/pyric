/**
 * Live Storage viewer (F2), styled to `mocks/c-storage.html`.
 *
 * Composes `@pyric/ui/storage` over the Studio sandbox's `FirebaseStorage`
 * handle: a `PathBreadcrumb` + action row on top, then a two-column body:
 * an `ObjectBrowser` (folders-first listing, name/type/size/updated columns,
 * a read-denied row treatment driven by `useStorageRulesGate`) on the left,
 * and an `ObjectInspector` (content-type preview + metadata table + custom
 * metadata) on the right. When a `gs://` / storage-path cross-reference is
 * clicked elsewhere in Studio, `focusPath` drives the browser to that object's
 * folder and selects it.
 *
 * Styling only: all data logic stays in the `@pyric/ui/storage` hooks +
 * components. Visual roles come from `storage.css` (token-driven).
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ObjectBrowser,
  ObjectInspector,
  PathBreadcrumb,
  useStorageList,
  useStorageRulesGate,
  usePathState,
  normalizeStoragePath,
  type StorageListEntry,
} from '@pyric/ui/storage';
import type { FirebaseStorage, FullMetadata } from 'pyric/storage';
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

/** Row label slot: the 4-column cells inside each entry button. */
function renderEntry(entry: StorageListEntry): ReactNode {
  const isFolder = entry.kind === 'folder';
  return (
    <>
      <span className="storage__cell-name">
        {isFolder ? <span className="storage__ic">DIR</span> : null}
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
        {/* Delete / Upload were inert placeholders. Removed (subtractive): they
            return only when wired to real storage ops. */}
      </div>

      <div
        className="storage__body"
        data-storage-level={selectedPath ? 'inspector' : 'browser'}
      >
        <div className="storage__browser">
          <div className="storage__lhead">
            <span>name</span>
            <span>type</span>
            <span>size</span>
            <span>updated</span>
          </div>
          <ObjectBrowser
            entries={list.entries}
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
                No files yet. Files your app uploads to Storage will appear here.
              </p>
            }
          />
        </div>

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
