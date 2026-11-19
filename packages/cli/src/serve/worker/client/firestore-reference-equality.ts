import type { CollRefHandle, DocRefHandle } from './handles.js';

type Reference = DocRefHandle | CollRefHandle;

function converterOf(reference: Reference): unknown {
  return reference.converter ?? null;
}

function isServedReference(candidate: unknown): candidate is Reference {
  if (candidate === null || typeof candidate !== 'object') {
    return false;
  }
  const record = candidate as { __kind?: unknown; path?: unknown; port?: unknown };
  const validKind = record.__kind === 'doc-ref' || record.__kind === 'coll-ref';
  if (!validKind) {
    return false;
  }
  if (typeof record.path !== 'string') {
    return false;
  }
  return record.port !== null && typeof record.port === 'object';
}

/** Served reference identity belongs to one app's port, path, and converter. */
export function refEqual(left: Reference, right: Reference): boolean {
  if (!isServedReference(left) || !isServedReference(right)) {
    return false;
  }
  const sameKind = left.__kind === right.__kind;
  const sameInstance = left.port === right.port;
  const samePath = left.path === right.path;
  const sameConverter = converterOf(left) === converterOf(right);
  return sameKind && sameInstance && samePath && sameConverter;
}
