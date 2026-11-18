/**
 * `Bucket.getFiles`'s result, as `@google-cloud/storage` resolves it:
 * `[files, nextQuery, apiResponse]`.
 *
 * A single page (`autoPaginate: false`, or `maxResults` set) gives the query
 * for the next page, with its `pageToken`, or `null` on the last page. Reading
 * every page gives a copy of the query the call was made with in that
 * position, as `@google-cloud/paginator` resolves it, and the last page's
 * response (including `items` when that page listed at least one object).
 */
import {
  apiResponseOf,
  entryOf,
  listingPage,
  pageSizeOf,
  readsEveryPage,
  resumesAfter,
  type GetFilesApiResponse,
  type GetFilesOptions,
} from './file-query.js';
import type { FileMetadata } from './metadata-codec.js';
import { WALK_CONCURRENCY } from './remote-names.js';

export type GetFilesResponse<F> = [F[], GetFilesOptions | null, GetFilesApiResponse];

/** The `getFiles` result for `query` over a bucket's object `names`. */
export function getFilesResponse<F>(names: readonly string[], query: GetFilesOptions, fileOf: (name: string) => F): GetFilesResponse<F> {
  if (!readsEveryPage(query)) return onePage(names, query, fileOf);
  const files: F[] = [];
  let pageQuery: GetFilesOptions = { ...query };
  for (;;) {
    const page = listingPage(names, pageQuery);
    files.push(...page.names.map(fileOf));
    const token = page.nextPageToken;
    if (token === undefined) return [files, { ...query }, apiResponseOf(page)];
    pageQuery = { ...pageQuery, pageToken: token };
  }
}

/**
 * Resolve `getFiles` with `file.metadata` populated on every listed `File` and
 * `apiResponse.items` populated with the final page's `FileMetadata` entries
 * (omitted when that page listed zero objects, matching GCS `objects.list`).
 */
export async function getFilesWithMetadata<F extends { metadata: Partial<FileMetadata> }>(
  names: readonly string[],
  query: GetFilesOptions,
  fileOf: (name: string) => F,
  readMetadata: (file: F) => Promise<FileMetadata | undefined>,
  concurrency = WALK_CONCURRENCY,
): Promise<GetFilesResponse<F>> {
  let files: F[];
  let nextQuery: GetFilesOptions | null;
  let apiResponse: GetFilesApiResponse;
  let lastPageFiles: F[];

  if (!readsEveryPage(query)) {
    const single = onePage(names, query, fileOf);
    files = single[0];
    nextQuery = single[1];
    apiResponse = single[2];
    lastPageFiles = files;
  } else {
    files = [];
    lastPageFiles = [];
    let pageQuery: GetFilesOptions = { ...query };
    for (;;) {
      const page = listingPage(names, pageQuery);
      const created = page.names.map(fileOf);
      files.push(...created);
      const token = page.nextPageToken;
      if (token === undefined) {
        lastPageFiles = created;
        nextQuery = { ...query };
        apiResponse = apiResponseOf(page);
        break;
      }
      pageQuery = { ...pageQuery, pageToken: token };
    }
  }

  const byFile = await loadAllMetadata(files, readMetadata, concurrency);
  const lastItems: FileMetadata[] = [];
  for (const file of lastPageFiles) {
    const meta = byFile.get(file);
    if (meta !== undefined) {
      lastItems.push(meta);
    }
  }
  if (lastItems.length > 0) {
    apiResponse.items = lastItems;
  }
  return [files, nextQuery, apiResponse];
}

async function loadAllMetadata<F extends { metadata: Partial<FileMetadata> }>(
  files: readonly F[],
  readMetadata: (file: F) => Promise<FileMetadata | undefined>,
  concurrency: number,
): Promise<Map<F, FileMetadata>> {
  const byFile = new Map<F, FileMetadata>();
  if (files.length === 0) return byFile;
  const workerCount = Math.max(1, Math.min(concurrency, files.length));
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      if (index >= files.length) return;
      nextIndex += 1;
      const file = files[index];
      if (file === undefined) continue;
      const meta = await readMetadata(file);
      if (meta !== undefined) {
        file.metadata = meta;
        byFile.set(file, meta);
      }
    }
  };
  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return byFile;
}

function onePage<F>(names: readonly string[], query: GetFilesOptions, fileOf: (name: string) => F): GetFilesResponse<F> {
  const page = listingPage(names, query);
  let nextQuery: GetFilesOptions | null = null;
  if (page.nextPageToken !== undefined) {
    nextQuery = { ...query, pageToken: page.nextPageToken };
  }
  return [page.names.map(fileOf), nextQuery, apiResponseOf(page)];
}

/**
 * A stop rule for names arriving in name order: true once they hold every
 * entry the result for `query` needs. A single page needs one entry past its
 * size, to know there is a next page; reading every page needs every name.
 */
export function pageNamesFound(query: GetFilesOptions): (name: string) => boolean {
  if (readsEveryPage(query)) return () => false;
  const after = resumesAfter(query);
  const wanted = pageSizeOf(query) + 1;
  let found = 0;
  let lastKey: string | undefined;
  return (name) => {
    const key = entryOf(name, query)?.key;
    const listed = key !== undefined && (after === undefined || key > after);
    const isNewEntry = listed && key !== lastKey;
    if (!isNewEntry) return false;
    lastKey = key;
    found += 1;
    return found >= wanted;
  };
}
