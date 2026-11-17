/**
 * Admin-plane literal scheme-prefixed object path preservation (`ref` + `listAll`),
 * keeping client `ref(storage, url)` URL parsing and `<path>/` folder-placeholder
 * hiding intact.
 */

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getBytes,
  getStorageSandbox,
  listAll,
  ref,
  uploadBytes,
  type StorageReference,
} from '../../src/storage/index.js';
import { getAdminStorageSandbox } from '../../src/storage/internal.js';

const OPEN_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;

describe('admin storage literal scheme-prefixed object paths', () => {
  it('preserves literal gs:// and https:// object names on admin handles while parsing URLs on client handles', async () => {
    const sandbox = initializeSandbox();
    const admin = getAdminStorageSandbox(sandbox, {
      dbName: 'admin-literal-scheme-paths',
      rules: OPEN_RULES,
    });
    const client = getStorageSandbox(sandbox);

    const upperRef = ref(admin, 'gs://UpperBucket/a.txt');
    const trailingSlashRef = ref(admin, 'gs://archive-bucket/');
    const httpsRef = ref(admin, 'https://example.com/a.txt');

    expect(upperRef.fullPath).toBe('gs://UpperBucket/a.txt');
    expect(trailingSlashRef.fullPath).toBe('gs://archive-bucket/');
    expect(httpsRef.fullPath).toBe('https://example.com/a.txt');

    await uploadBytes(upperRef, new TextEncoder().encode('upper'));
    await uploadBytes(trailingSlashRef, new TextEncoder().encode('slash'));
    await uploadBytes(httpsRef, new TextEncoder().encode('https'));

    const decoded = new TextDecoder().decode(new Uint8Array(await getBytes(upperRef)));
    expect(decoded).toBe('upper');

    const rootList = await listAll(ref(admin));
    expect(rootList.prefixes.map((p) => p.fullPath)).toEqual(['gs:', 'https:']);

    const gsLevel1 = await listAll(ref(admin, 'gs:'));
    expect(gsLevel1.prefixes.map((p) => p.fullPath)).toEqual(['gs:/']);

    const gsLevel2 = await listAll(ref(admin, 'gs:/'));
    expect(gsLevel2.prefixes.map((p) => p.fullPath)).toEqual([
      'gs://UpperBucket',
      'gs://archive-bucket',
    ]);

    const archiveLeaf = await listAll(ref(admin, 'gs://archive-bucket'));
    expect(archiveLeaf.items.map((i) => i.fullPath)).toEqual(['gs://archive-bucket/']);

    // Client handles continue to parse gs:// URLs into object paths.
    const clientParsed = ref(client, 'gs://UpperBucket/a.txt');
    expect(clientParsed.fullPath).toBe('a.txt');
    sandbox.dispose();
  });

  it('hides zero-byte <path>/ folder placeholders from client listAll items at parent and folder levels', async () => {
    const sandbox = initializeSandbox();
    const client = getStorageSandbox(sandbox, {
      dbName: 'client-folder-placeholder-hidden',
      rules: OPEN_RULES,
    });
    const admin = getAdminStorageSandbox(sandbox);

    await uploadBytes(ref(client, 'docs/a.txt'), new TextEncoder().encode('a'));
    const folder = ref(client, 'docs/newfolder');
    const placeholderRef: StorageReference = {
      storage: client,
      bucket: folder.bucket,
      fullPath: 'docs/newfolder/',
      name: '',
      parent: folder,
      root: folder.root,
      toString: () => `${folder.toString()}/`,
    };
    await uploadBytes(placeholderRef, new Uint8Array(0));

    const parent = await listAll(ref(client, 'docs'));
    expect(parent.prefixes.map((p) => p.fullPath)).toEqual(['docs/newfolder']);
    expect(parent.items.map((i) => i.fullPath)).toEqual(['docs/a.txt']);

    const insideClient = await listAll(folder);
    expect(insideClient.items).toEqual([]);
    expect(insideClient.prefixes).toEqual([]);

    const insideAdmin = await listAll(ref(admin, 'docs/newfolder'));
    expect(insideAdmin.items).toEqual([]);
    expect(insideAdmin.prefixes).toEqual([]);
    sandbox.dispose();
  });
});
