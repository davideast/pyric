/**
 * `Bucket.deleteFiles`, as `@google-cloud/storage` runs it: list the files the
 * query names across every page, up to `maxResults`, and delete them ten at a
 * time.
 *
 * Without `force`, the first failed delete rejects the call and no more are
 * started. With `force`, every file is tried, and the call rejects with the
 * array of errors when any failed, as the library's callback receives them.
 */
import { entryOf, everyListedName, resumesAfter, type DeleteFilesOptions } from './file-query.js';

/** How many deletes `@google-cloud/storage` runs at once. */
const PARALLEL_DELETES = 10;

/** Delete each object of `names` that `query` lists, with `remove`. */
export async function deleteListedFiles(
  names: readonly string[],
  query: DeleteFilesOptions,
  remove: (name: string) => Promise<void>,
): Promise<void> {
  const queue = everyListedName(names, query);
  const errors: unknown[] = [];
  const force = query.force === true;
  const worker = async (): Promise<void> => {
    for (;;) {
      const stopped = errors.length > 0 && !force;
      const name = queue.shift();
      if (stopped || name === undefined) return;
      try {
        await remove(name);
      } catch (error) {
        errors.push(error);
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL_DELETES }, worker));
  if (errors.length === 0) return;
  if (!force) throw errors[0];
  throw errors;
}

/**
 * A stop rule for names arriving in name order: true once they hold the
 * `maxResults` files `deleteFiles(query)` deletes. Without `maxResults` it
 * deletes every listed file, so it needs every name.
 */
export function deletedNamesFound(query: DeleteFilesOptions): (name: string) => boolean {
  const maxResults = query.maxResults ?? 0;
  const limited = maxResults > 0;
  if (!limited) return () => false;
  const after = resumesAfter(query);
  let found = 0;
  return (name) => {
    const entry = entryOf(name, query);
    const listedFile = entry !== undefined && !entry.rolledUp && (after === undefined || entry.key > after);
    if (listedFile) found += 1;
    return found >= maxResults;
  };
}
