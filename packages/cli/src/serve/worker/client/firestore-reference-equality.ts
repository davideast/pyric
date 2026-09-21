import type { CollRefHandle, DocRefHandle } from './handles.js';

type Reference = DocRefHandle | CollRefHandle;

function converterOf(reference: Reference): unknown {
  const isDocument = reference.__kind === 'doc-ref';
  if (isDocument) return reference.converter;
  return null;
}

/** Served reference identity belongs to one app's port, path, and converter. */
export function refEqual(left: Reference, right: Reference): boolean {
  const sameKind = left.__kind === right.__kind;
  const sameInstance = left.port === right.port;
  const samePath = left.path === right.path;
  const sameConverter = converterOf(left) === converterOf(right);
  return sameKind && sameInstance && samePath && sameConverter;
}
