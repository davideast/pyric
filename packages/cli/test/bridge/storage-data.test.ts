/**
 * `storage_data` end to end through the real dispatcher: upload, metadata
 * (get + update), list, download and delete round-trip, plus the two error
 * paths the tool composes for itself — the 1 MiB upload cap and rules
 * enforcement for a non-admin `as`.
 */
import { describe, it, expect } from 'bun:test';
import { buildSandboxDispatcher } from '../../src/bridge/client/dispatch.js';
import { initializeSandbox } from 'pyric/sandbox';
import { getStorageSandbox } from 'pyric/storage';

const RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /public/{allPaths=**} {
      allow read, write: if true;
    }
    match /users/{uid}/{allPaths=**} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && request.auth.uid == uid;
    }
  }
}`;

function freshDispatcher() {
  const sandbox = initializeSandbox();
  // Rules are honored only on the FIRST storage call per Sandbox; prime them
  // before the dispatcher's admin/user resolvers open the service.
  getStorageSandbox(sandbox, { rules: RULES });
  return buildSandboxDispatcher(sandbox);
}

describe('storage_data', () => {
  it('round-trips upload, metadata, list, download and delete as admin', async () => {
    const dispatch = freshDispatcher();

    const uploaded = await dispatch('storage_data', 'upload', {
      path: 'public/hello.txt',
      text: 'hello world',
    });
    expect(uploaded.ok).toBe(true);
    const uploadedData = uploaded.data as { path: string; metadata: { contentType: string } };
    expect(uploadedData.path).toBe('public/hello.txt');
    expect(uploadedData.metadata.contentType).toBe('text/plain;charset=utf-8');

    const gotMetadata = await dispatch('storage_data', 'metadata', { path: 'public/hello.txt' });
    expect(gotMetadata.ok).toBe(true);
    expect((gotMetadata.data as { metadata: { size: number } }).metadata.size).toBe(11);

    const updatedMetadata = await dispatch('storage_data', 'metadata', {
      path: 'public/hello.txt',
      set: { customMetadata: { owner: 'alice' } },
    });
    expect(updatedMetadata.ok).toBe(true);
    expect(
      (updatedMetadata.data as { metadata: { customMetadata?: Record<string, string> } }).metadata
        .customMetadata,
    ).toEqual({ owner: 'alice' });

    const listed = await dispatch('storage_data', 'list', { prefix: 'public' });
    expect(listed.ok).toBe(true);
    expect((listed.data as { items: Array<{ path: string }> }).items.map((item) => item.path)).toEqual([
      'public/hello.txt',
    ]);

    const downloaded = await dispatch('storage_data', 'download', { path: 'public/hello.txt' });
    expect(downloaded.ok).toBe(true);
    const preview = (downloaded.data as { preview: { encoding: string; content: string; truncated: boolean } })
      .preview;
    expect(preview.encoding).toBe('text');
    expect(preview.content).toBe('hello world');
    expect(preview.truncated).toBe(false);

    const deleted = await dispatch('storage_data', 'delete', { path: 'public/hello.txt' });
    expect(deleted.ok).toBe(true);

    await expect(dispatch('storage_data', 'metadata', { path: 'public/hello.txt' })).rejects.toThrow(
      /object-not-found/,
    );
  });

  it('returns a structured error above the 1 MiB upload cap instead of writing', async () => {
    const dispatch = freshDispatcher();
    const oversized = 'x'.repeat(1024 * 1024 + 1);

    const result = await dispatch('storage_data', 'upload', {
      path: 'public/too-big.bin',
      text: oversized,
    });

    expect(result.ok).toBe(false);
    expect(result.data).toEqual({
      code: 'size_exceeded',
      maxBytes: 1024 * 1024,
      actualBytes: oversized.length,
    });

    // Nothing was written: reading it back as admin fails to find an object.
    await expect(dispatch('storage_data', 'metadata', { path: 'public/too-big.bin' })).rejects.toThrow(
      /object-not-found/,
    );
  });

  it('enforces rules for a non-admin `as`: a mismatched uid is denied, the owner is allowed', async () => {
    const dispatch = freshDispatcher();

    await expect(
      dispatch('storage_data', 'upload', {
        path: 'users/alice/secret.txt',
        text: 'nope',
        as: { uid: 'bob' },
      }),
    ).rejects.toThrow(/unauthorized/);

    const allowed = await dispatch('storage_data', 'upload', {
      path: 'users/alice/secret.txt',
      text: 'mine',
      as: { uid: 'alice' },
    });
    expect(allowed.ok).toBe(true);
  });
});
