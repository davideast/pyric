/**
 * List operations — `listAll` only. The `ListResult` shape keeps
 * `nextPageToken` optional so consumer
 * code that handles pagination doesn't have to special-case the
 * sandbox.
 *
 * Algorithm:
 *   1. Compute `scanPrefix`. Empty fullPath → `''` (entire bucket).
 *      Non-empty fullPath → `fullPath + '/'` so descendants match
 *      but the ref itself doesn't.
 *   2. `listByPrefix(scanPrefix)` returns every metadata record
 *      under the prefix, sorted by IDB key order (i.e. by path).
 *   3. For each record, compute the path RELATIVE to scanPrefix.
 *      A relative path with no `'/'` is a direct child file — push
 *      it to `items`. A relative path with `'/'` denotes a
 *      sub-folder; the first segment becomes a synthetic prefix
 *      reference (deduped — many files can share one folder).
 *   4. Sort prefixes by path for deterministic output. Items are
 *      already sorted by virtue of the IDB scan.
 *
 * Survey alignment (Section 6): the JS SDK's `prefixes` carries
 * folder-like references for ANY path with descendants; we match
 * that semantic exactly.
 */
import {
  isAdminLiteralSchemePath,
  referenceAtPath,
  type StorageReference,
} from './reference.js';
import { operationStorageOf } from './sandbox/cross-bucket-target.js';
import { getStorageService, storageAuth, storageOperationProvenance, targetOf } from './service.js';
import { enforceRules } from './enforce.js';

/**
 * Mirrors `firebase/storage`'s `ListResult`. `nextPageToken` is
 * `undefined` for `listAll`; query `pyric can-i-use storage/list` for the
 * current availability of the separate paginated operation.
 */
export interface ListResult {
  items: StorageReference[];
  prefixes: StorageReference[];
  nextPageToken?: string;
}

/**
 * Enumerate every immediate child item + sub-prefix under `refIn`.
 * Works on the root reference too — pass `ref(storage)` to scan the
 * whole bucket.
 */
export async function listAll(refIn: StorageReference): Promise<ListResult> {
  const storage = operationStorageOf(refIn);
  const target = targetOf(storage);
  const operationProvenance = storageOperationProvenance(target);
  const service = await getStorageService(storage);
  // ST-B2: enforce rules on the listed prefix. Firebase Storage's
  // `read` permission governs both download AND list, so a `listAll`
  // requires `read` on the scanned ref's path. Prefixes have no
  // backing object, so `resource` is null (a list of an unauthorized
  // tree throws `storage/unauthorized`, same as a denied read). When
  // no rules are configured, enforcement fails closed.
  enforceRules(service, {
    request: {
      auth: storageAuth(target),
      method: 'list',
      path: refIn.fullPath,
    },
    resource: null,
  }, target, operationProvenance);
  const scanPrefix = refIn.fullPath === '' ? '' : `${refIn.fullPath}/`;
  const records = await service.backend.listByPrefix(scanPrefix);

  const items: StorageReference[] = [];
  const seenPrefixes = new Set<string>();
  const prefixes: StorageReference[] = [];

  const isAdminPlane = target.admin === true;
  const makeRef = (fullPath: string): StorageReference => {
    return referenceAtPath(refIn, fullPath, isAdminPlane);
  };

  for (const md of records) {
    if (!md.fullPath.startsWith(scanPrefix)) continue; // defensive
    const relative = md.fullPath.slice(scanPrefix.length);
    if (relative === '') {
      if (isAdminPlane && refIn.fullPath !== '' && isAdminLiteralSchemePath(md.fullPath)) {
        items.push(makeRef(md.fullPath));
      }
      continue;
    }

    const slashIdx = relative.indexOf('/');
    if (slashIdx === -1) {
      // Direct child file.
      items.push(makeRef(md.fullPath));
    } else {
      const folderName = relative.slice(0, slashIdx);
      const folderPath = `${scanPrefix}${folderName}`;
      if (!seenPrefixes.has(folderPath)) {
        seenPrefixes.add(folderPath);
        prefixes.push(makeRef(folderPath));
      }
    }
  }

  // GCS orders delimiter-rolled-up prefixes with their trailing '/' before the
  // client SDK strips that slash (so 'foo-bar/' sorts before 'foo/').
  prefixes.sort((a, b) => {
    const aSlash = `${a.fullPath}/`;
    const bSlash = `${b.fullPath}/`;
    if (aSlash < bSlash) return -1;
    if (aSlash > bSlash) return 1;
    return 0;
  });

  return { items, prefixes };
}
