import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { deleteApp, initializeApp } from '../../../src/../../pyric-admin/dist/app/index.js';
import { getStorage, type GetFilesOptions } from '../../../src/../../pyric-admin/dist/storage/index.js';
import { createBridgeMount } from '../../../src/serve/bridge-mount.js';
import { connectRemoteSandbox } from '../../../src/remote/index.js';

interface PageSummary {
  relativeNames: string[];
  relativePrefixes: string[];
  nextQueryIsNull: boolean;
  nextQueryHasPageToken: boolean;
  nextQueryMatchesInputPrefix: boolean;
  apiResponseKind: string | null;
  apiResponseHasItemsProperty: boolean;
  firstFileMetadataPopulated: boolean | null;
}

const getFilesProduction = JSON.parse(readFileSync(
  new URL('../../../src/../../conformance/observations/storage-admin/admin-storage-bucket-getfiles.json', import.meta.url),
  'utf8',
)).behavior as Record<string, unknown>;

const deleteFilesProduction = JSON.parse(readFileSync(
  new URL('../../../src/../../conformance/observations/storage-admin/admin-storage-bucket-deletefiles.json', import.meta.url),
  'utf8',
)).behavior as Record<string, unknown>;

function summarizePage(
  basePrefixWithSlash: string,
  inputPrefix: string,
  files: ReadonlyArray<{ name: string; metadata?: Record<string, unknown> }>,
  nextQuery: GetFilesOptions | null,
  apiResponse: Record<string, unknown>,
): PageSummary {
  const relativeNames = files.map((f) => {
    if (f.name.startsWith(basePrefixWithSlash)) return f.name.slice(basePrefixWithSlash.length);
    return f.name;
  });
  let rawPrefixes: string[] = [];
  if (Array.isArray(apiResponse.prefixes)) rawPrefixes = apiResponse.prefixes as string[];
  const relativePrefixes = rawPrefixes.map((p) => {
    if (p.startsWith(basePrefixWithSlash)) return p.slice(basePrefixWithSlash.length);
    return p;
  });
  let apiResponseKind: string | null = null;
  if (typeof apiResponse.kind === 'string') apiResponseKind = apiResponse.kind;
  let firstFileMetadataPopulated: boolean | null = null;
  if (files.length > 0) {
    const firstMeta = files[0]?.metadata;
    firstFileMetadataPopulated =
      firstMeta !== undefined && firstMeta !== null && Object.keys(firstMeta).length > 0;
  }
  let nextQueryHasPageToken = false;
  let nextQueryMatchesInputPrefix = false;
  if (nextQuery !== null) {
    nextQueryHasPageToken =
      typeof nextQuery.pageToken === 'string' && nextQuery.pageToken.length > 0;
    nextQueryMatchesInputPrefix = nextQuery.prefix === inputPrefix;
  }
  return {
    relativeNames,
    relativePrefixes,
    nextQueryIsNull: nextQuery === null,
    nextQueryHasPageToken,
    nextQueryMatchesInputPrefix,
    apiResponseKind,
    apiResponseHasItemsProperty: Object.prototype.hasOwnProperty.call(apiResponse, 'items'),
    firstFileMetadataPopulated,
  };
}

