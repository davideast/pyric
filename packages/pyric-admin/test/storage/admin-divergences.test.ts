/**
 * Regression and upstream `@google-cloud/storage` / `firebase@12.19.0`
 * conformance tests for `pyric-admin/storage` divergences:
 *
 * - `#1966`: leading-slash (`/lead.txt`), doubled-slash (`dd//x.txt`), and
 *   trailing-slash (`folder/`, `dir/sub/`) object names round-trip across
 *   `save`, `createWriteStream`, `exists`, `download`, `getMetadata`,
 *   `setMetadata`, `copy`, `delete`, `getFiles`, and client `listAll`.
 * - `#1967`: `save()` and `createWriteStream()` infer `contentType` from the
 *   object name when `contentType` is omitted, empty, or `'auto'`, matching
 *   `@google-cloud/storage` (`mime.getType(this.name)` -> fallback
 *   `'application/octet-stream'`).
 * - `#1968`: missing-object rejections from `download`, `createReadStream`,
 *   `getMetadata`, `setMetadata`, `copy`, and `getDownloadURL` carry numeric
 *   `code: 404` (`ApiError` parity), while `delete()` resolves idempotently.
 */

import 'fake-indexeddb/auto';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { afterEach, describe, expect, it } from 'bun:test';
import { isRemoteSandbox } from 'pyric/sandbox';
import { getStorageSandbox, listAll, ref } from 'pyric/storage';

import { deleteApp, getApps } from '../../src/app/index.js';
import { getDownloadURL, getStorage, type File } from '../../src/storage/index.js';
import { STORAGE_ARMS } from './arms.js';
import { createOfflineUpstreamStorageHarness } from './upstream-storage-oracle.js';

const requireFromAdmin = createRequire(import.meta.url);
const firebaseAdminStorageEntry = requireFromAdmin.resolve('firebase-admin/storage');
const requireFromFirebaseAdmin = createRequire(firebaseAdminStorageEntry);
const gcsEntry = requireFromFirebaseAdmin.resolve('@google-cloud/storage');
const requireFromGcs = createRequire(gcsEntry);
const upstreamMime = requireFromGcs('mime') as { getType(path: string): string | null };

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

async function writeViaStream(
  file: File,
  payload: Buffer | string,
  options?: Parameters<File['createWriteStream']>[0],
): Promise<void> {
  await pipeline(Readable.from([payload]), file.createWriteStream(options));
}

async function readStreamError(file: File): Promise<unknown> {
  const stream = file.createReadStream();
  let caught: unknown;
  stream.on('error', (err) => {
    if (caught === undefined) {
      caught = err;
    }
  });
  const done = finished(stream).catch((err) => {
    if (caught === undefined) {
      caught = err;
    }
  });
  stream.resume();
  await done;
  return caught;
}

