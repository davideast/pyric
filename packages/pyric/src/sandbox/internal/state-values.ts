import { assertEncodedDocValueDepth, encodeDocValue, rehydrateEncodedDocValue, requireDocumentData,
  type DocValueEncoding } from '../../firestore/internal/value-codec.js';

/** Preserve SDK values and escape ordinary marker-shaped maps before JSON removes their identity. */
export function encodeStateDocument(document: Record<string, unknown>): Record<string, unknown> {
  return requireDocumentData(JSON.parse(JSON.stringify(encodeDocValue(document))));
}

/** Decode declared encodings, preserving literal maps in legacy full states. */
export function decodeStateDocument(
  document: Record<string, unknown>,
  encoding: DocValueEncoding | undefined,
): Record<string, unknown> {
  const isLegacyState = encoding === undefined;
  if (isLegacyState) {
    assertEncodedDocValueDepth(document);
    return structuredClone(document);
  }
  return requireDocumentData(rehydrateEncodedDocValue(document, encoding));
}
