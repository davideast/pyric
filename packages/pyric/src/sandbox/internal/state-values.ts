import { assertEncodedDocValueDepth, encodeDocValue, rehydrateEncodedDocValue, requireDocumentData,
  type DocValueEncoding } from '../../firestore/internal/value-codec.js';
import { Reference as RulesReference } from '../../rules/internal/index.js';

const DEFAULT_DB_ID = '(default)';

function isPlainStateRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function qualifyEncodedNamedDbReferences(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(qualifyEncodedNamedDbReferences);
  if (!isPlainStateRecord(value)) return value;
  if (Object.hasOwn(value, '__type') && value.__type === 'reference' && typeof value.path === 'string') {
    const dbId = typeof value.databaseId === 'string' && value.databaseId.length > 0
      ? value.databaseId
      : new RulesReference(value.path).databaseId;
    const relPath = new RulesReference(value.path).path;
    if (dbId !== DEFAULT_DB_ID) {
      return {
        __type: 'reference',
        path: relPath.length > 0
          ? `projects/_/databases/${dbId}/documents/${relPath}`
          : `projects/_/databases/${dbId}/documents`,
      };
    }
    return value;
  }
  if (
    Object.keys(value).length === 2 &&
    Object.hasOwn(value, 'type') &&
    value.type === 'pyric/map/1.0' &&
    isPlainStateRecord(value.fields)
  ) {
    const fields: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value.fields)) {
      Object.defineProperty(fields, key, {
        value: qualifyEncodedNamedDbReferences(item),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return { type: 'pyric/map/1.0', fields };
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(out, key, {
      value: qualifyEncodedNamedDbReferences(item),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

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
  const qualified = qualifyEncodedNamedDbReferences(document) as Record<string, unknown>;
  return requireDocumentData(rehydrateEncodedDocValue(qualified, encoding));
}
