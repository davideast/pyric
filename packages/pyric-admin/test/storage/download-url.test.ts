/**
 * Characterization unit tests for `getDownloadURL` mirror in `pyric-admin/storage`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { initializeSandbox, type Sandbox } from 'pyric/sandbox';
import { deleteApp, initializeApp } from '../../src/app/index.js';
import { getDownloadURL, getStorage } from '../../src/storage/index.js';

let sandbox: Sandbox;

beforeEach(() => {
  sandbox = initializeSandbox();
});

afterEach(async () => {
  try {
    await deleteApp(initializeApp({ sandbox }, 'test-storage-cleanup'));
  } catch {}
});

describe('getDownloadURL', () => {
  it('returns a deterministic sandbox storage url', async () => {
    const app = initializeApp({ sandbox }, 'test-storage');
    const storage = getStorage(app);
    const bucket = storage.bucket();
    const file = bucket.file('images/avatar.jpg');
    await file.save('demo bytes', { contentType: 'image/jpeg' });

    const url = await getDownloadURL(file);
    expect(url).toContain('pyric-sandbox-storage://pyric-default/images/avatar.jpg?expires=');
  });
});
