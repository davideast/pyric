import {
  STORAGE_IMMUTABLE_STRING_FIELDS,
  STORAGE_NULLABLE_STRING_FIELDS,
  copyStorageCustomMetadataRecord,
  type ObservedStorageObjectInput,
  type ObservedStorageObjectMetadata,
} from './storage-policy.js';

type MutableStorageObjectMetadata = {
  -readonly [K in keyof ObservedStorageObjectMetadata]: ObservedStorageObjectMetadata[K];
};

export function objectKey(bucket: string, fullPath: string): string {
  return `${bucket}\u0000${fullPath}`;
}

export function normalizeStoragePrefix(rawPath: string): string {
  return rawPath.replace(/^\/+|\/+$/g, '');
}

export function lastPathSegment(fullPath: string): string {
  const slash = fullPath.lastIndexOf('/');
  if (slash === -1) return fullPath;
  return fullPath.slice(slash + 1);
}

export function parentPrefixOf(path: string): string {
  const slash = path.lastIndexOf('/');
  if (slash === -1) return '';
  return path.slice(0, slash);
}

export function ancestorPrefixesOf(path: string, includeSelf: boolean): string[] {
  const segments = path.split('/').filter((seg) => seg.length > 0);
  let limit = Math.max(0, segments.length - 1);
  if (includeSelf) limit = segments.length;
  const out: string[] = [];
  for (let idx = 1; idx <= limit; idx++) {
    out.push(segments.slice(0, idx).join('/'));
  }
  return out;
}

export function matchesPrefixScope(candidate: string, prefix: string): boolean {
  if (prefix.length === 0) return true;
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

export function isStrictlyInsidePrefix(candidate: string, prefix: string): boolean {
  if (prefix.length === 0) return candidate.length > 0;
  return candidate.startsWith(`${prefix}/`);
}

export function childSegmentUnderPrefix(fullPath: string, prefix: string): string {
  let relative = fullPath;
  if (prefix.length > 0) relative = fullPath.slice(prefix.length + 1);
  const immediateChild = relative.split('/')[0] ?? '';
  if (prefix.length === 0) return immediateChild;
  return `${prefix}/${immediateChild}`;
}

export function mergeObjectMetadata(
  bucket: string,
  fullPath: string,
  existing: ObservedStorageObjectMetadata | undefined,
  input: ObservedStorageObjectInput,
  replaceMetadata: boolean,
): ObservedStorageObjectMetadata {
  const next: MutableStorageObjectMetadata = {
    bucket,
    fullPath,
    name: lastPathSegment(fullPath),
  };

  if (!replaceMetadata && existing !== undefined) {
    if (existing.size !== undefined) next.size = existing.size;
    for (const field of STORAGE_NULLABLE_STRING_FIELDS) {
      if (existing[field] !== undefined) next[field] = existing[field];
    }
    for (const field of STORAGE_IMMUTABLE_STRING_FIELDS) {
      if (existing[field] !== undefined) next[field] = existing[field];
    }
    if (existing.customMetadata !== undefined) {
      next.customMetadata = { ...existing.customMetadata };
    }
  }
  if (existing?.downloadUrl !== undefined) {
    next.downloadUrl = existing.downloadUrl;
  }
  if (input.size !== undefined) {
    next.size = input.size;
  }
  for (const field of STORAGE_NULLABLE_STRING_FIELDS) {
    const val = input[field];
    if (val === null) {
      delete next[field];
    } else if (typeof val === 'string') {
      next[field] = val;
    }
  }
  for (const field of STORAGE_IMMUTABLE_STRING_FIELDS) {
    const val = input[field];
    if (typeof val === 'string') next[field] = val;
  }
  if (input.customMetadata === null) {
    delete next.customMetadata;
  } else if (input.customMetadata !== undefined) {
    const copied = copyStorageCustomMetadataRecord(input.customMetadata);
    if (Object.keys(copied).length > 0) {
      next.customMetadata = copied;
    } else {
      delete next.customMetadata;
    }
  }
  return next;
}
