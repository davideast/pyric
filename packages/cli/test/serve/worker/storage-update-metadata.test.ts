import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getStorageSandbox } from 'pyric/storage';
import { bytesToBase64 } from '../../../src/serve/worker/protocol.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage, ResMessage } from '../../../src/serve/worker/protocol.js';

let sequence = 0;

function makeCtx(rules: string): HostCtx {
  const sandbox = initializeSandbox();
  getStorageSandbox(sandbox, { dbName: `pyric-storage-update-metadata-${++sequence}`, rules });
  return { db: getFirestore(sandbox), sandbox, instanceId: 'storage-update-metadata-test', subs: new Map() };
}

function op(ctx: HostCtx, payload: Record<string, unknown>): Promise<ResMessage> {
  return new Promise((resolve) => {
    const port: PortLike = {
      postMessage(message: OutboundMessage) {
        if (message.t === 'res') resolve(message);
      },
    };
    void handleMessage(ctx, port, { ...payload, t: 'op', id: `update-metadata-${++sequence}` } as InboundMessage);
  });
}

const ADMIN = { mode: 'admin' } as const;
const ALICE = { mode: 'as', uid: 'alice-uid' } as const;
const BOB = { mode: 'as', uid: 'bob-uid' } as const;

describe('storage.updateMetadata', () => {
  it('evaluates allow update rules rather than allow create rules', async () => {
    const rules = [
      'rules_version = "2";',
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /create-only/{allPaths=**} {',
      '      allow create: if true;',
      '      allow update: if false;',
      '    }',
      '    match /update-only/{allPaths=**} {',
      '      allow read, create, delete: if false;',
      '      allow update: if request.auth != null && request.auth.uid == "alice-uid";',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const ctx = makeCtx(rules);

    await op(ctx, {
      method: 'storage.putBytes',
      path: 'create-only/file.txt',
      dataB64: bytesToBase64(new Uint8Array([1, 2, 3])),
      actAs: ADMIN,
    });
    await op(ctx, {
      method: 'storage.putBytes',
      path: 'update-only/file.txt',
      dataB64: bytesToBase64(new Uint8Array([4, 5, 6])),
      metadata: {
        contentType: 'text/plain',
        cacheControl: 'public, max-age=60',
        metadata: { keep: 'yes', drop: 'soon' },
      },
      actAs: ADMIN,
    });

    // allow create: true / allow update: false must reject client updateMetadata.
    const deniedCreateOnly = await op(ctx, {
      method: 'storage.updateMetadata',
      path: 'create-only/file.txt',
      actAs: ALICE,
      patch: { settable: { contentType: 'text/markdown' } },
    });
    expect(deniedCreateOnly.ok).toBe(false);
    expect((deniedCreateOnly as { error: { code: string } }).error.code).toBe('storage/unauthorized');

    // allow read/create: false / allow update: alice-uid allows Alice without needing read or create permission.
    const allowedAlice = await op(ctx, {
      method: 'storage.updateMetadata',
      path: 'update-only/file.txt',
      actAs: ALICE,
      replaceCustomMetadata: true,
      patch: {
        settable: { contentLanguage: 'fr' },
        customMetadata: { keep: 'yes', stage: '2' },
      },
    });
    expect(allowedAlice.ok).toBe(true);
    const meta1 = (allowedAlice as { value: Record<string, unknown> }).value;
    expect(meta1.metageneration).toBe('2');
    expect(meta1.cacheControl).toBe('public, max-age=60');
    expect(meta1.contentLanguage).toBe('fr');
    expect(meta1.customMetadata).toEqual({ keep: 'yes', stage: '2' });

    // Empty customMetadata map with replaceCustomMetadata: true clears all keys.
    const clearedAlice = await op(ctx, {
      method: 'storage.updateMetadata',
      path: 'update-only/file.txt',
      actAs: ALICE,
      replaceCustomMetadata: true,
      patch: {
        settable: { cacheControl: null },
        customMetadata: {},
      },
    });
    expect(clearedAlice.ok).toBe(true);
    const meta2 = (clearedAlice as { value: Record<string, unknown> }).value;
    expect(meta2.metageneration).toBe('3');
    expect(meta2.cacheControl).toBeUndefined();
    expect(meta2.customMetadata).toBeUndefined();

    // Bob is denied by allow update rule.
    const deniedBob = await op(ctx, {
      method: 'storage.updateMetadata',
      path: 'update-only/file.txt',
      actAs: BOB,
      patch: { settable: { contentType: 'text/csv' } },
    });
    expect(deniedBob.ok).toBe(false);
    expect((deniedBob as { error: { code: string } }).error.code).toBe('storage/unauthorized');
  });

  it('rejects downloadTokens patches on the client plane even on admin lens', async () => {
    const rules = [
      'rules_version = "2";',
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /{allPaths=**} { allow read, write: if true; }',
      '  }',
      '}',
    ].join('\n');
    const ctx = makeCtx(rules);
    await op(ctx, {
      method: 'storage.putBytes',
      path: 'media/clip.wav',
      dataB64: bytesToBase64(new Uint8Array([9])),
      actAs: ADMIN,
    });
    const refused = await op(ctx, {
      method: 'storage.updateMetadata',
      path: 'media/clip.wav',
      actAs: ALICE,
      patch: { downloadTokens: 'forged-token' },
    });
    expect(refused.ok).toBe(false);
    expect((refused as { error: { code: string } }).error.code).toBe('storage/unauthorized');
  });
});
