import { useEffect, useState, type ReactNode } from 'react';
import type { FullMetadata } from 'pyric/storage';

/** What a preview's `render` receives. `blob`/`blobUrl` are only
 *  populated for previews that declared `needsBlob`. */
export interface StoragePreviewContext {
  metadata: FullMetadata;
  blob: Blob | undefined;
  blobUrl: string | undefined;
}

/**
 * One entry in the content-type preview registry — the storage
 * counterpart of the Firestore field-editor registry, keyed by a
 * `match` predicate instead of a type name because content types are
 * open-ended. First match wins; consumer previews run BEFORE the
 * built-ins, so overriding `image/*` is just shipping your own
 * matcher.
 */
export interface StoragePreview {
  /** Diagnostic id — also stamped on the preview container as
   *  `data-pyric-preview="<id>"`. */
  id: string;
  match: (metadata: FullMetadata) => boolean;
  /** Ask the inspector to `loadBlob()` before rendering. Default
   *  `false` (metadata-only previews render immediately). */
  needsBlob?: boolean;
  /**
   * Skip the preview (and the blob download) for objects larger than
   * this — the inspector renders its `data-pyric-preview-too-large`
   * fallback instead. `undefined` = no cap.
   */
  maxBytes?: number;
  render: (ctx: StoragePreviewContext) => ReactNode;
}

/** 256KB — the section 3 default cap for the text-family preview. */
export const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;

function contentTypeOf(metadata: FullMetadata): string {
  // `text/plain;charset=utf-8` → `text/plain`.
  return (metadata.contentType ?? '').split(';')[0].trim().toLowerCase();
}

/** `image/*` → blob-URL `<img>`. */
export const imagePreview: StoragePreview = {
  id: 'image',
  match: (md) => contentTypeOf(md).startsWith('image/'),
  needsBlob: true,
  render: ({ metadata, blobUrl }) =>
    blobUrl ? (
      <img data-pyric-preview-image src={blobUrl} alt={metadata.name} />
    ) : null,
};

function TextPreviewBody({ blob, isJson }: { blob: Blob; isJson: boolean }) {
  const [text, setText] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    blob.text().then((raw) => {
      if (cancelled) return;
      if (isJson) {
        try {
          setText(JSON.stringify(JSON.parse(raw), null, 2));
          return;
        } catch {
          // Unparseable JSON falls through to the raw text.
        }
      }
      setText(raw);
    });
    return () => {
      cancelled = true;
    };
  }, [blob, isJson]);
  if (text === undefined) return null;
  return <pre data-pyric-preview-text>{text}</pre>;
}

/** `text/*` + `application/json` → text panel, 256KB cap (bigger
 *  objects fall through to the too-large fallback). JSON is
 *  pretty-printed when parseable. */
export const textPreview: StoragePreview = {
  id: 'text',
  match: (md) => {
    const ct = contentTypeOf(md);
    return ct.startsWith('text/') || ct === 'application/json';
  },
  needsBlob: true,
  maxBytes: TEXT_PREVIEW_MAX_BYTES,
  render: ({ metadata, blob }) =>
    blob ? (
      <TextPreviewBody
        blob={blob}
        isJson={contentTypeOf(metadata) === 'application/json'}
      />
    ) : null,
};

/** The section 3 defaults: image, text/json; everything else is
 *  metadata-only (the inspector's `data-pyric-preview-none` state). */
export const defaultStoragePreviews: ReadonlyArray<StoragePreview> = [
  imagePreview,
  textPreview,
];

/**
 * Pick the preview for `metadata`: consumer previews first (override
 * channel), then the built-ins, first `match` wins. `undefined`
 * means metadata-only.
 */
export function selectStoragePreview(
  metadata: FullMetadata,
  consumerPreviews: ReadonlyArray<StoragePreview> | undefined,
): StoragePreview | undefined {
  for (const preview of [...(consumerPreviews ?? []), ...defaultStoragePreviews]) {
    if (preview.match(metadata)) return preview;
  }
  return undefined;
}
