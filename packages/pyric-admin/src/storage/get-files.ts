/**
 * `Bucket.getFiles`'s result, as `@google-cloud/storage` resolves it:
 * `[files, nextQuery, apiResponse]`.
 *
 * A single page (`autoPaginate: false`, or `maxResults` set) gives the query
 * for the next page, with its `pageToken`, or `null` on the last page. Reading
 * every page gives a copy of the query the call was made with in that
 * position, as `@google-cloud/paginator` resolves it, and the last page's
 * response.
 */
import {
  apiResponseOf,
  listingPage,
  readsEveryPage,
  type GetFilesApiResponse,
  type GetFilesOptions,
} from './file-query.js';

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

function onePage<F>(names: readonly string[], query: GetFilesOptions, fileOf: (name: string) => F): GetFilesResponse<F> {
  const page = listingPage(names, query);
  const token = page.nextPageToken;
  const nextQuery = token === undefined ? null : { ...query, pageToken: token };
  return [page.names.map(fileOf), nextQuery, apiResponseOf(page)];
}
