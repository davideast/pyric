import type { SimulationContext, SimResource } from './evaluation-context.js';
import { EvalError } from './evaluation-errors.js';
import { Path } from './wrappers/path.js';

export function normalizeDocumentPath(rawPath: string): string {
  return rawPath
    .replace(/\$\(database\)/g, '(default)')
    .replace(/^\/databases\/\(default\)\/documents\//, '');
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