const rawDir = process.argv[2] ?? '.';
const directory = realpathSync(rawDir);
const SESSION = 'session-token-for-admin-bucket';
const mount = createBridgeMount({ hosted: true, projectKey: directory, disableAuditLog: true });
const server = createServer((request, response) => {
  const rawUrl = request.url ?? '/';
  const url = new URL(rawUrl, 'http://localhost');
  if (url.pathname === '/__pyric/init.json') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sessionToken: SESSION }));
    return;
  }
  void mount.handler(request, response, url).then((handled) => {
    if (!handled) response.writeHead(404).end();
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;
await mount.startHostedSandbox(
  {
    rules: null,
    rulesHash: null,
    storageRules: null,
    storageRulesHash: null,
    bridgeUrl: null,
    seed: null,
    capture: false,
    hosted: true,
    projectKey: directory,
    sessionToken: SESSION,
  },
  base,
);
mount.attachHost({ servers: [server], projectDir: directory, origin: () => ({ host: '127.0.0.1', port: address.port }) });
const remote = await connectRemoteSandbox({ url: base });
const app = initializeApp({ sandbox: remote }, 'admin-bucket-oracle');
const bucket = getStorage(app).bucket();

try {
  // storage-admin#7: Bucket.getFiles prefix, delimiter, nextQuery, pagination, apiResponse.items, and file.metadata.
  const listBase = 'pyric_oracle/admin_getfiles/';
  const seeded = ['items/123/a.bin', 'items/123/b/c.bin', 'items/124/a.bin', 'items/2/x.bin', 'readme.txt', 'items'];
  for (const rel of seeded) {
    await bucket.file(`${listBase}${rel}`).save(Buffer.from([0x67, 0x66]), { contentType: 'application/octet-stream' });
  }
  const [partialFiles, partialNext, partialApi] = await bucket.getFiles({ prefix: `${listBase}items/12` });
  const partialFolderPrefix = summarizePage(
    listBase,
    `${listBase}items/12`,
    partialFiles as unknown as Array<{ name: string; metadata?: Record<string, unknown> }>,
    partialNext,
    partialApi as unknown as Record<string, unknown>,
  );
  const [slashFiles, slashNext, slashApi] = await bucket.getFiles({ prefix: `${listBase}items/123/` });
  const slashFolderPrefix = summarizePage(
    listBase,
    `${listBase}items/123/`,
    slashFiles as unknown as Array<{ name: string; metadata?: Record<string, unknown> }>,
    slashNext,
    slashApi as unknown as Record<string, unknown>,
  );
  const [delimFiles, delimNext, delimApi] = await bucket.getFiles({ prefix: listBase, delimiter: '/' });
  const delimiterRollup = summarizePage(
    listBase,
    listBase,
    delimFiles as unknown as Array<{ name: string; metadata?: Record<string, unknown> }>,
    delimNext,
    delimApi as unknown as Record<string, unknown>,
  );
  const [p1Files, p1Next, p1Api] = await bucket.getFiles({ prefix: listBase, delimiter: '/', maxResults: 2, autoPaginate: false });
  const page1 = summarizePage(
    listBase,
    listBase,
    p1Files as unknown as Array<{ name: string; metadata?: Record<string, unknown> }>,
    p1Next,
    p1Api as unknown as Record<string, unknown>,
  );
  assert.ok(p1Next !== null);
  const [p2Files, p2Next, p2Api] = await bucket.getFiles({ ...p1Next, autoPaginate: false });
  const page2 = summarizePage(
    listBase,
    listBase,
    p2Files as unknown as Array<{ name: string; metadata?: Record<string, unknown> }>,
    p2Next,
    p2Api as unknown as Record<string, unknown>,
  );
  assert.deepEqual(
    {
      partialFolderPrefix,
      slashFolderPrefix,
      delimiterRollup,
      paginated: { page1, page2 },
    },
    getFilesProduction,
  );

  // storage-admin#8: Bucket.deleteFiles prefix deletion, maxResults cap, sibling isolation, and empty prefix.
  const delBase = 'pyric_oracle/admin_deletefiles/';
  const capped = ['capped/a.bin', 'capped/b.bin', 'capped/c.bin'];
  const full = ['full/one.bin', 'full/nested/two.bin'];
  const sibling = 'sibling/keep.bin';
  for (const rel of [...capped, ...full, sibling]) {
    await bucket.file(`${delBase}${rel}`).save(Buffer.from([0x64, 0x66]), { contentType: 'application/octet-stream' });
  }
  await bucket.deleteFiles({ prefix: `${delBase}capped/`, maxResults: 2 });
  const remainingAfterCapped: string[] = [];
  for (const rel of capped) {
    const [exists] = await bucket.file(`${delBase}${rel}`).exists();
    if (exists) remainingAfterCapped.push(rel);
  }
  const [siblingAfterCapped] = await bucket.file(`${delBase}${sibling}`).exists();
  await bucket.deleteFiles({ prefix: `${delBase}full/` });
  const remainingAfterFull: string[] = [];
  for (const rel of full) {
    const [exists] = await bucket.file(`${delBase}${rel}`).exists();
    if (exists) remainingAfterFull.push(rel);
  }
  const [siblingAfterFull] = await bucket.file(`${delBase}${sibling}`).exists();
  let emptyPrefixThrew = false;
  try {
    await bucket.deleteFiles({ prefix: `${delBase}empty-nonexistent/` });
  } catch {
    emptyPrefixThrew = true;
  }
  assert.deepEqual(
    {
      cappedMaxResults2: {
        seededCount: capped.length,
        remainingRelativeNames: remainingAfterCapped,
        siblingStillExists: siblingAfterCapped,
      },
      fullPrefixDelete: {
        seededCount: full.length,
        remainingRelativeNames: remainingAfterFull,
        siblingStillExists: siblingAfterFull,
      },
      emptyPrefixDelete: { threw: emptyPrefixThrew },
    },
    deleteFilesProduction,
  );
} finally {
  await deleteApp(app);
  await remote.close?.();
  await mount.close();
  server.close();
}

console.log('Admin bucket oracle replay passed');
