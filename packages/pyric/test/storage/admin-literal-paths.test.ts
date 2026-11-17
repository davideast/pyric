/**
 * Admin-plane literal scheme-prefixed object path preservation (`ref` + `listAll`),
 * keeping client `ref(storage, url)` URL parsing intact.
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
} from '../../src/storage/index.js';
import { getAdminStorageSandbox } from '../../src/storage/internal.js';

describe('admin storage literal scheme-prefixed object paths', () => {
  it('preserves literal gs:// and https:// object names on admin handles while parsing URLs on client handles', async () => {
    const sandbox = initializeSandbox();
    const admin = getAdminStorageSandbox(sandbox, { dbName: 'admin-literal-scheme-paths' });
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
});
