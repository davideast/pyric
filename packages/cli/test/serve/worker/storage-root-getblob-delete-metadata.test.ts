/**
 * Served-entry + SharedWorker conformance for:
 *   - storage#61 (`client-storage-getblob-root-ref`): `getBlob(ref(storage))`
 *     throws `storage/invalid-root-operation` synchronously with zero worker RPCs.
 *   - storage#67 (`storage-delete-then-getmetadata-throws`): `uploadBytes` with
 *     `customMetadata` -> `getMetadata` -> `deleteObject` -> `getMetadata`
 *     throws `storage/object-not-found`.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { deleteApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { handleMessage, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import { type FakePort, makeHostCtx, portPair } from './integration-support.js';

function loadBehavior(name: string): Record<string, unknown> {
  const fileUrl = new URL(
    `../../../../conformance/observations/storage/${name}.json`,
    import.meta.url,
  );
  const parsed = JSON.parse(readFileSync(fileUrl, 'utf8')) as {
    behavior: Record<string, unknown>;
  };
  return parsed.behavior;
}

let appSeq = 0;

describe('served entry + SharedWorker parity (storage#61 and storage#67)', () => {
  let restoreSharedWorker: () => void = () => {};

  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSharedWorker = () => {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = previous;
    };
  });

  afterEach(() => {
    restoreSharedWorker();
  });

  async function setupServedStorage() {
    const ctx = await makeHostCtx();
    let storageOpMessages = 0;

    (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
      port: FakePort;
      addEventListener() {}
      constructor(_url: unknown, _opts: unknown) {
        const { a: clientPort, b: hostPort } = portPair();
        const hostPortLike: PortLike = {
          postMessage: (message: OutboundMessage) => hostPort.postMessage(message),
        };
        hostPort.onmessage = (event) => {
          const inbound = event.data as InboundMessage;
          if (inbound.t === 'op' && inbound.method.startsWith('storage.')) {
            storageOpMessages += 1;
          }
          void handleMessage(ctx, hostPortLike, inbound);
        };
        this.port = clientPort;
      }
    };

    const served = await import('../../../src/serve/entries/storage.js');
    const app = createAppForSandbox(
      ctx.sandbox,
      { projectId: 'demo-storage', storageBucket: 'buckets-default' },
      `served-s61-s67-${++appSeq}`,
    );
    const storage = served.getStorage(app);

    return {
      served,
      storage,
      getStorageOpCount: () => storageOpMessages,
      cleanup: async () => {
        await deleteApp(app);
        ctx.sandbox.dispose();
      },
    };
  }

  test('storage#61: getBlob(ref(storage)) throws storage/invalid-root-operation synchronously with zero storage RPCs', async () => {
    const obs = loadBehavior('client-storage-getblob-root-ref');
    const browserRoot = obs.browserRootRef as {
      rootFullPath: string;
      rootName: string;
      threwSynchronously: boolean;
      code: string;
      fetchCalls: number;
    };

    const session = await setupServedStorage();
    try {
      const rootRef = session.served.ref(session.storage);
      expect(rootRef.fullPath).toBe(browserRoot.rootFullPath);
      expect(rootRef.name).toBe(browserRoot.rootName);

      const opsBeforeRootCall = session.getStorageOpCount();
      let threwSynchronously = false;
      let caughtCode: string | null = null;
      try {
        session.served.getBlob(rootRef).catch(() => {});
      } catch (err) {
        threwSynchronously = true;
        caughtCode = (err as { code?: string }).code ?? null;
      }
      expect(threwSynchronously).toBe(browserRoot.threwSynchronously);
      expect(caughtCode).toBe(browserRoot.code);
      expect(session.getStorageOpCount() - opsBeforeRootCall).toBe(browserRoot.fetchCalls);

      await expect(
        session.served.getBlob(session.served.ref(session.storage, 'items/missing.bin')),
      ).rejects.toMatchObject({
        code: 'storage/object-not-found',
      });

      const itemRef = session.served.ref(session.storage, 'items/present.bin');
      await session.served.uploadBytes(itemRef, new Uint8Array([0x61, 0x62, 0x63]), {
        contentType: 'image/png',
      });
      const readBlob = await session.served.getBlob(itemRef, 2);
      expect(readBlob.type).toBe('image/png');
      expect(new Uint8Array(await readBlob.arrayBuffer())).toEqual(new Uint8Array([0x61, 0x62]));
    } finally {
      await session.cleanup();
    }
  });

  test('storage#67: uploadBytes -> getMetadata -> deleteObject -> getMetadata throws storage/object-not-found', async () => {
    const obs = loadBehavior('storage-delete-then-getmetadata-throws');
    const beforeDelete = obs.beforeDelete as {
      size: number;
      contentType: string;
      customMetadata: Record<string, string>;
      hasGeneration: boolean;
      metageneration: string;
    };
    const afterDelete = obs.afterDeleteGetMetadata as {
      threw: boolean;
      code: string;
    };

    const session = await setupServedStorage();
    try {
      const itemRef = session.served.ref(session.storage, 'items/ephemeral.bin');
      const payload = new Uint8Array([0x70, 0x79, 0x72, 0x69, 0x63]);
      await session.served.uploadBytes(itemRef, payload, {
        contentType: beforeDelete.contentType,
        customMetadata: beforeDelete.customMetadata,
      });

      const preMeta = await session.served.getMetadata(itemRef);
      expect(preMeta.size).toBe(beforeDelete.size);
      expect(preMeta.contentType).toBe(beforeDelete.contentType);
      expect(preMeta.customMetadata).toEqual(beforeDelete.customMetadata);
      expect(preMeta.generation.length > 0).toBe(beforeDelete.hasGeneration);
      expect(preMeta.metageneration).toBe(beforeDelete.metageneration);

      await session.served.deleteObject(itemRef);
      expect(obs.deleteCompleted).toBe(true);

      let threw = false;
      let code: string | null = null;
      try {
        await session.served.getMetadata(itemRef);
      } catch (err) {
        threw = true;
        code = (err as { code?: string }).code ?? null;
      }
      expect(threw).toBe(afterDelete.threw);
      expect(code).toBe(afterDelete.code);
    } finally {
      await session.cleanup();
    }
  });
});
