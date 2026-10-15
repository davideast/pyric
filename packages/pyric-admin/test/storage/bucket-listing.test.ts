/**
 * The listing semantics `Bucket.getFiles` and `Bucket.deleteFiles` share on
 * both arms, over plain name lists: prefix matching, delimiter roll-up, pages,
 * the result tuple, and `deleteFiles`' `force`, as `@google-cloud/storage`
 * 7.x and `@google-cloud/paginator` behave.
 */
import { describe, expect, it } from 'bun:test';
import { deleteListedFiles } from '../../src/storage/delete-files.js';
import { everyListedName, listingPage } from '../../src/storage/file-query.js';
import { getFilesResponse } from '../../src/storage/get-files.js';
import { namesUnderPrefix, type FolderListing } from '../../src/storage/remote-names.js';

const NAMES = ['users/123/a.png', 'users/123/b/c.png', 'users/124/a.png', 'users/2/x', 'readme.txt', 'users'];

describe('listingPage', () => {
  it('matches a prefix verbatim, not as a folder, in name order', () => {
    expect(listingPage(NAMES, { prefix: 'users/12' }).names).toEqual(['users/123/a.png', 'users/123/b/c.png', 'users/124/a.png']);
    expect(listingPage(NAMES, { prefix: 'users/123/' }).names).toEqual(['users/123/a.png', 'users/123/b/c.png']);
  });

  it('lists the whole bucket with no prefix or an empty one', () => {
    const sorted = [...NAMES].sort();
    expect(listingPage(NAMES, {}).names).toEqual(sorted);
    expect(listingPage(NAMES, { prefix: '' }).names).toEqual(sorted);
  });

  it('rolls names up at the delimiter into prefixes ending in it', () => {
    expect(listingPage(NAMES, { delimiter: '/' })).toEqual({ names: ['readme.txt', 'users'], prefixes: ['users/'] });
    expect(listingPage(NAMES, { prefix: 'users/123/', delimiter: '/' })).toEqual({ names: ['users/123/a.png'], prefixes: ['users/123/b/'] });
  });

  it('pages files and prefixes together, and a page token resumes after the last entry', () => {
    const first = listingPage(NAMES, { delimiter: '/', maxResults: 2 });
    expect(first.names).toEqual(['readme.txt', 'users']);
    expect(first.nextPageToken).toBeString();
    const second = listingPage(NAMES, { delimiter: '/', maxResults: 2, pageToken: first.nextPageToken });
    expect(second).toEqual({ names: [], prefixes: ['users/'] });
  });

  it('lists every page up to maxResults for deleteFiles', () => {
    expect(everyListedName(NAMES, { prefix: 'users/' })).toHaveLength(4);
    expect(everyListedName(NAMES, { prefix: 'users/', maxResults: 3 })).toEqual(['users/123/a.png', 'users/123/b/c.png', 'users/124/a.png']);
  });
});

describe('getFilesResponse', () => {
  const many = Array.from({ length: 2500 }, (_, index) => `logs/${String(index).padStart(5, '0')}`);

  it('reads every page by default; the second element is the query the call was made with', () => {
    const [files, nextQuery, apiResponse] = getFilesResponse(many, { prefix: 'logs/' }, (name) => name);
    expect(files).toHaveLength(2500);
    expect(nextQuery).toEqual({ prefix: 'logs/' });
    expect(apiResponse).toEqual({ kind: 'storage#objects' });
  });

  it('gives one page and the query for the next with autoPaginate: false or maxResults', () => {
    const [files, nextQuery] = getFilesResponse(many, { autoPaginate: false }, (name) => name);
    expect(files).toHaveLength(1000);
    expect(nextQuery?.pageToken).toBeString();
    const [limited, limitedNext, response] = getFilesResponse(many, { maxResults: 10 }, (name) => name);
    expect(limited).toEqual(many.slice(0, 10));
    expect(limitedNext).toEqual({ maxResults: 10, pageToken: response.nextPageToken });
    const [last, lastNext] = getFilesResponse(many, { maxResults: 3000 }, (name) => name);
    expect(last).toHaveLength(1000);
    expect(lastNext).not.toBeNull();
  });

  it('gives null for the next query on the last page', () => {
    const [files, nextQuery] = getFilesResponse(['a', 'b'], { maxResults: 5 }, (name) => name);
    expect(files).toEqual(['a', 'b']);
    expect(nextQuery).toBeNull();
  });
});

describe('deleteListedFiles', () => {
  const failing = (bad: Set<string>, deleted: string[]) => async (name: string): Promise<void> => {
    if (bad.has(name)) throw new Error(`cannot delete ${name}`);
    deleted.push(name);
  };

  it('deletes each file the query lists and nothing else', async () => {
    const deleted: string[] = [];
    await deleteListedFiles(NAMES, { prefix: 'users/123/' }, failing(new Set(), deleted));
    expect(deleted.sort()).toEqual(['users/123/a.png', 'users/123/b/c.png']);
  });

  it('rejects with the first error without force', async () => {
    const deleted: string[] = [];
    const error = await deleteListedFiles(NAMES, {}, failing(new Set(['readme.txt']), deleted)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('cannot delete readme.txt');
  });

  it('with force, deletes every other file and rejects with the array of errors', async () => {
    const deleted: string[] = [];
    const bad = new Set(['readme.txt', 'users/2/x']);
    const error = await deleteListedFiles(NAMES, { force: true }, failing(bad, deleted)).catch((caught: unknown) => caught);
    expect(Array.isArray(error)).toBe(true);
    expect((error as Error[]).map((each) => each.message).sort()).toEqual(['cannot delete readme.txt', 'cannot delete users/2/x']);
    expect(deleted.sort()).toEqual(NAMES.filter((name) => !bad.has(name)).sort());
  });
});

describe('namesUnderPrefix', () => {
  /** A host's folder listing over NAMES, as `storage.listAll` answers it. */
  const listed: string[] = [];
  const listFolder = async (path: string): Promise<FolderListing> => {
    listed.push(path);
    const scan = path === '' ? '' : `${path}/`;
    const items: FolderListing['items'] = [];
    const folders = new Set<string>();
    for (const name of NAMES.filter((each) => each.startsWith(scan))) {
      const rest = name.slice(scan.length);
      const slash = rest.indexOf('/');
      if (slash === -1) items.push({ fullPath: name });
      else folders.add(scan + rest.slice(0, slash));
    }
    return { items, prefixes: [...folders].sort().map((fullPath) => ({ fullPath })) };
  };

  it('finds names under a prefix that ends inside a folder name, entering only folders that can hold one', async () => {
    listed.length = 0;
    expect((await namesUnderPrefix('users/12', listFolder)).sort()).toEqual(['users/123/a.png', 'users/123/b/c.png', 'users/124/a.png']);
    expect(listed.sort()).toEqual(['users', 'users/123', 'users/123/b', 'users/124']);
  });

  it('walks the whole bucket for an empty prefix', async () => {
    expect((await namesUnderPrefix('', listFolder)).sort()).toEqual([...NAMES].sort());
  });
});
