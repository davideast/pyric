/**
 * List operations -- `list` (paginated) and `listAll`.
 *
 * Algorithm:
 *   1. Compute `scanPrefix`. Empty fullPath -> `''` (entire bucket).
 *      Non-empty fullPath -> `fullPath + '/'` so descendants match
 *      but the ref itself does not.
 *   2. `listByPrefix(scanPrefix)` returns every metadata record
 *      under the prefix, sorted by IDB key order (i.e. by path).
 *   3. On the client plane, filter out objects whose paths start with `'/'`
 *      or contain `'//'`, matching Firebase Storage List API filtering
 *      (`storage-public.d.ts:204-206`), and hide `<path>/` placeholders from
 *      `items`. On the admin plane, preserve every literal object name.
 *   4. Order items (`fullPath`) and rolled-up prefixes (`fullPath + '/'`)
 *      together in UTF-8 byte order (matching GCS delimiter listing so
 *      `'foo-bar'` and `'foo-bar/'` sort before `'foo/'`).
 *   5. For `list(ref, options?)`, slice up to `maxResults` entries (`1..1000`,
 *      default `1000`) strictly after the cursor encoded in `pageToken`,
 *      attaching `nextPageToken` only when more entries remain.
 */
import { arrayBufferToBase64, base64ToBytes } from './base64.js';
import { enforceRules } from './enforce.js';
import { StorageError } from './errors.js';
import {
  referenceAtPath,
  type StorageReference,
} from './reference.js';
import { operationStorageOf } from './sandbox/cross-bucket-target.js';
import { getStorageService, storageAuth, storageOperationProvenance, targetOf } from './service.js';
import type { ListOptions } from './types.js';

const MIN_LIST_MAX_RESULTS = 1;
const MAX_LIST_MAX_RESULTS = 1000;
const PAGE_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/** Mirrors `firebase/storage`'s `ListResult`. */
export interface ListResult {
  items: StorageReference[];
  prefixes: StorageReference[];
  nextPageToken?: string;
}

/** Validated `ListOptions` shape before server-side cursor decoding. */
export interface ValidatedListOptionsShape {
  readonly maxResults: number;
  readonly rawPageToken: string | undefined;
}

interface ListedEntry {
  readonly kind: 'item' | 'prefix';
  readonly sortKey: string;
  readonly ref: StorageReference;
}

function isUnsupportedClientListObjectPath(fullPath: string): boolean {
  return fullPath.startsWith('/') || fullPath.includes('//');
}

function compareUtf8(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  const leftBytes = utf8Encoder.encode(left);
  const rightBytes = utf8Encoder.encode(right);
  const limit = Math.min(leftBytes.length, rightBytes.length);
  for (let i = 0; i < limit; i++) {
    const leftByte = leftBytes[i] ?? 0;
    const rightByte = rightBytes[i] ?? 0;
    if (leftByte !== rightByte) {
      return leftByte - rightByte;
    }
  }
  return leftBytes.length - rightBytes.length;
}

function invalidListArgument(message: string): StorageError {
  return new StorageError('invalid-argument', message);
}

/**
 * Validate the client-visible shape of `ListOptions` (`maxResults` integer in
 * `1..1000`, `pageToken` string/null/undefined). Shared with the worker client
 * so `NaN` / `Infinity` cannot collapse to `null` over JSON transport.
 */
export function validateListOptionsShape(options?: ListOptions | null): ValidatedListOptionsShape {
  if (options === undefined || options === null) {
    return { maxResults: MAX_LIST_MAX_RESULTS, rawPageToken: undefined };
  }
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw invalidListArgument("Invalid value for 'options'. Expected an object.");
  }

  let maxResults = MAX_LIST_MAX_RESULTS;
  const rawMax = options.maxResults;
  if (rawMax !== undefined && rawMax !== null) {
    if (typeof rawMax !== 'number' || Number.isNaN(rawMax)) {
      throw invalidListArgument(
        "Invalid value for 'options.maxResults'. Expected an integer between 1 and 1000.",
      );
    }
    if (rawMax < MIN_LIST_MAX_RESULTS) {
      throw invalidListArgument("Invalid value for 'options.maxResults'. Expected 1 or greater.");
    }
    if (rawMax > MAX_LIST_MAX_RESULTS) {
      throw invalidListArgument("Invalid value for 'options.maxResults'. Expected 1000 or less.");
    }
    if (!Number.isInteger(rawMax)) {
      throw invalidListArgument(
        "Invalid value for 'options.maxResults'. Expected an integer between 1 and 1000.",
      );
    }
    maxResults = rawMax;
  }

  let rawPageToken: string | undefined;
  const candidateToken = options.pageToken;
  if (candidateToken !== undefined && candidateToken !== null) {
    if (typeof candidateToken !== 'string') {
      throw invalidListArgument("Invalid value for 'options.pageToken'. Expected a string.");
    }
    if (candidateToken.length > 0) {
      rawPageToken = candidateToken;
    }
  }

  return { maxResults, rawPageToken };
}