describe.each(STORAGE_ARMS)('Admin Storage divergences (#1966, #1967, #1968) (%s arm)', (_arm, openApp) => {
  it('#1966: round-trips leading-slash, doubled-slash, and trailing-slash object names without colliding with normalized paths', async () => {
    const app = openApp();
    const bucket = getStorage(app).bucket();

    const specialNames = [
      '/',
      '//',
      '/lead.txt',
      '/nested/item.txt',
      '//double-lead.txt',
      'dd//x.txt',
      'dd///y.txt',
      'folder/',
      'dir/sub/',
    ];

    for (const name of specialNames) {
      await bucket.file(name).save(`admin:${name}`);
    }
    // Distinct normalized names must not overwrite or collide with the literal names above.
    await bucket.file('lead.txt').save('normalized:lead');
    await bucket.file('dd/x.txt').save('normalized:dd-x');
    await bucket.file('folder').save('normalized:folder-file');
    await bucket.file('folder/member.txt').save('normalized:folder-member');

    for (const name of specialNames) {
      const handle = bucket.file(name);
      expect(await handle.exists()).toEqual([true]);
      const [downloaded] = await handle.download();
      expect(downloaded.toString('utf8')).toBe(`admin:${name}`);
      const [meta] = await handle.getMetadata();
      expect(meta.name).toBe(name);
    }

    expect((await bucket.file('lead.txt').download())[0].toString('utf8')).toBe('normalized:lead');
    expect((await bucket.file('dd/x.txt').download())[0].toString('utf8')).toBe('normalized:dd-x');
    expect((await bucket.file('folder').download())[0].toString('utf8')).toBe('normalized:folder-file');

    const [allFiles] = await bucket.getFiles();
    const expectedSorted = [
      ...specialNames,
      'dd/x.txt',
      'folder',
      'folder/member.txt',
      'lead.txt',
    ].sort();
    expect(allFiles.map((f) => f.name)).toEqual(expectedSorted);
    expect(allFiles.map((f) => f.metadata.name)).toEqual(expectedSorted);

    // Prefix and delimiter queries preserve GCS literal semantics on both arms.
    const [leadPrefixFiles] = await bucket.getFiles({ prefix: '/lead' });
    expect(leadPrefixFiles.map((f) => f.name)).toEqual(['/lead.txt']);

    const [ddDoublePrefixFiles] = await bucket.getFiles({ prefix: 'dd//' });
    expect(ddDoublePrefixFiles.map((f) => f.name)).toEqual(['dd///y.txt', 'dd//x.txt']);

    const [folderDelimited, , folderApi] = await bucket.getFiles({
      prefix: 'folder/',
      delimiter: '/',
    });
    expect(folderDelimited.map((f) => f.name)).toEqual(['folder/', 'folder/member.txt']);
    expect(folderApi.prefixes).toBeUndefined();

    // setMetadata, copy, and delete also address the literal object name.
    const [updatedLead] = await bucket.file('/lead.txt').setMetadata({
      metadata: { tagged: 'yes' },
    });
    expect(updatedLead.name).toBe('/lead.txt');
    expect(updatedLead.metadata).toEqual({ tagged: 'yes' });

    const [copiedPlaceholder, copiedMeta] = await bucket.file('folder/').copy('copied-folder/');
    expect(copiedPlaceholder.name).toBe('copied-folder/');
    expect(copiedMeta.name).toBe('copied-folder/');
    expect(await bucket.file('copied-folder/').exists()).toEqual([true]);

    await bucket.file('/lead.txt').delete();
    expect(await bucket.file('/lead.txt').exists()).toEqual([false]);
    expect(await bucket.file('lead.txt').exists()).toEqual([true]);
  });

  it('#1966: hides folder/ placeholder and unsupported slash names from client listAll', async () => {
    const app = openApp();
    const bucket = getStorage(app).bucket();

    await bucket.file('/lead.txt').save('lead');
    await bucket.file('dd//x.txt').save('double');
    await bucket.file('folder/').save('');
    await bucket.file('folder/visible.txt').save('visible');
    await bucket.file('empty-folder/').save('');
    await bucket.file('top.txt').save('top');

    if (!isRemoteSandbox(app.sandbox)) {
      const client = getStorageSandbox(app.sandbox, {
        rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`,
      });
      const rootListed = await listAll(ref(client));
      expect(rootListed.items.map((i) => i.fullPath)).toEqual(['top.txt']);
      expect(rootListed.prefixes.map((p) => p.fullPath)).toEqual(['empty-folder', 'folder']);

      const folderListed = await listAll(ref(client, 'folder'));
      expect(folderListed.items.map((i) => i.fullPath)).toEqual(['folder/visible.txt']);
      expect(folderListed.prefixes).toEqual([]);

      const emptyFolderListed = await listAll(ref(client, 'empty-folder'));
      expect(emptyFolderListed.items).toEqual([]);
      expect(emptyFolderListed.prefixes).toEqual([]);
    } else {
      // On the remote arm, verify un-lensed client `storage.listAll` over the wire channel.
      const rootWire = (await app.sandbox.channel.op({
        method: 'storage.listAll',
        path: '',
      })) as { items: Array<{ fullPath: string }>; prefixes: Array<{ fullPath: string }> };
      expect(rootWire.items.map((i) => i.fullPath)).toEqual(['top.txt']);
      expect(rootWire.prefixes.map((p) => p.fullPath)).toEqual(['empty-folder', 'folder']);

      const folderWire = (await app.sandbox.channel.op({
        method: 'storage.listAll',
        path: 'folder',
      })) as { items: Array<{ fullPath: string }>; prefixes: Array<{ fullPath: string }> };
      expect(folderWire.items.map((i) => i.fullPath)).toEqual(['folder/visible.txt']);
      expect(folderWire.prefixes).toEqual([]);
    }
  });

  it('#1967: save() and createWriteStream() infer contentType matching @google-cloud/storage mime.getType(this.name)', async () => {
    const app = openApp();
    const bucket = getStorage(app).bucket();

    const samplePaths = [
      'a.png',
      'assets/PHOTO.JPG',
      'data/config.json',
      'pages/index.html',
      'docs/readme.txt',
      'icons/logo.svg',
      'reports/summary.pdf',
      'styles/site.css',
      'scripts/app.js',
      'scripts/module.mjs',
      'wasm/module.wasm',
      'archives/bundle.zip',
      'archives/source.tar',
      'audio/clip.mp3',
      'audio/clip.wav',
      'video/demo.mp4',
      'fonts/inter.woff2',
      'dir.v1/no-extension',
      'dir/.png',
      '.png',
      'unknown.unknownext',
      'folder/',
    ];

    for (const objectPath of samplePaths) {
      const expectedMime = upstreamMime.getType(objectPath) ?? 'application/octet-stream';

      const savedFile = bucket.file(`save/${objectPath}`);
      // Compute expected MIME on the full path `save/${objectPath}` for paths sensitive to `hasPath` (`txt` vs `save/txt`).
      const expectedForSaved = upstreamMime.getType(savedFile.name) ?? 'application/octet-stream';
      await savedFile.save('sample-bytes');
      const [savedMeta] = await savedFile.getMetadata();
      expect(savedMeta.contentType).toBe(expectedForSaved);

      const streamedFile = bucket.file(`stream/${objectPath}`);
      const expectedForStreamed =
        upstreamMime.getType(streamedFile.name) ?? 'application/octet-stream';
      await writeViaStream(streamedFile, 'stream-bytes');
      const [streamedMeta] = await streamedFile.getMetadata();
      expect(streamedMeta.contentType).toBe(expectedForStreamed);

      // Direct root path check for bare `.png` / `a.png` etc.
      const rootFile = bucket.file(objectPath);
      await rootFile.save('root-bytes');
      const [rootMeta] = await rootFile.getMetadata();
      expect(rootMeta.contentType).toBe(expectedMime);
    }

    // Explicit `options.contentType` and `options.metadata.contentType` override inference;
    // `'auto'` triggers filename inference matching @google-cloud/storage.
    const overrideTop = bucket.file('override/a.png');
    await overrideTop.save('raw', {
      contentType: 'application/x-custom',
      metadata: { contentType: 'text/plain' },
    });
    expect((await overrideTop.getMetadata())[0].contentType).toBe('application/x-custom');

    const overrideNested = bucket.file('override/b.png');
    await overrideNested.save('raw', { metadata: { contentType: 'image/webp' } });
    expect((await overrideNested.getMetadata())[0].contentType).toBe('image/webp');

    const autoTyped = bucket.file('override/c.json');
    await autoTyped.save('{}', { contentType: 'auto' });
    expect((await autoTyped.getMetadata())[0].contentType).toBe('application/json');
  });

  it('#1968: missing-object errors carry numeric code 404 matching nodejs-common ApiError, while delete() resolves', async () => {
    const app = openApp({ storageBucket: 'code-404-bucket' });
    const bucket = getStorage(app).bucket('code-404-bucket');
    const missing = bucket.file('missing/object.txt');

    const upstream = createOfflineUpstreamStorageHarness('code-404-bucket');
    const upMissing = upstream.svc.bucket('code-404-bucket').file('missing/object.txt');

    try {
      const operations: Array<[string, () => Promise<unknown>, () => Promise<unknown>]> = [
        ['download', () => missing.download(), () => upMissing.download()],
        ['getMetadata', () => missing.getMetadata(), () => upMissing.getMetadata()],
        [
          'setMetadata',
          () => missing.setMetadata({ contentType: 'text/plain' }),
          () => upMissing.setMetadata({ contentType: 'text/plain' }),
        ],
        ['copy', () => missing.copy('dest.txt'), () => upMissing.copy('dest.txt')],
        ['getDownloadURL', () => getDownloadURL(missing), () => upstream.getDownloadURL(upMissing)],
      ];

      for (const [label, runPyric, runUpstream] of operations) {
        let pyricErr: (Error & { code?: unknown }) | undefined;
        try {
          await runPyric();
        } catch (err) {
          pyricErr = err as Error & { code?: unknown };
        }
        let upstreamErr: (Error & { code?: unknown }) | undefined;
        try {
          await runUpstream();
        } catch (err) {
          upstreamErr = err as Error & { code?: unknown };
        }

        expect(pyricErr, `${label} should reject`).toBeInstanceOf(Error);
        expect(upstreamErr, `upstream ${label} should reject`).toBeInstanceOf(Error);
        expect(pyricErr?.code).toBe(404);
        expect(typeof pyricErr?.code).toBe('number');
        expect(pyricErr?.code).toBe(upstreamErr?.code);
        expect(pyricErr?.message).toContain('No such object');
      }

      const streamErr = (await readStreamError(missing)) as (Error & { code?: unknown }) | undefined;
      expect(streamErr).toBeInstanceOf(Error);
      expect(streamErr?.code).toBe(404);
      expect(streamErr?.message).toContain('No such object');

      // Deleting a missing file resolves idempotently by design.
      await expect(missing.delete()).resolves.toBeUndefined();
    } finally {
      await upstream.dispose();
    }
  });
});
