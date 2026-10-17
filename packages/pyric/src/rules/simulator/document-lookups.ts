import type { SimulationContext, SimResource } from './evaluation-context.js';
import { EvalError } from './eval-error.js';
import { reviveFirestoreNumbers } from './firestore-values.js';
import { Path } from './wrappers/path.js';

/**
 * Check if a path or segment list points to a document (non-empty, even segment count).
 */
export function isDocumentPath(segmentsOrPath: string | readonly string[]): boolean {
  const segments = typeof segmentsOrPath === 'string'
    ? segmentsOrPath.split('/').filter(Boolean)
    : segmentsOrPath;
  if (segments.length === 0 || segments.length % 2 !== 0) return false;
  return !segments.some((seg) => /^\{.*\}$/.test(seg));
}

export function normalizeDocumentPath(rawPath: string): string {
  let cleaned = rawPath.replace(/\$\(database\)/g, '(default)');
  const dbPrefix = '/databases/(default)/documents/';
  if (cleaned.startsWith(dbPrefix)) {
    cleaned = cleaned.slice(dbPrefix.length);
  } else if (cleaned.startsWith('/databases/(default)/documents')) {
    cleaned = cleaned.slice('/databases/(default)/documents'.length);
  }
  if (cleaned.startsWith('/')) {
    cleaned = cleaned.slice(1);
  }

  const rawSegments = cleaned.split('/').filter((s) => s.length > 0 && s !== '.');
  const stack: string[] = [];

  for (const seg of rawSegments) {
    if (seg === '..') {
      if (stack.length > 1) {
        stack.pop();
      }
      // When stack.length <= 1, .. is clamped to prevent escaping collection or document root.
    } else {
      stack.push(seg);
    }
  }

  return stack.join('/');
}

/** Build the identity-bearing value returned by a real document lookup. */
export function makeGetResource(relPath: string, data: Record<string, unknown>): SimResource {
  const segments = relPath.split('/').filter(Boolean);
  return {
    data: reviveFirestoreNumbers(data) as Record<string, unknown>,
    id: segments.at(-1) ?? '',
    __name__: new Path(['databases', '(default)', 'documents', ...segments]),
  };
}

export function resolveGet(rawPath: string, context: SimulationContext): SimResource {
  const path = normalizeDocumentPath(rawPath);
  const segments = path.split('/').filter(Boolean);
  if (!isDocumentPath(segments)) {
    throw new EvalError(
      `get() requires a path pointing to a document (even segment count), got '${path}'`,
    );
  }
  let document = context.mockDocuments.get(path);
  if (!document && context.getDoc) {
    const loaded = context.getDoc(path);
    if (loaded) {
      const revived = reviveFirestoreNumbers(loaded) as Record<string, unknown>;
      context.mockDocuments.set(path, revived);
      document = revived;
    }
  }
  if (document) {
    const revivedDoc = reviveFirestoreNumbers(document) as Record<string, unknown>;
    if (context.identitylessFunctionMocks?.has(path)) {
      return { data: revivedDoc };
    }
    return makeGetResource(path, revivedDoc);
  }
  throw new EvalError(`get() of non-existent document '${path}' (guard with exists() first)`);
}

export function resolveExists(rawPath: string, context: SimulationContext): boolean {
  const path = normalizeDocumentPath(rawPath);
  const segments = path.split('/').filter(Boolean);
  if (!isDocumentPath(segments)) {
    throw new EvalError(
      `exists() requires a path pointing to a document (even segment count), got '${path}'`,
    );
  }
  if (context.mockDocuments.has(path)) return true;
  if (context.getDoc) {
    const loaded = context.getDoc(path);
    if (loaded) {
      context.mockDocuments.set(path, reviveFirestoreNumbers(loaded) as Record<string, unknown>);
      return true;
    }
  }
  return false;
}
