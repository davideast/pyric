import { useEffect, type ReactNode } from 'react';
import type { FirebaseStorage, FullMetadata } from 'pyric/storage';
import { useContainerSize } from '../../primitives/hooks/useContainerSize.js';
import { useStorageObject } from '../hooks/useStorageObject.js';
import { selectStoragePreview, type StoragePreview } from '../previews.js';

export interface ObjectInspectorProps {
  /** The package's single Storage handle prop (sandbox or prod). */
  storage: FirebaseStorage | null | undefined;
  /** Object path to inspect. `null` renders the idle shell — keep
   *  the inspector mounted and swap paths as the user selects rows. */
  path: string | null;
  /** Consumer previews, tried BEFORE the built-ins (first match
   *  wins) — the extension channel of the preview registry. */
  previews?: StoragePreview[];
  /** Metadata-section slot. Default renders the standard field list.
   *  The header, preview, and state wiring stay with the component. */
  renderMetadata?: (metadata: FullMetadata) => ReactNode;
  /** Extra content below the preview (metadata editor, delete
   *  button, …). */
  children?: ReactNode;
  className?: string;
}

const METADATA_FIELDS: ReadonlyArray<{
  key: string;
  label: string;
  value: (md: FullMetadata) => string | undefined;
}> = [
  { key: 'fullPath', label: 'Path', value: (md) => md.fullPath },
  { key: 'size', label: 'Size', value: (md) => `${md.size}` },
  { key: 'contentType', label: 'Content type', value: (md) => md.contentType },
  { key: 'cacheControl', label: 'Cache control', value: (md) => md.cacheControl },
  { key: 'timeCreated', label: 'Created', value: (md) => md.timeCreated },
  { key: 'updated', label: 'Updated', value: (md) => md.updated },
];

function DefaultMetadata({ metadata }: { metadata: FullMetadata }) {
  return (
    <dl data-pyric-object-metadata>
      {METADATA_FIELDS.map(({ key, label, value }) => {
        const v = value(metadata);
        if (v === undefined) return null;
        return (
          <div key={key} data-pyric-metadata-field={key}>
            <dt>{label}</dt>
            <dd>{v}</dd>
          </div>
        );
      })}
      {Object.entries(metadata.customMetadata ?? {}).map(([k, v]) => (
        <div key={`custom:${k}`} data-pyric-metadata-field="customMetadata" data-pyric-metadata-key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Headless inspector for one storage object: metadata + a
 * content-type-driven preview. Previews come from the registry
 * (`image/*` and `text/* + application/json` built in; extend via
 * `previews`). Blob bytes load lazily and ONLY when the matched
 * preview asks (`needsBlob`) and the object is within the preview's
 * `maxBytes` cap; the blob URL is revoked on unmount/path change
 * (see `useStorageObject`).
 *
 * Ships no visual styling. Consumers style via:
 * - `[data-pyric-ui="object-inspector"]` — root (stamps `data-size`)
 * - `…[data-pyric-idle]` / `[data-pyric-loading]` / `[data-pyric-error]`
 * - `[data-pyric-object-name]` / `[data-pyric-object-metadata]`
 * - `[data-pyric-metadata-field="<field>"]` — each metadata row
 * - `[data-pyric-object-preview]` — the preview container, stamping
 *   `data-pyric-preview="<id>"` for the matched registry entry
 * - `…[data-pyric-preview-loading]` — blob in flight
 * - `…[data-pyric-preview-error]` — blob load failed
 * - `…[data-pyric-preview-too-large]` — over the preview's cap
 * - `…[data-pyric-preview-none]` — no registry match (metadata-only)
 */
export function ObjectInspector({
  storage,
  path,
  previews,
  renderMetadata,
  children,
  className,
}: ObjectInspectorProps) {
  const { ref: rootRef, size } = useContainerSize<HTMLDivElement>();
  const object = useStorageObject(storage, path);
  const { metadata, blobStatus, loadBlob } = object;

  const preview = metadata ? selectStoragePreview(metadata, previews) : undefined;
  const tooLarge =
    preview?.maxBytes !== undefined &&
    metadata !== undefined &&
    metadata.size > preview.maxBytes;
  const wantsBlob = preview?.needsBlob === true && !tooLarge;

  // Auto-load the bytes when (and only when) the matched preview
  // needs them. `blobStatus` resets to 'idle' on path change, which
  // re-arms this effect for the next object.
  useEffect(() => {
    if (wantsBlob && blobStatus === 'idle') loadBlob();
  }, [wantsBlob, blobStatus, loadBlob]);

  if (object.status === 'idle') {
    return (
      <div className={className} data-pyric-ui="object-inspector" data-pyric-idle="" />
    );
  }
  if (object.status === 'loading') {
    return (
      <div className={className} data-pyric-ui="object-inspector" data-pyric-loading="" />
    );
  }
  if (object.status === 'error' || metadata === undefined) {
    return (
      <div
        className={className}
        data-pyric-ui="object-inspector"
        data-pyric-error=""
        role="alert"
      >
        {object.error?.message}
      </div>
    );
  }

  let previewContent: ReactNode;
  let previewState: Record<string, ''> = {};
  if (preview === undefined) {
    previewState = { 'data-pyric-preview-none': '' };
  } else if (tooLarge) {
    previewState = { 'data-pyric-preview-too-large': '' };
  } else if (wantsBlob && blobStatus === 'loading') {
    previewState = { 'data-pyric-preview-loading': '' };
  } else if (wantsBlob && blobStatus === 'error') {
    previewState = { 'data-pyric-preview-error': '' };
    previewContent = object.blobError?.message;
  } else if (!wantsBlob || blobStatus === 'success') {
    previewContent = preview.render({
      metadata,
      blob: object.blob,
      blobUrl: object.blobUrl,
    });
  }

  return (
    <div
      ref={rootRef}
      className={className}
      data-pyric-ui="object-inspector"
      data-size={size}
    >
      <div data-pyric-object-name>{metadata.name}</div>
      {renderMetadata ? renderMetadata(metadata) : <DefaultMetadata metadata={metadata} />}
      <div
        data-pyric-object-preview
        data-pyric-preview={preview?.id}
        {...previewState}
      >
        {previewContent}
      </div>
      {children}
    </div>
  );
}
