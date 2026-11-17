/**
 * Admin-SDK resource path and collection-group ID validation (`@google-cloud/firestore`
 * `validateResourcePath` / `ResourcePath` parity across local and remote arms).
 */

import { SandboxError } from 'pyric/sandbox';

function validateResourcePathSegments(argName: string, resourcePath: unknown): string[] {
  if (typeof resourcePath !== 'string' || resourcePath.length === 0) {
    throw new SandboxError(
      'invalid-argument',
      `Value for argument "${argName}" is not a valid resource path. Path must be a non-empty string.`,
    );
  }
  if (resourcePath.includes('//')) {
    throw new SandboxError(
      'invalid-argument',
      `Value for argument "${argName}" is not a valid resource path. Paths must not contain //.`,
    );
  }
  return resourcePath.split('/').filter((segment) => segment.length > 0);
}

export function normalizeCollectionPath(collectionPath: unknown): string {
  const segments = validateResourcePathSegments('collectionPath', collectionPath);
  if (segments.length % 2 !== 1) {
    throw new SandboxError(
      'invalid-argument',
      `Value for argument "collectionPath" must point to a collection, but was "${String(collectionPath)}". Your path does not contain an odd number of segments.`,
    );
  }
  return segments.join('/');
}

export function normalizeRootDocumentPath(documentPath: unknown): string {
  const segments = validateResourcePathSegments('documentPath', documentPath);
  if (segments.length === 0 || segments.length % 2 !== 0) {
    throw new SandboxError(
      'invalid-argument',
      `Value for argument "documentPath" must point to a document, but was "${String(documentPath)}". Your path does not contain an even number of segments.`,
    );
  }
  return segments.join('/');
}

export function normalizeChildDocumentPath(documentPath: unknown): string {
  const segments = validateResourcePathSegments('documentPath', documentPath);
  if (segments.length % 2 !== 1) {
    throw new SandboxError(
      'invalid-argument',
      `Value for argument "documentPath" must point to a document, but was "${String(documentPath)}". Your path does not contain an even number of segments.`,
    );
  }
  return segments.join('/');
}

export function validateCollectionGroupId(collectionId: unknown): string {
  if (typeof collectionId !== 'string') {
    throw new TypeError('Value for argument "collectionId" is not a valid string.');
  }
  if (collectionId.includes('/')) {
    throw new SandboxError(
      'invalid-argument',
      `Invalid collectionId '${collectionId}'. Collection IDs must not contain '/'.`,
    );
  }
  if (collectionId.length === 0) {
    throw new SandboxError(
      'invalid-argument',
      'Invalid collectionId. Collection IDs must be non-empty strings.',
    );
  }
  return collectionId;
}
