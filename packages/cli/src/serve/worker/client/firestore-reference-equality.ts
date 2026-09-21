import type { CollRefHandle, DocRefHandle } from './handles.js';

type Reference = DocRefHandle | CollRefHandle;

function converterOf(reference: Reference): unknown {
  return reference.converter;
}

/** Served reference identity belongs to one app's port, path, and converter. */
export function refEqual(left: Reference, right: Reference): boolean {
  const sameKind = left.__kind === right.__kind;
  const sameInstance = left.port === right.port;
  const samePath = left.path === right.path;
  const sameConverter = converterOf(left) === converterOf(right);
  return sameKind && sameInstance && samePath && sameConverter;
}
