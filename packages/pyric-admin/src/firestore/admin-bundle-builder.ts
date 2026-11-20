/**
 * Duck-typed `BundleBuilder` implementation returned by `db.bundle(bundleId?)`
 * in `pyric-admin/firestore`, producing length-prefixed Firestore JSON bundles.
 */
import { Timestamp as CompatTimestamp, type DocumentSnapshot, type QuerySnapshot } from 'pyric/sandbox/admin-compat';
import type { SandboxFirestore } from 'pyric/sandbox/admin-firestore';
import { isAdminGeoPoint } from './admin-geopoint.js';
import { isPlainMap } from './admin-handle-registry.js';
import { markAdminFirestoreStarted } from './admin-settings-lifecycle.js';

export interface AdminBundleBuilder {
  readonly bundleId: string;
  add(documentSnapshot: DocumentSnapshot): AdminBundleBuilder;
  add(queryName: string, querySnapshot: QuerySnapshot): AdminBundleBuilder;
  build(): Buffer;
}

interface BundledDocRecord {
  readonly path: string;
  readonly exists: boolean;
  readonly data: Record<string, unknown> | undefined;
  readonly queries: Set<string>;
}

function encodeRestValue(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return { integerValue: String(value) };
    return { doubleValue: value };
  }
  if (value instanceof CompatTimestamp) return { timestampValue: value.toDate().toISOString() };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (isAdminGeoPoint(value)) {
    return { geoPointValue: { latitude: value.latitude, longitude: value.longitude } };
  }
  if (value instanceof Uint8Array) return { bytesValue: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeRestValue) } };
  if (isPlainMap(value)) {
    const fields: Record<string, Record<string, unknown>> = {};
    for (const [k, v] of Object.entries(value)) fields[k] = encodeRestValue(v);
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

function encodeLengthPrefixedElement(element: Record<string, unknown>): Buffer {
  const jsonBytes = Buffer.from(JSON.stringify(element), 'utf8');
  return Buffer.concat([Buffer.from(String(jsonBytes.byteLength), 'utf8'), jsonBytes]);
}

export function createAdminBundleBuilder(
  rootDb: SandboxFirestore,
  projectId: string,
  bundleId = 'pyric-admin-bundle',
): AdminBundleBuilder {
  markAdminFirestoreStarted(rootDb);
  if (typeof bundleId !== 'string' || bundleId.length === 0) {
    throw new Error('Value for argument "bundleId" must be a non-empty string.');
  }
  const docsByPath = new Map<string, BundledDocRecord>();
  const namedQueries = new Map<string, { collectionId: string; parentPath: string }>();

  function recordDoc(snap: DocumentSnapshot, queryName?: string): void {
    const path = snap.ref.path;
    let existing = docsByPath.get(path);
    if (existing === undefined) {
      existing = {
        path,
        exists: Boolean(snap.exists),
        data: snap.data() as Record<string, unknown> | undefined,
        queries: new Set<string>(),
      };
      docsByPath.set(path, existing);
    }
    if (queryName !== undefined) existing.queries.add(queryName);
  }

  const builder: AdminBundleBuilder = {
    bundleId,
    add(first: DocumentSnapshot | string, second?: QuerySnapshot): AdminBundleBuilder {
      if (typeof first === 'string') {
        if (first.length === 0 || second === undefined || second === null || !Array.isArray(second.docs)) {
          throw new Error('BundleBuilder.add(queryName, querySnapshot) requires a query name and QuerySnapshot.');
        }
        let collectionId = 'items';
        let parentPath = `projects/${projectId}/databases/(default)/documents`;
        const firstDoc = second.docs[0];
        if (firstDoc !== undefined) {
          const segments = firstDoc.ref.path.split('/');
          if (segments.length >= 2) {
            collectionId = segments[segments.length - 2] as string;
            if (segments.length > 2) parentPath = `${parentPath}/${segments.slice(0, -2).join('/')}`;
          }
        }
        namedQueries.set(first, { collectionId, parentPath });
        for (const docSnap of second.docs) recordDoc(docSnap, first);
        return builder;
      }
      recordDoc(first);
      return builder;
    },
    build(): Buffer {
      const nowIso = new Date().toISOString();
      const bodyChunks: Buffer[] = [];
      let existingDocCount = 0;

      for (const [name, qMeta] of namedQueries) {
        bodyChunks.push(
          encodeLengthPrefixedElement({
            namedQuery: {
              name,
              readTime: nowIso,
              bundledQuery: {
                parent: qMeta.parentPath,
                structuredQuery: { from: [{ collectionId: qMeta.collectionId }] },
              },
            },
          }),
        );
      }

      for (const entry of docsByPath.values()) {
        const resourceName = `projects/${projectId}/databases/(default)/documents/${entry.path}`;
        bodyChunks.push(
          encodeLengthPrefixedElement({
            documentMetadata: {
              name: resourceName,
              readTime: nowIso,
              exists: entry.exists,
              queries: [...entry.queries],
            },
          }),
        );
        if (entry.exists && entry.data !== undefined) {
          existingDocCount += 1;
          const fields: Record<string, Record<string, unknown>> = {};
          for (const [k, v] of Object.entries(entry.data)) fields[k] = encodeRestValue(v);
          bodyChunks.push(
            encodeLengthPrefixedElement({
              document: { name: resourceName, fields, createTime: nowIso, updateTime: nowIso },
            }),
          );
        }
      }

      const bodyBuffer = Buffer.concat(bodyChunks);
      const headerBuffer = encodeLengthPrefixedElement({
        metadata: {
          id: bundleId,
          createTime: nowIso,
          version: 1,
          totalDocuments: existingDocCount,
          totalBytes: String(bodyBuffer.byteLength),
        },
      });
      return Buffer.concat([headerBuffer, bodyBuffer]);
    },
  };

  return builder;
}
