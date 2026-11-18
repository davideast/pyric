/**
 * The object listing `@google-cloud/storage`'s `Bucket.getFiles` reads from
 * the JSON API, worked out over a bucket's object names. Both sandbox arms
 * collect the names their own way and page them here, so a query lists the
 * same files on each.
 *
 *   - `prefix` matches the start of a name verbatim; it is not a folder, so
 *     `users/12` matches `users/123/a.png`. An empty prefix lists the bucket.
 *   - `delimiter` rolls each name whose rest after the prefix holds it up to
 *     a prefix ending in the delimiter, reported in `apiResponse.prefixes`.
 *   - A page holds up to `maxResults` entries, files and prefixes together,
 *     in name order (1000 without it), and `pageToken` resumes after the
 *     entry the previous page ended on.
 *   - `autoPaginate` (the default unless `maxResults` is set or it is
 *     `false`) reads every page, as `@google-cloud/paginator` does.
 */

import type { FileMetadata } from './metadata-codec.js';

/** Options for `Bucket.getFiles`. Subset of `@google-cloud/storage`'s `GetFilesOptions`. */
export interface GetFilesOptions {
  prefix?: string;
  delimiter?: string;
  maxResults?: number;
  pageToken?: string;
  autoPaginate?: boolean;
}

/** Options for `Bucket.deleteFiles`. Subset of `@google-cloud/storage`'s `DeleteFilesOptions`. */
export interface DeleteFilesOptions extends GetFilesOptions {
  /** Delete every file it can, then reject with the array of errors, instead of stopping at the first. */
  force?: boolean;
}

/** The JSON API response a page came from, carrying `items` when the page listed at least one object. */
export interface GetFilesApiResponse {
  kind: 'storage#objects';
  items?: FileMetadata[];
  prefixes?: string[];
  nextPageToken?: string;
}

/** One page of a listing: file names, rolled-up prefixes, and where the next page starts. */
export interface ListingPage {
  names: string[];
  prefixes: string[];
  nextPageToken?: string;
}

/** The page size the JSON API uses without `maxResults`. */
const DEFAULT_PAGE_SIZE = 1000;

/** Refuse the callback form, which would otherwise never be called. */
function assertQuery(query: unknown, method: string): void {
  const isCallback = typeof query === 'function';
  if (isCallback) {
    throw new TypeError(`pyric-admin/storage: Bucket.${method} returns a promise; the callback form is not supported.`);
  }
}

/** Normalize optional `GetFilesOptions` / `DeleteFilesOptions`, matching `@google-cloud/storage`. */
export function normalizeListingQuery<T extends DeleteFilesOptions>(
  rawQuery: unknown,
  method: string,
): T {
  assertQuery(rawQuery, method);
  if (rawQuery === null || typeof rawQuery !== 'object' || Array.isArray(rawQuery)) {
    return {} as T;
  }
  const q = rawQuery as Record<string, unknown>;
  const out: DeleteFilesOptions = {};
  if (typeof q.prefix === 'string') {
    out.prefix = q.prefix;
  }
  if (typeof q.delimiter === 'string') {
    out.delimiter = q.delimiter;
  }
  if (typeof q.pageToken === 'string') {
    out.pageToken = q.pageToken;
  }
  if (typeof q.maxResults === 'number' && !Number.isNaN(q.maxResults)) {
    out.maxResults = q.maxResults;
  }
  if (typeof q.autoPaginate === 'boolean') {
    out.autoPaginate = q.autoPaginate;
  }
  if (typeof q.force === 'boolean') {
    out.force = q.force;
  }
  return out as T;
}

/** Does this query read every page, as `@google-cloud/paginator` decides? */
export function readsEveryPage(query: GetFilesOptions): boolean {
  const limited = typeof query.maxResults === 'number' && query.maxResults > 0;
  return !limited && query.autoPaginate !== false;
}

/** The page of `names` that `query` asks for, `pageSize` entries at most. */
export function listingPage(names: readonly string[], query: GetFilesOptions, pageSize = pageSizeOf(query)): ListingPage {
  const entries = entriesOf(names, query);
  const after = resumesAfter(query);
  let remaining = entries;
  if (after !== undefined) {
    remaining = entries.filter(entry => entry.key > after);
  }
  const page = remaining.slice(0, pageSize);
  const more = remaining.length > page.length;
  const last = page[page.length - 1];
  const result: ListingPage = {
    names: page.filter(entry => !entry.rolledUp).map(entry => entry.key),
    prefixes: page.filter(entry => entry.rolledUp).map(entry => entry.key),
  };
  if (more && last !== undefined) {
    result.nextPageToken = encodeToken(last.key);
  }
  return result;
}

/** Every file name `query` lists from its `pageToken` on, up to `maxResults` of them, across pages. */
export function everyListedName(names: readonly string[], query: GetFilesOptions): string[] {
  const { maxResults, ...rest } = query;
  const listed = listingPage(names, rest, Number.POSITIVE_INFINITY).names;
  if (typeof maxResults === 'number' && maxResults > 0) {
    return listed.slice(0, maxResults);
  }
  return listed;
}

/** The JSON API response for `page`. */
export function apiResponseOf(page: ListingPage): GetFilesApiResponse {
  const response: GetFilesApiResponse = { kind: 'storage#objects' };
  if (page.prefixes.length > 0) response.prefixes = page.prefixes;
  if (page.nextPageToken !== undefined) response.nextPageToken = page.nextPageToken;
  return response;
}

/** The entry key a query's `pageToken` resumes after, if it has one. */
export function resumesAfter(query: GetFilesOptions): string | undefined {
  if (typeof query.pageToken !== 'string') return undefined;
  return decodeToken(query.pageToken);
}

export function pageSizeOf(query: GetFilesOptions): number {
  const maxResults = query.maxResults;
  if (typeof maxResults === 'number' && maxResults > 0) {
    return Math.min(maxResults, DEFAULT_PAGE_SIZE);
  }
  return DEFAULT_PAGE_SIZE;
}

/** A listed entry: a file name, or a prefix that names roll up to at the delimiter. */
export interface Entry {
  key: string;
  rolledUp: boolean;
}

/** The entry `name` lists as under `query`'s prefix and delimiter, or `undefined` outside the prefix. */
export function entryOf(name: string, query: GetFilesOptions): Entry | undefined {
  const prefix = query.prefix ?? '';
  const delimiter = query.delimiter ?? '';
  if (!name.startsWith(prefix)) return undefined;
  const rest = name.slice(prefix.length);
  let cut = -1;
  if (delimiter !== '') {
    cut = rest.indexOf(delimiter);
  }
  const rolledUp = cut !== -1;
  let key = name;
  if (rolledUp) {
    key = prefix + rest.slice(0, cut + delimiter.length);
  }
  return { key, rolledUp };
}

/** The names under the prefix, with the delimiter's roll-up applied, in name order. */
function entriesOf(names: readonly string[], query: GetFilesOptions): Entry[] {
  const byKey = new Map<string, Entry>();
  for (const name of names) {
    const entry = entryOf(name, query);
    if (entry !== undefined) byKey.set(entry.key, entry);
  }
  return [...byKey.values()].sort((a, b) => compareKeys(a.key, b.key));
}

/** Name order, as the JSON API lists objects. */
export function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function encodeToken(key: string): string {
  return Buffer.from(key, 'utf8').toString('base64url');
}

function decodeToken(token: string): string {
  return Buffer.from(token, 'base64url').toString('utf8');
}
