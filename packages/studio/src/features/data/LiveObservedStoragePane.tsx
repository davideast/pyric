/**
 * Read-only Observed Storage metadata browser for Studio in Live mode (`#2542`).
 *
 * Composes `@pyric/ui/storage`'s `PathBreadcrumb`, `ObjectBrowser`, and
 * `ObjectInspector` over the live session's bounded, in-memory Storage catalog:
 *   - Supports multiple observed buckets via a tab bar (`data-storage-bucket-bar`).
 *   - Renders folder prefix trees, session delete tombstones, and observed
 *     object metadata (`contentType`, `size`, timestamps, `md5Hash`,
 *     `cacheControl`, and verbatim `customMetadata`).
 *   - Exposes zero mutation affordances (no Upload, New folder, dropzone, or
 *     Delete controls) and never invokes `getBlob` — overriding `ObjectInspector`
 *     previews with a metadata-only preview (`needsBlob: false`) offering
 *     `Copy gs:// URI` / `Copy path` controls and surfacing any observed
 *     Firebase/GCS Storage download URL directly.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  ObjectBrowser,
  ObjectInspector,
  PathBreadcrumb,
  normalizeStoragePath,
  usePathState,
  useStorageList,
  type StorageListEntry,
  type StoragePreview,
} from '@pyric/ui/storage';
import type { FirebaseStorage, FullMetadata } from 'pyric/storage';
import type {
  ObservedStorageBucketSnapshot,
  ObservedStorageBucketSummary,
  ObservedStorageObjectMetadata,
} from '../../shell/observed-storage-mirror.js';
import { useDataNav } from './navigation.js';
import './storage.css';
import './live-observed-storage-pane.css';

export interface LiveObservedStoragePaneProps {
  storage: FirebaseStorage;
  activeBucket: string;
  bucketSummaries: readonly ObservedStorageBucketSummary[];
  onSelectBucket: (bucket: string) => void;
  bucketCatalog: ObservedStorageBucketSnapshot | undefined;
  hasObservedStorage: boolean;
  focusTarget: { kind: 'root' } | { kind: 'prefix' | 'object'; path: string };
}

function parentFolder(objectPath: string): string {
  const norm = normalizeStoragePath(objectPath);
  const idx = norm.lastIndexOf('/');
  if (idx === -1) return '';
  return norm.slice(0, idx);
}

function lookupObservedObject(
  catalog: ObservedStorageBucketSnapshot | undefined,
  fullPath: string,
): ObservedStorageObjectMetadata | undefined {
  if (!catalog) return undefined;
  return catalog.objects[normalizeStoragePath(fullPath)];
}

function formatObservedSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatInspectorSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return 'not observed (list-only)';
  if (bytes < 1024) return `${bytes} bytes`;
  return `${formatObservedSize(bytes)} (${bytes} bytes)`;
}

function countPhrase(count: number, singular: string, plural: string): string {
  if (count === 1) return `1 ${singular}`;
  return `${count} ${plural}`;
}

function bucketPillMeta(item: ObservedStorageBucketSummary): string {
  if (!item.observed) return 'no traffic';
  if (item.objectCount > 0) return countPhrase(item.objectCount, 'object', 'objects');
  if (item.prefixCount > 0) return countPhrase(item.prefixCount, 'prefix', 'prefixes');
  if (item.deletedCount > 0) return countPhrase(item.deletedCount, 'deleted', 'deleted');
  return '0 objects';
}

function bucketPillClassName(item: ObservedStorageBucketSummary, active: boolean): string {
  const classes = ['storage__bucket-pill'];
  if (active) classes.push('storage__bucket-pill--active');
  if (!item.observed) classes.push('storage__bucket-pill--idle');
  return classes.join(' ');
}

function deletedPathsAtPrefix(
  catalog: ObservedStorageBucketSnapshot | undefined,
  prefix: string,
): readonly string[] {
  const deleted = catalog?.deleted;
  if (!deleted || deleted.length === 0) return [];
  const normPrefix = normalizeStoragePath(prefix);
  if (normPrefix.length === 0) return deleted;
  const scan = `${normPrefix}/`;
  return deleted.filter((item) => item === normPrefix || item.startsWith(scan));
}

function selectCustomMetadata(
  observed: ObservedStorageObjectMetadata | undefined,
  metadata: FullMetadata,
): Readonly<Record<string, string>> {
  if (observed?.customMetadata !== undefined) return observed.customMetadata;
  if (metadata.customMetadata !== undefined) return metadata.customMetadata;
  return {};
}

function FolderGlyph() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round">
      <path d="M1.75 4.25c0-.55.45-1 1-1h3.4l1.5 1.7h5.6c.55 0 1 .45 1 1v6.05c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1z" />
    </svg>
  );
}

function FileGlyph() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round">
      <path d="M4.25 1.75h5l3 3v9.5h-8z" />
      <path d="M9.25 1.75v3h3" />
    </svg>
  );
}

function renderObservedEntry(
  entry: StorageListEntry,
  catalog: ObservedStorageBucketSnapshot | undefined,
): ReactNode {
  if (entry.kind === 'folder') {
    return (
      <>
        <span className="storage__cell-name">
          <span className="storage__ic" aria-hidden>
            <FolderGlyph />
          </span>
          <span className="storage__nm">{entry.name}</span>
          <span aria-hidden className="storage__chev">
            ›
          </span>
        </span>
        <span className="storage__cell-type">folder</span>
        <span className="storage__cell-size" />
        <span className="storage__cell-updated" />
      </>
    );
  }
  const observed = lookupObservedObject(catalog, entry.fullPath);
  let typeLabel = 'object';
  if (observed?.contentType !== undefined && observed.contentType.length > 0) {
    typeLabel = observed.contentType;
  }
  const sizeLabel = formatObservedSize(observed?.size);
  const updatedLabel = observed?.updated ?? '—';
  return (
    <>
      <span className="storage__cell-name">
        <span className="storage__ic" aria-hidden>
          <FileGlyph />
        </span>
        <span className="storage__nm">{entry.name}</span>
      </span>
      <span className="storage__cell-type">{typeLabel}</span>
      <span className="storage__cell-size">{sizeLabel}</span>
      <span className="storage__cell-updated">{updatedLabel}</span>
    </>
  );
}

interface MetadataRow {
  readonly key: string;
  readonly label: string;
  readonly value: string | undefined;
}

function buildMetadataRows(
  metadata: FullMetadata,
  observed: ObservedStorageObjectMetadata | undefined,
): readonly MetadataRow[] {
  return [
    { key: 'fullPath', label: 'path', value: `gs://${metadata.bucket}/${metadata.fullPath}` },
    { key: 'size', label: 'size', value: formatInspectorSize(observed?.size) },
    { key: 'contentType', label: 'content type', value: observed?.contentType },
    { key: 'timeCreated', label: 'created', value: observed?.timeCreated },
    { key: 'updated', label: 'updated', value: observed?.updated },
    { key: 'md5Hash', label: 'md5', value: observed?.md5Hash },
    { key: 'cacheControl', label: 'cache control', value: observed?.cacheControl },
    { key: 'contentDisposition', label: 'disposition', value: observed?.contentDisposition },
    { key: 'contentEncoding', label: 'encoding', value: observed?.contentEncoding },
    { key: 'contentLanguage', label: 'language', value: observed?.contentLanguage },
    { key: 'generation', label: 'generation', value: observed?.generation },
  ];
}

function renderObservedMetadata(
  metadata: FullMetadata,
  observed: ObservedStorageObjectMetadata | undefined,
): ReactNode {
  const rows = buildMetadataRows(metadata, observed);
  const custom = Object.entries(selectCustomMetadata(observed, metadata));
  return (
    <dl data-pyric-object-metadata>
      <div data-storage-meta-group>Metadata</div>
      {rows.map(({ key, label, value }) => {
        if (value === undefined || value.length === 0) return null;
        return (
          <div key={key} data-pyric-metadata-field={key}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        );
      })}
      {custom.length > 0 && <div data-storage-meta-group>Custom metadata</div>}
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

function EmptyObservedBucketCopy({ showSpecificBucket, activeBucket }: { showSpecificBucket: boolean; activeBucket: string }) {
  if (showSpecificBucket) {
    return (
      <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted">
        No Storage reads, listings, or uploads observed on <code>{activeBucket}</code> in this live
        session yet. Select an observed bucket above or trigger a Storage call on this bucket.
      </p>
    );
  }
  return (
    <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted">
      No Storage reads, listings, or uploads observed in this live session yet. Trigger an upload,
      metadata read, or list call in your app or Admin backend to inspect observed object metadata
      here — object bytes are never buffered in host memory or <code>.pyric/</code>.
    </p>
  );
}

function EmptyObservedBucketNotice({ activeBucket, anyOtherBucketObserved }: { activeBucket: string; anyOtherBucketObserved: boolean }) {
  const showSpecificBucket = anyOtherBucketObserved && activeBucket.length > 0;
  return (
    <div data-storage-live-empty="" className="mt-3 rounded-md border border-dashed border-line bg-panel p-8 text-center">
      <span className="rounded-full border border-line px-3 py-1 text-xs uppercase tracking-wide text-muted">
        Observed this session · Empty
      </span>
      <EmptyObservedBucketCopy showSpecificBucket={showSpecificBucket} activeBucket={activeBucket} />
    </div>
  );
}

function ObservedPreviewActions({
  bucket,
  fullPath,
  downloadUrl,
}: {
  bucket: string;
  fullPath: string;
  downloadUrl: string | undefined;
}) {
  const [copiedTarget, setCopiedTarget] = useState<'gs' | 'path' | null>(null);
  const gsUri = `gs://${bucket}/${fullPath}`;

  const copyValue = (kind: 'gs' | 'path', text: string) => {
    setCopiedTarget(kind);
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).catch(() => {});
    }
  };

  let gsCopyLabel = 'Copy gs:// URI';
  if (copiedTarget === 'gs') gsCopyLabel = 'Copied gs:// URI';
  let pathCopyLabel = 'Copy path';
  if (copiedTarget === 'path') pathCopyLabel = 'Copied path';

  return (
    <div className="storage__live-preview" data-live-storage-preview="">
      <p className="storage__live-preview-title" data-live-storage-no-bytes="">
        Object bytes are not buffered in Live mode
      </p>
      <p className="storage__live-preview-note">
        Pyric captures object paths and metadata only and retains zero raw binary payloads in host
        memory or <code>.pyric/</code>.
      </p>
      <div className="storage__live-copy-row">
        <button type="button" className="storage__live-copy-btn" data-live-storage-copy-gs-uri="" onClick={() => copyValue('gs', gsUri)}>
          {gsCopyLabel}
        </button>
        <button type="button" className="storage__live-copy-btn" data-live-storage-copy-path="" onClick={() => copyValue('path', fullPath)}>
          {pathCopyLabel}
        </button>
      </div>
      {downloadUrl !== undefined && downloadUrl.length > 0 && (
        <>
          <a href={downloadUrl} target="_blank" rel="noopener noreferrer" className="storage__live-download-link" data-live-storage-download-url="">
            Open Storage download URL ↗
          </a>
          <p className="storage__live-download-warning" data-live-storage-external-notice="">
            Opens the observed Cloud Storage download URL directly.
          </p>
        </>
      )}
    </div>
  );
}

function DeletedTombstonesList({ deletedPaths }: { deletedPaths: readonly string[] }) {
  if (deletedPaths.length === 0) return null;
  return (
    <div className="storage__deleted-tombstones" data-live-storage-deleted-tombstones="">
      <div className="storage__deleted-heading">Deleted in this session</div>
      <ul className="storage__deleted-list">
        {deletedPaths.map((deletedPath) => (
          <li key={deletedPath} data-live-storage-deleted-path={deletedPath}>
            <code>{deletedPath}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ObservedBucketBar({
  bucketSummaries,
  activeBucket,
  onSelectBucket,
}: {
  bucketSummaries: readonly ObservedStorageBucketSummary[];
  activeBucket: string;
  onSelectBucket: (bucket: string) => void;
}) {
  if (bucketSummaries.length === 0) return null;
  return (
    <div
      className="storage__buckets"
      data-storage-bucket-bar=""
      role="tablist"
      aria-label="Observed Storage buckets"
    >
      {bucketSummaries.map((item) => {
        const active = item.bucket === activeBucket;
        return (
          <button
            key={item.bucket}
            type="button"
            role="tab"
            aria-selected={active}
            data-storage-bucket={item.bucket}
            data-storage-bucket-observed={String(item.observed)}
            className={bucketPillClassName(item, active)}
            onClick={() => onSelectBucket(item.bucket)}
          >
            <span className="storage__bucket-name">{item.bucket}</span>
            {item.isDefault && <span className="storage__bucket-badge">default</span>}
            <span className="storage__bucket-meta">{bucketPillMeta(item)}</span>
          </button>
        );
      })}
    </div>
  );
}

function ObservedInspectorSlot({
  storage,
  selectedPath,
  previews,
  bucketCatalog,
  onBack,
}: {
  storage: FirebaseStorage;
  selectedPath: string | null;
  previews: StoragePreview[];
  bucketCatalog: ObservedStorageBucketSnapshot | undefined;
  onBack: () => void;
}) {
  if (selectedPath === null) {
    return (
      <p className="storage__inspector-hint">
        Select an observed object to inspect its metadata.
      </p>
    );
  }
  return (
    <>
      <button
        type="button"
        className="storage__back"
        onClick={onBack}
        aria-label="Back to files"
      >
        ‹ Files
      </button>
      <ObjectInspector
        storage={storage}
        path={selectedPath}
        previews={previews}
        renderMetadata={(metadata) =>
          renderObservedMetadata(
            metadata,
            lookupObservedObject(bucketCatalog, metadata.fullPath),
          )
        }
      />
    </>
  );
}

function resolveSelectedObjectPath(
  focusTarget: LiveObservedStoragePaneProps['focusTarget'],
): string | null {
  if (focusTarget.kind !== 'object') return null;
  return normalizeStoragePath(focusTarget.path);
}

function resolveBrowsedPrefix(
  focusTarget: LiveObservedStoragePaneProps['focusTarget'],
  selectedPath: string | null,
): string {
  if (focusTarget.kind === 'prefix') return normalizeStoragePath(focusTarget.path);
  if (selectedPath !== null) return parentFolder(selectedPath);
  return '';
}

function breadcrumbRootLabel(activeBucket: string): string {
  if (activeBucket.length > 0) return activeBucket;
  return 'storage';
}

export function LiveObservedStoragePane({
  storage,
  activeBucket,
  bucketSummaries,
  onSelectBucket,
  bucketCatalog,
  hasObservedStorage,
  focusTarget,
}: LiveObservedStoragePaneProps) {
  const nav = useDataNav();
  const selectedPath = resolveSelectedObjectPath(focusTarget);
  const browsedPath = resolveBrowsedPrefix(focusTarget, selectedPath);

  const browsePrefix = useCallback(
    (path: string) => {
      const norm = normalizeStoragePath(path);
      if (norm.length > 0) {
        nav.navigate({ view: 'storage', kind: 'prefix', path: norm });
      } else {
        nav.navigate({ view: 'storage', kind: 'root' });
      }
    },
    [nav.navigate],
  );

  const pathState = usePathState({ path: browsedPath, onPathChange: browsePrefix });
  const list = useStorageList(storage, pathState.path);

  const selectObject = useCallback(
    (objectPath: string) => {
      nav.navigate({
        view: 'storage',
        kind: 'object',
        path: normalizeStoragePath(objectPath),
      });
    },
    [nav.navigate],
  );

  const handleSelectBucket = useCallback(
    (bucket: string) => {
      if (bucket === activeBucket) return;
      onSelectBucket(bucket);
      nav.navigate({ view: 'storage', kind: 'root' });
    },
    [activeBucket, onSelectBucket, nav.navigate],
  );

  const previews = useMemo<StoragePreview[]>(
    () => [
      {
        id: 'live-observed',
        match: () => true,
        needsBlob: false,
        render: ({ metadata }) => {
          const observed = lookupObservedObject(bucketCatalog, metadata.fullPath);
          return (
            <ObservedPreviewActions
              bucket={metadata.bucket}
              fullPath={metadata.fullPath}
              downloadUrl={observed?.downloadUrl}
            />
          );
        },
      },
    ],
    [bucketCatalog],
  );

  const anyOtherBucketObserved = bucketSummaries.some(
    (item) => item.observed && item.bucket !== activeBucket,
  );
  const deletedInScope = deletedPathsAtPrefix(bucketCatalog, pathState.path);
  let storageLevel: 'browser' | 'inspector' = 'browser';
  if (selectedPath !== null) storageLevel = 'inspector';

  let content: ReactNode;
  if (!hasObservedStorage) {
    content = (
      <EmptyObservedBucketNotice
        activeBucket={activeBucket}
        anyOtherBucketObserved={anyOtherBucketObserved}
      />
    );
  } else {
    content = (
      <div className="storage__body" data-storage-level={storageLevel}>
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
            selectedPath={selectedPath ?? undefined}
            renderEntry={(entry) => renderObservedEntry(entry, bucketCatalog)}
            onNavigate={pathState.enter}
            onSelect={(ref) => selectObject(ref.fullPath)}
            emptyState={
              <p className="storage__empty" data-storage-prefix-empty="">
                No observed objects or child folders under this prefix in this live session.
              </p>
            }
          />
          <DeletedTombstonesList deletedPaths={deletedInScope} />
        </div>

        <div className="storage__inspector">
          <ObservedInspectorSlot
            storage={storage}
            selectedPath={selectedPath}
            previews={previews}
            bucketCatalog={bucketCatalog}
            onBack={() => pathState.setPath(pathState.path)}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className="storage storage--readonly"
      data-pyric-ui="storage-live-observed"
      data-storage-readonly=""
    >
      <ObservedBucketBar
        bucketSummaries={bucketSummaries}
        activeBucket={activeBucket}
        onSelectBucket={handleSelectBucket}
      />

      <div className="storage__sub">
        <PathBreadcrumb
          path={pathState.path}
          rootLabel={breadcrumbRootLabel(activeBucket)}
          onNavigate={pathState.setPath}
        />
        <div className="storage__actions">
          <span className="storage__readonly-pill" data-live-storage-readonly-badge="">
            Observed metadata only · Zero bytes retained
          </span>
        </div>
      </div>

      {content}
    </div>
  );
}
