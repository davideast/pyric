/**
 * The object names a `getFiles` query reads on a remote sandbox's host, with
 * the host's `storage.listAll` op. That op lists one folder: its files and its
 * subfolders. A `getFiles` prefix is not a folder (`users/12` matches
 * `users/123/a.png`), so the walk starts at the folder holding the prefix and
 * enters each subfolder whose path can hold a matching name.
 *
 * The walk goes in name order, depth first, with a few folder listings in
 * flight at once (#1183): a client may have 256 pending operations, and a
 * store with a folder per object has more folders than that. Because names
 * come in order, a query that needs one page stops once it has that page.
 *
 *   - Name order: every name in folder `f` starts with `f/`, and no file in
 *     the parent sorts between two such names, so visiting a folder's files
 *     and subfolders sorted by `name` and `path + '/'` yields names in order.
 *   - A subfolder whose names all roll up to one prefix at the delimiter is
 *     not entered: the walk yields that prefix in place of its names, which
 *     the listing reports as a prefix, never as a file.
 *   - A subfolder whose names all sort at or before the `pageToken` is not
 *     entered: every name in `f` sorts before `f0`.
 */
import { compareKeys, entryOf, resumesAfter, type GetFilesOptions } from './file-query.js';

/** A folder's listing, as the host's `storage.listAll` answers it. */
export interface FolderListing {
  items: Array<{ fullPath: string }>;
  prefixes: Array<{ fullPath: string }>;
}

export type ListFolder = (path: string) => Promise<FolderListing>;

/** How many folder listings the walk keeps in flight, well under the 256 a client may have pending. */
export const WALK_CONCURRENCY = 8;

/**
 * The names under `query`'s prefix, in name order, listing folders with
 * `listFolder`. `enough` sees each name as it is found and stops the walk
 * once it answers true.
 */
export async function namesForQuery(
  query: GetFilesOptions,
  listFolder: ListFolder,
  enough: (name: string) => boolean = () => false,
): Promise<string[]> {
  const names: string[] = [];
  for await (const name of walkNames(query, listFolder)) {
    names.push(name);
    if (enough(name)) break;
  }
  return names;
}

type WalkNode =
  | { kind: 'names'; names: string[] }
  | { kind: 'folder'; path: string; listing?: Promise<FolderListing> };

/** Yield the names under `query`'s prefix in name order, `concurrency` listings at a time at most. */
export async function* walkNames(
  query: GetFilesOptions,
  listFolder: ListFolder,
  concurrency = WALK_CONCURRENCY,
): AsyncGenerator<string> {
  const prefix = query.prefix ?? '';
  const start = prefix.slice(0, Math.max(prefix.lastIndexOf('/'), 0));
  // The next node is at the end; nodes below it come later in name order.
  const stack: WalkNode[] = [{ kind: 'folder', path: start }];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.kind === 'names') {
      yield* node.names;
      continue;
    }
    const listing = node.listing ?? listFolder(node.path);
    listAhead(stack, concurrency - 1, listFolder);
    stack.push(...childrenOf(await listing, query).reverse());
  }
}

/**
 * Start the listings of the next `ahead` folders in name order. A listing
 * started here is awaited when its folder comes up; until then its rejection
 * is marked handled, so a walk that stops first leaves no unhandled one.
 */
function listAhead(stack: WalkNode[], ahead: number, listFolder: ListFolder): void {
  let started = 0;
  for (let index = stack.length - 1; index >= 0 && started < ahead; index -= 1) {
    const node = stack[index]!;
    if (node.kind !== 'folder') continue;
    started += 1;
    if (node.listing !== undefined) continue;
    node.listing = listFolder(node.path);
    node.listing.catch(() => {});
  }
}

/** A folder's files and the subfolders worth entering, in name order, with runs of names grouped. */
function childrenOf(listing: FolderListing, query: GetFilesOptions): WalkNode[] {
  const prefix = query.prefix ?? '';
  const after = resumesAfter(query);
  const children: Array<{ key: string; node: WalkNode }> = [];
  for (const { fullPath } of listing.items) {
    if (fullPath.startsWith(prefix)) children.push({ key: fullPath, node: { kind: 'names', names: [fullPath] } });
  }
  for (const { fullPath } of listing.prefixes) {
    const key = `${fullPath}/`;
    const holdsMatch = canHoldMatch(key, prefix);
    const passedByToken = after !== undefined && `${fullPath}0` <= after;
    if (!holdsMatch || passedByToken) continue;
    const rolledUp = rollUpOf(key, query);
    const node: WalkNode = rolledUp === undefined ? { kind: 'folder', path: fullPath } : { kind: 'names', names: [rolledUp] };
    children.push({ key, node });
  }
  children.sort((a, b) => compareKeys(a.key, b.key));
  return groupNames(children.map(child => child.node));
}

/** The prefix every name in the folder `folderWithSlash` rolls up to, if they all roll up to one. */
function rollUpOf(folderWithSlash: string, query: GetFilesOptions): string | undefined {
  const underPrefix = folderWithSlash.startsWith(query.prefix ?? '');
  if (!underPrefix) return undefined;
  const entry = entryOf(folderWithSlash, query);
  return entry?.rolledUp === true ? entry.key : undefined;
}

/** Merge each run of adjacent name nodes into one, so looking ahead skips a run in one step. */
function groupNames(nodes: WalkNode[]): WalkNode[] {
  const grouped: WalkNode[] = [];
  for (const node of nodes) {
    const last = grouped[grouped.length - 1];
    const joinsRun = node.kind === 'names' && last?.kind === 'names';
    if (joinsRun) last.names.push(...node.names);
    else grouped.push(node);
  }
  return grouped;
}

/** Can a name in the folder `folderWithSlash` start with `prefix`? */
function canHoldMatch(folderWithSlash: string, prefix: string): boolean {
  return folderWithSlash.startsWith(prefix) || prefix.startsWith(folderWithSlash);
}
