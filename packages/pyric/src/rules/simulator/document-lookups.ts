import type { SimulationContext, SimResource } from './evaluation-context.js';
import { EvalError } from './eval-error.js';
import { Path } from './wrappers/path.js';

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
      // When stack.length is 1 (collection root) or 0 (document root), .. is clamped.
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
    data,
    id: segments.at(-1) ?? '',
    __name__: new Path(['databases', '(default)', 'documents', ...segments]),
  };
}

export function resolveGet(rawPath: string, context: SimulationContext): SimResource {
  const path = normalizeDocumentPath(rawPath);
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0 || segments.length % 2 !== 0) {
    throw new EvalError(
      `get() requires a path pointing to a document (even segment count), got '${path}'`,
    );
  }
  let document = context.mockDocuments.get(path);
  if (!document && context.getDoc) {
    const loaded = context.getDoc(path);
    if (loaded) {
      context.mockDocuments.set(path, loaded);
      document = loaded;
    }
  }
  if (document) {
    return context.identitylessFunctionMocks?.has(path)
      ? { data: document }
      : makeGetResource(path, document);
  }
  throw new EvalError(`get() of non-existent document '${path}' (guard with exists() first)`);
}

export function resolveExists(rawPath: string, context: SimulationContext): boolean {
  const path = normalizeDocumentPath(rawPath);
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0 || segments.length % 2 !== 0) {
    return false;
  }
  if (context.mockDocuments.has(path)) return true;
  if (context.getDoc) {
    const loaded = context.getDoc(path);
    if (loaded) {
      context.mockDocuments.set(path, loaded);
      return true;
    }
  }
  return false;
}
