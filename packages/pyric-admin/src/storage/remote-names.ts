/**
 * The object names under a prefix on a remote sandbox's host, read with the
 * host's `storage.listAll` op. That op lists one folder: its files and its
 * subfolders. A `getFiles` prefix is not a folder (`users/12` matches
 * `users/123/a.png`), so the walk starts at the folder holding the prefix and
 * enters each subfolder whose path can hold a matching name.
 */

/** A folder's listing, as the host's `storage.listAll` answers it. */
export interface FolderListing {
  items: Array<{ fullPath: string }>;
  prefixes: Array<{ fullPath: string }>;
}

/** Every object name starting with `prefix`, listing folders with `listFolder`. */
export async function namesUnderPrefix(
  prefix: string,
  listFolder: (path: string) => Promise<FolderListing>,
): Promise<string[]> {
  const names: string[] = [];
  const walk = async (folder: string): Promise<void> => {
    const { items, prefixes } = await listFolder(folder);
    for (const item of items) if (item.fullPath.startsWith(prefix)) names.push(item.fullPath);
    const entered = prefixes.map(sub => sub.fullPath).filter(path => canHoldMatch(`${path}/`, prefix));
    await Promise.all(entered.map(walk));
  };
  await walk(prefix.slice(0, Math.max(prefix.lastIndexOf('/'), 0)));
  return names;
}

/** Can a name in the folder `folderWithSlash` start with `prefix`? */
function canHoldMatch(folderWithSlash: string, prefix: string): boolean {
  return folderWithSlash.startsWith(prefix) || prefix.startsWith(folderWithSlash);
}