function encodePageToken(after: string): string {
  const bytes = utf8Encoder.encode(JSON.stringify({ v: 1, after }));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return arrayBufferToBase64(buffer)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function decodePageToken(raw: string): string {
  if (!PAGE_TOKEN_PATTERN.test(raw)) {
    throw invalidListArgument("Invalid value for 'options.pageToken'.");
  }
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(raw, 'base64url');
  } catch (error) {
    throw invalidListArgument(
      `Invalid value for 'options.pageToken': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let decodedText: string;
  try {
    decodedText = utf8Decoder.decode(bytes);
  } catch (error) {
    throw invalidListArgument(
      `Invalid value for 'options.pageToken': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodedText);
  } catch (error) {
    throw invalidListArgument(
      `Invalid value for 'options.pageToken': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const isObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  if (!isObject) {
    throw invalidListArgument("Invalid value for 'options.pageToken'.");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  const hasExpectedShape =
    keys.length === 2 &&
    record.v === 1 &&
    typeof record.after === 'string' &&
    record.after.length > 0;
  if (!hasExpectedShape) {
    throw invalidListArgument("Invalid value for 'options.pageToken'.");
  }
  return record.after as string;
}

async function collectListedEntries(refIn: StorageReference): Promise<ListedEntry[]> {
  const storage = operationStorageOf(refIn);
  const target = targetOf(storage);
  const operationProvenance = storageOperationProvenance(target);
  const service = await getStorageService(storage);
  // ST-B2: enforce rules on the listed prefix. Firebase Storage's
  // `read` permission governs both download AND list, so listing
  // requires `list`/`read` on the scanned ref's path. Prefixes have no
  // backing object, so `resource` is null. When no rules are configured,
  // enforcement fails closed.
  enforceRules(service, {
    request: {
      auth: storageAuth(target),
      method: 'list',
      path: refIn.fullPath,
    },
    resource: null,
  }, target, operationProvenance);

  let scanPrefix = '';
  if (refIn.fullPath !== '') {
    scanPrefix = `${refIn.fullPath}/`;
  }
  const records = await service.backend.listByPrefix(scanPrefix);

  const entries: ListedEntry[] = [];
  const seenPrefixes = new Set<string>();
  const isAdminPlane = target.admin === true;
  const makeRef = (fullPath: string): StorageReference => {
    return referenceAtPath(refIn, fullPath, isAdminPlane);
  };
  const addItem = (fullPath: string): void => {
    entries.push({ kind: 'item', sortKey: fullPath, ref: makeRef(fullPath) });
  };
  const addPrefix = (folderPath: string): void => {
    if (!seenPrefixes.has(folderPath)) {
      seenPrefixes.add(folderPath);
      entries.push({ kind: 'prefix', sortKey: `${folderPath}/`, ref: makeRef(folderPath) });
    }
  };

  for (const md of records) {
    if (!md.fullPath.startsWith(scanPrefix)) continue;
    if (!isAdminPlane && isUnsupportedClientListObjectPath(md.fullPath)) {
      continue;
    }
    const relative = md.fullPath.slice(scanPrefix.length);
    if (relative === '') {
      if (isAdminPlane && refIn.fullPath !== '') {
        addItem(md.fullPath);
      }
      continue;
    }

    if (isAdminPlane && scanPrefix === '' && md.fullPath.startsWith('/')) {
      const secondSlash = md.fullPath.indexOf('/', 1);
      if (secondSlash === -1) {
        addItem(md.fullPath);
      } else {
        addPrefix(md.fullPath.slice(0, secondSlash));
      }
      continue;
    }

    const slashIdx = relative.indexOf('/');
    if (slashIdx === -1) {
      addItem(md.fullPath);
    } else {
      const folderName = relative.slice(0, slashIdx);
      addPrefix(`${scanPrefix}${folderName}`);
    }
  }

  entries.sort((left, right) => compareUtf8(left.sortKey, right.sortKey));
  return entries;
}

function splitEntries(entries: readonly ListedEntry[]): {
  items: StorageReference[];
  prefixes: StorageReference[];
} {
  const items: StorageReference[] = [];
  const prefixes: StorageReference[] = [];
  for (const entry of entries) {
    if (entry.kind === 'item') {
      items.push(entry.ref);
    } else {
      prefixes.push(entry.ref);
    }
  }
  return { items, prefixes };
}

/**
 * List one page of immediate child items and sub-prefixes under `refIn`.
 * Enforces `method: 'list'` Storage Security Rules before decoding `pageToken`.
 */
export async function list(
  refIn: StorageReference,
  options?: ListOptions,
): Promise<ListResult> {
  const { maxResults, rawPageToken } = validateListOptionsShape(options);
  const allEntries = await collectListedEntries(refIn);
  let remaining = allEntries;
  if (rawPageToken !== undefined) {
    const after = decodePageToken(rawPageToken);
    remaining = allEntries.filter((entry) => compareUtf8(entry.sortKey, after) > 0);
  }
  const page = remaining.slice(0, maxResults);
  const { items, prefixes } = splitEntries(page);
  const result: ListResult = { items, prefixes };
  const hasMore = remaining.length > page.length;
  const lastEntry = page[page.length - 1];
  if (hasMore && lastEntry !== undefined) {
    result.nextPageToken = encodePageToken(lastEntry.sortKey);
  }
  return result;
}

/**
 * Enumerate every immediate child item + sub-prefix under `refIn`.
 * Works on the root reference too -- pass `ref(storage)` to scan the
 * whole bucket.
 */
export async function listAll(refIn: StorageReference): Promise<ListResult> {
  const allEntries = await collectListedEntries(refIn);
  return splitEntries(allEntries);
}
