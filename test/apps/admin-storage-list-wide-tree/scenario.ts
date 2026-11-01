// A backend lists a bucket with a folder per object through firebase-admin's
// bucket.getFiles(), running under `pyric sandbox --hosted` as the release
// verification run did (#1183). Every listing returns the objects in name
// order, maxResults returns one page, and the client still answers afterward.
// Before the fix, each listing failed with resource-exhausted: the walk
// listed every folder at once, past the client's 256 pending operations.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

interface Listing {
  names?: string[];
  nextQuery?: { pageToken?: string } | null;
  prefixes?: string[];
  error?: string;
}

interface Report {
  seeded: number;
  timingsMs: Record<string, number>;
  whole: Listing;
  mediaPrefix: Listing;
  firstHundred: Listing;
  mediaFolders: Listing;
  metadataAfter: string;
}

const MEDIA = Array.from({ length: 1000 }, (_, n) => `media/${n}/original.jpg`);
const USERS = Array.from({ length: 400 }, (_, n) => `users/u${n}/avatar.png`);
const DEEP = Array.from({ length: 41 }, (_, depth) => `${['deep', ...Array.from({ length: depth }, () => 'd')].join('/')}/level.txt`);
const ALL = [...MEDIA, ...USERS, ...DEEP, 'media-index.json', 'media0.txt'];

/** Name order, as the JSON API lists objects. */
function byName(names: string[]): string[] {
  return [...names].sort((a, b) => {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
}

export default scenario(async (app) => {
  const report = await app.step('the backend runs under pyric sandbox --hosted and lists 1,443 objects', async () => {
    const port = await app.freePort();
    const result = await app.serverScript(
      'pyric.mjs',
      ['sandbox', '--hosted', '--no-open', '--port', String(port), '--', 'node', 'backend.mjs'],
      { timeoutMs: 240_000 },
    );
    // `pyric sandbox` prints its command's output with a `[dev] ` prefix.
    const line = result.output.split('\n').map((text) => text.replace(/^\[dev\] /, '')).findLast((text) => text.startsWith('{'));
    assert.ok(line, 'backend.mjs printed no JSON report');
    const parsed = JSON.parse(line) as Report;
    console.log(`getFiles timings (ms): ${JSON.stringify(parsed.timingsMs)}`);
    return parsed;
  });

  await app.step('getFiles() lists every object in name order', () => {
    assert.equal(report.whole.error, undefined);
    assert.equal(report.seeded, 1443);
    assert.deepEqual(report.whole.names, byName(ALL));
  });

  await app.step('getFiles({ prefix }) lists the objects under the prefix', () => {
    assert.equal(report.mediaPrefix.error, undefined);
    assert.deepEqual(report.mediaPrefix.names, byName(MEDIA));
  });

  await app.step('getFiles({ maxResults }) returns the first page and a next query', () => {
    assert.equal(report.firstHundred.error, undefined);
    assert.deepEqual(report.firstHundred.names, byName(ALL).slice(0, 100));
    assert.equal(typeof report.firstHundred.nextQuery?.pageToken, 'string');
  });

  await app.step('getFiles({ prefix, delimiter }) rolls each folder up to a prefix', () => {
    assert.equal(report.mediaFolders.error, undefined);
    assert.deepEqual(report.mediaFolders.names, []);
    assert.deepEqual(report.mediaFolders.prefixes, byName(MEDIA.map((name) => name.slice(0, name.lastIndexOf('/') + 1))));
  });

  await app.step('the client still answers after the listings', () => {
    assert.equal(report.metadataAfter, 'media/7/original.jpg');
  });
});
