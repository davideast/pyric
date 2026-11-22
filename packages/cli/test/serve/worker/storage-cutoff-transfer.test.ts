/**
 * Regression suite for #1958 (and served #1961 rules parity): a cut-off Storage
 * transfer on the served worker client rejects with a `StorageError` carrying a
 * `storage/` code (`storage/retry-limit-exceeded`, or `storage/canceled` when
 * aborted), never a raw `TypeError` or unprefixed `unavailable`.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'bun:test';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { FirebaseError } from 'pyric/app';
import { getFirestore } from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import { getStorageSandbox, StorageError } from 'pyric/storage';
import { getStorageService } from 'pyric/storage/internal';
import { _pending, rejectPendingRequests, wirePort } from '../../../src/serve/worker/client/core.js';
import type { ClientPort } from '../../../src/serve/worker/client/handles.js';
import {
  getBlob,
  getBytes,
  getDownloadURL,
  getStorage,
  ref,
  routeUploadOffset,
  sendRouteSlice,
  uploadBytes,
  uploadBytesResumable,
  uploadString,
  type RouteUpload,
} from '../../../src/serve/worker/client/storage.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';
import { OPEN_STORAGE_RULES } from './permissive-services.js';

const CONNECTION_LOST =
  'The hosted sandbox connection was lost. Requests already sent may have completed; check state before retrying.';
const SESSION_TOKEN = 'cutoff-session-token';

const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    server.close();
  }
});

let seq = 0;
function uniqueDbName(): string {
  seq += 1;
  return `pyric-cutoff-${String(seq)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function listenLoopback(server: Server): Promise<string> {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address !== 'object') {
    throw new Error('Expected bound TCP server address');
  }
  return `http://127.0.0.1:${String(address.port)}`;
}

interface HostedHarness {
  readonly ctx: HostCtx;
  readonly port: ClientPort;
  readonly storage: ReturnType<typeof getStorage>;
}

function makeHostedHarness(options: {
  baseUrl?: string;
  rules?: string;
  dropMethod?: string;
}): HostedHarness {
  const sandbox = initializeSandbox();
  getStorageSandbox(sandbox, {
    dbName: uniqueDbName(),
    rules: options.rules ?? OPEN_STORAGE_RULES,
  });
  const ctx: HostCtx = {
    sandbox,
    db: getFirestore(sandbox),
    instanceId: uniqueDbName(),
    subs: new Map(),
    storageByteRoute: options.baseUrl !== undefined,
  };
  const hostPort: PortLike = {
    postMessage(message: unknown) {
      queueMicrotask(() => {
        clientPort.onmessage?.(new MessageEvent('message', { data: message }));
      });
    },
  };
  const clientPort: ClientPort = {
    onmessage: null,
    start() {},
    close() {},
    postMessage(message: unknown) {
      const inbound = message as InboundMessage;
      if (inbound.t === 'op' && inbound.method === options.dropMethod) {
        queueMicrotask(() => {
          rejectPendingRequests(
            clientPort,
            new FirebaseError('unavailable', CONNECTION_LOST),
          );
        });
        return;
      }
      void handleMessage(ctx, hostPort, inbound);
    },
  };
  if (options.baseUrl !== undefined) {
    clientPort.byteRoute = {
      baseUrl: options.baseUrl,
      sessionToken: async () => SESSION_TOKEN,
    };
  }
  wirePort(clientPort);
  const storage = getStorage({ __kind: 'client-db', port: clientPort } as never);
  return { ctx, port: clientPort, storage };
}

function expectRetryLimitStorageError(caught: unknown): void {
  expect(caught).toBeInstanceOf(StorageError);
  expect(caught).not.toBeInstanceOf(TypeError);
  expect((caught as StorageError).code).toBe('storage/retry-limit-exceeded');
}

describe('served worker Storage cut-off transfers (#1958)', () => {
  it('uploadBytes rejects with StorageError(storage/retry-limit-exceeded) when the byte route resets mid-PUT', async () => {
    const baseUrl = await listenLoopback(
      createServer((req) => {
        req.socket.destroy();
      }),
    );
    const { storage } = makeHostedHarness({ baseUrl });

    let caught: unknown;
    try {
      await uploadBytes(ref(storage, 'uploads/cut-off.bin'), new Uint8Array(64 * 1024));
    } catch (error) {
      caught = error;
    }
    expectRetryLimitStorageError(caught);
  });

  it('multi-slice uploadBytes rejects with StorageError(storage/retry-limit-exceeded) when the host dies after the first 4 MiB slice', async () => {
    let putSlices = 0;
    const httpServer = createServer((req, res) => {
      putSlices += 1;
      if (putSlices >= 2) {
        req.socket.destroy();
        return;
      }
      req.resume();
      req.on('end', () => {
        res.writeHead(308, { range: 'bytes=0-4194303' }).end();
      });
    });
    const baseUrl = await listenLoopback(httpServer);
    const { storage } = makeHostedHarness({ baseUrl });

    const fiveMiB = new Uint8Array(5 * 1024 * 1024);
    let caught: unknown;
    try {
      await uploadBytes(ref(storage, 'uploads/five-mib.bin'), fiveMiB);
    } catch (error) {
      caught = error;
    }
    expect(putSlices).toBeGreaterThanOrEqual(2);
    expectRetryLimitStorageError(caught);
  });

  it('uploadBytesResumable and routeUploadOffset map network cut-offs to StorageError(storage/retry-limit-exceeded) and aborts to StorageError(storage/canceled)', async () => {
    const baseUrl = await listenLoopback(
      createServer((req) => {
        req.socket.destroy();
      }),
    );
    const { storage } = makeHostedHarness({ baseUrl });
    const targetRef = ref(storage, 'uploads/resumable-cutoff.bin');

    let observerError: unknown;
    const task = uploadBytesResumable(targetRef, new Uint8Array(1024));
    task.on('state_changed', undefined, (err) => {
      observerError = err;
    });

    let taskError: unknown;
    try {
      await task;
    } catch (error) {
      taskError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expectRetryLimitStorageError(taskError);
    expectRetryLimitStorageError(observerError);

    const syntheticUpload: RouteUpload = {
      uploadId: 'u-1',
      url: `${baseUrl}/__pyric/storage/v0/b/pyric-default/o?name=a.bin&upload_id=u-1&upload_token=t`,
      size: 16,
      reference: targetRef,
    };
    let offsetCaught: unknown;
    try {
      await routeUploadOffset(syntheticUpload);
    } catch (error) {
      offsetCaught = error;
    }
    expectRetryLimitStorageError(offsetCaught);

    const abortedController = new AbortController();
    abortedController.abort();
    let abortedSliceCaught: unknown;
    try {
      await sendRouteSlice(syntheticUpload, new Blob([new Uint8Array(16)]), 0, abortedController.signal);
    } catch (error) {
      abortedSliceCaught = error;
    }
    expect(abortedSliceCaught).toBeInstanceOf(StorageError);
    expect((abortedSliceCaught as StorageError).code).toBe('storage/canceled');
  });

  it('getBytes and getBlob reject with StorageError(storage/retry-limit-exceeded) when GET fails before headers or mid-body', async () => {
    let mode: 'reset-before-headers' | 'truncate-body' = 'reset-before-headers';
    const baseUrl = await listenLoopback(
      createServer((req, res) => {
        if (mode === 'reset-before-headers') {
          req.socket.destroy();
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': '65536',
        });
        res.write(Buffer.alloc(1024, 0x41));
        setTimeout(() => {
          req.socket.destroy();
        }, 5);
      }),
    );

    const { ctx, storage } = makeHostedHarness({ baseUrl });
    const handle = getStorageSandbox(ctx.sandbox);
    const service = await getStorageService(handle);
    await service.backend.put(
      'downloads/item.bin',
      new Blob([new Uint8Array(65536)], { type: 'application/octet-stream' }),
      {
        bucket: 'pyric-default',
        fullPath: 'downloads/item.bin',
        name: 'item.bin',
        size: 65536,
        generation: '1',
        metageneration: '1',
        timeCreated: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        contentType: 'application/octet-stream',
      },
    );

    let resetCaught: unknown;
    try {
      await getBytes(ref(storage, 'downloads/item.bin'));
    } catch (error) {
      resetCaught = error;
    }
    expectRetryLimitStorageError(resetCaught);

    mode = 'truncate-body';
    let midBodyCaught: unknown;
    try {
      await getBlob(ref(storage, 'downloads/item.bin'));
    } catch (error) {
      midBodyCaught = error;
    }
    expectRetryLimitStorageError(midBodyCaught);
  });

  it('maps in-flight RPC socket drops during beginUpload, finishUpload, getDownloadURL, and frame transfers to StorageError(storage/retry-limit-exceeded)', async () => {
    const baseUrl = await listenLoopback(
      createServer((_req, res) => {
        res.writeHead(200).end();
      }),
    );

    for (const dropMethod of ['storage.beginUpload', 'storage.finishUpload']) {
      const { storage } = makeHostedHarness({ baseUrl, dropMethod });
      let caught: unknown;
      try {
        await uploadBytes(ref(storage, 'uploads/rpc-drop.bin'), new Uint8Array([1, 2, 3]));
      } catch (error) {
        caught = error;
      }
      expectRetryLimitStorageError(caught);
    }

    const downloadDrop = makeHostedHarness({ baseUrl, dropMethod: 'storage.getDownloadURL' });
    let urlCaught: unknown;
    try {
      await getDownloadURL(ref(downloadDrop.storage, 'uploads/rpc-drop.bin'));
    } catch (error) {
      urlCaught = error;
    }
    expectRetryLimitStorageError(urlCaught);

    const frameDrop = makeHostedHarness({ dropMethod: 'storage.putBytes' });
    let frameCaught: unknown;
    try {
      await uploadBytes(ref(frameDrop.storage, 'uploads/frame-drop.bin'), new Uint8Array([4, 5]));
    } catch (error) {
      frameCaught = error;
    }
    expectRetryLimitStorageError(frameCaught);
    const remainingForPort = [..._pending.values()].filter(
      (entry) => entry.port === frameDrop.port,
    );
    expect(remainingForPort).toHaveLength(0);
  });

  it('stores application/octet-stream and satisfies octet-stream rules on untyped served uploadString (#1961)', async () => {
    const strictOctetRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /raw/{file} {
      allow create: if request.resource.contentType == 'application/octet-stream';
      allow read: if resource.contentType == 'application/octet-stream';
    }
  }
}`;
    const { storage } = makeHostedHarness({ rules: strictOctetRules });
    const targetRef = ref(storage, 'raw/untyped.bin');
    const uploaded = await uploadString(targetRef, 'x');
    expect(uploaded.metadata.contentType).toBe('application/octet-stream');
    const bytes = new Uint8Array(await getBytes(targetRef));
    expect(new TextDecoder().decode(bytes)).toBe('x');
  });
});
