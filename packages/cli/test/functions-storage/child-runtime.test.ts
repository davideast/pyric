import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REMOTE_SANDBOX_FACTORY } from 'pyric/sandbox';
import { buildChildEnv, registerModuleUrl } from '../../src/cli/sandbox-runner.js';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import { type FunctionsChildEvent } from '../../src/functions/child-protocol.js';
import {
  spawnFunctionsChild,
  type FunctionsChildHandle,
} from '../../src/functions/spawn.js';
import {
  defaultStorageBucketFromEnv,
  serveBucketAsDefault,
} from '../../src/functions/storage/child-runtime.js';
import { computeCrc32cBase64, computeMd5Base64 } from '../../src/functions/storage/event.js';
import {
  connectRemoteSandbox,
  createRemoteSandboxHandle,
  type RemoteSandbox,
} from '../../src/remote/index.js';
import { silentServeLogger } from '../../src/serve/server.js';
import {
  connectFunctionsWorkerPeer,
  createFunctionsWorkerHostCtx,
} from '../functions-rtdb/worker-peer.js';
import { trackTempDirs } from '../use-temp-dirs.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const childModule = join(cliRoot, 'dist/functions/child.js');

async function waitForRtdbValue<T>(
  sandbox: RemoteSandbox,
  path: string,
): Promise<T> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const current = (await sandbox.rtdb.get(path)) as T | null;
    if (current !== null && current !== undefined) return current;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
  }
  throw new Error(`timed out waiting for RTDB receipt at ${path}`);
}

async function waitForChildEvents(
  events: readonly FunctionsChildEvent[],
  expectedCount: number,
): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (events.length < expectedCount && Date.now() < deadline) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
  }
}

describe('Storage child-runtime helpers', () => {
  test('defaultStorageBucketFromEnv resolves FIREBASE_CONFIG.storageBucket and falls back to projectId', () => {
    expect(
      defaultStorageBucketFromEnv({
        FIREBASE_CONFIG: JSON.stringify({
          projectId: 'alpha-proj',
          storageBucket: 'custom-default-bucket',
        }),
      }),
    ).toBe('custom-default-bucket');

    expect(
      defaultStorageBucketFromEnv({
        FIREBASE_CONFIG: JSON.stringify({ projectId: 'alpha-proj' }),
      }),
    ).toBe('alpha-proj.appspot.com');

    expect(
      defaultStorageBucketFromEnv({ GCLOUD_PROJECT: 'beta-proj' }),
    ).toBe('beta-proj.appspot.com');

    expect(
      defaultStorageBucketFromEnv({ GCLOUD_PROJECT: '', GOOGLE_CLOUD_PROJECT: 'gamma-proj' }),
    ).toBe('gamma-proj.appspot.com');
  });

  test('serveBucketAsDefault aliases default-bucket ops and byte-route URLs onto pyric-default', async () => {
    const globalRecord = globalThis as Record<symbol, unknown>;
    const previousFactory = globalRecord[REMOTE_SANDBOX_FACTORY];
    const seenOps: Array<Record<string, unknown>> = [];
    const seenUrls: string[] = [];

    globalRecord[REMOTE_SANDBOX_FACTORY] = () =>
      createRemoteSandboxHandle({
        serveUrl: 'http://127.0.0.1:4400',
        close() {},
        channel: {
          async op(payload) {
            seenOps.push(payload as Record<string, unknown>);
            return { ok: true };
          },
          subscribe() {
            return () => undefined;
          },
          async byteRoute() {
            return {
              baseUrl: 'http://127.0.0.1:4400',
              sessionToken: async () => 'tok',
              fetch: async (input) => {
                const href = typeof input === 'string' ? input : input.href;
                seenUrls.push(href);
                return new Response('ok', { status: 200 });
              },
            };
          },
        },
      });

    try {
      serveBucketAsDefault('demo-project.appspot.com');
      const wrappedFactory = globalRecord[REMOTE_SANDBOX_FACTORY] as () => RemoteSandbox;
      const handle = wrappedFactory();

      await handle.channel.op({
        method: 'storage.getMetadata',
        path: 'a/b.txt',
        bucket: 'demo-project.appspot.com',
        defaultBucket: 'demo-project.appspot.com',
      });
      await handle.channel.op({
        method: 'storage.getMetadata',
        path: 'a/b.txt',
        bucket: 'other-bucket',
        defaultBucket: 'demo-project.appspot.com',
      });

      const route = await handle.channel.byteRoute?.();
      if (route?.fetch === undefined) {
        throw new Error('expected wrapped byteRoute fetch');
      }
      await route.fetch(
        'http://127.0.0.1:4400/__pyric/storage/v0/b/demo-project.appspot.com/o/a%2Fb.txt?alt=media',
      );
      await route.fetch(
        new URL(
          'http://127.0.0.1:4400/__pyric/storage/v0/b/demo-project.appspot.com/o/c.txt?alt=media',
        ),
      );

      expect(seenOps).toEqual([
        { method: 'storage.getMetadata', path: 'a/b.txt' },
        { method: 'storage.getMetadata', path: 'a/b.txt', bucket: 'other-bucket' },
      ]);
      expect(seenUrls).toEqual([
        'http://127.0.0.1:4400/__pyric/storage/v0/b/pyric-default/o/a%2Fb.txt?alt=media',
        'http://127.0.0.1:4400/__pyric/storage/v0/b/pyric-default/o/c.txt?alt=media',
      ]);
    } finally {
      if (previousFactory === undefined) {
        delete globalRecord[REMOTE_SANDBOX_FACTORY];
      } else {
        globalRecord[REMOTE_SANDBOX_FACTORY] = previousFactory;
      }
    }
  });
});

describe('isolated Functions Storage child over worker-peer frame and chunked putPart+finishUpload', () => {
  const tempDirs = trackTempDirs('pyric-fn-storage-peer-');
  let fixtureDir = '';
  let runtime: ServeRuntime | undefined;
  let peer: { close(): Promise<void> } | undefined;
  let observer: RemoteSandbox | undefined;
  let child: FunctionsChildHandle | undefined;

  beforeAll(async () => {
    if (!existsSync(childModule)) {
      throw new Error(`Functions child is not built: ${childModule}`);
    }
    fixtureDir = tempDirs.makeTempDir();
    mkdirSync(join(fixtureDir, 'public'), { recursive: true });
    mkdirSync(join(fixtureDir, 'functions/node_modules'), { recursive: true });
    writeFileSync(join(fixtureDir, 'public/index.html'), '<!doctype html><body>peer</body>');
    writeFileSync(
      join(fixtureDir, 'firebase.json'),
      JSON.stringify({ hosting: { public: 'public' } }),
    );
    writeFileSync(
      join(fixtureDir, 'functions/package.json'),
      JSON.stringify({ name: 'storage-peer-fn', private: true, type: 'commonjs' }),
    );
    writeFileSync(
      join(fixtureDir, 'functions/index.js'),
      [
        "const { initializeApp, getApps } = require('firebase-admin/app');",
        "const { getDatabase } = require('firebase-admin/database');",
        "const { getStorage } = require('firebase-admin/storage');",
        "const { onObjectFinalized } = require('firebase-functions/v2/storage');",
        'if (getApps().length === 0) initializeApp();',
        'exports.onChunkedFinalized = onObjectFinalized(async (event) => {',
        '  const [downloaded] = await getStorage()',
        '    .bucket(event.data.bucket)',
        '    .file(event.data.name)',
        '    .download();',
        "  const slug = event.data.name.replace(/[^a-zA-Z0-9_-]/g, '_');",
        "  await getDatabase().ref('peerReceipts/' + slug).set({",
        '    name: event.data.name,',
        '    bucket: event.bucket,',
        '    size: event.data.size,',
        '    crc32c: event.data.crc32c,',
        '    md5Hash: event.data.md5Hash,',
        "    text: downloaded.toString('utf8'),",
        '  });',
        '});',
      ].join('\n'),
    );
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(fixtureDir, 'functions/node_modules/firebase-functions'),
    );

    runtime = await startServe({
      cwd: fixtureDir,
      port: 0,
      bridge: true,
      capture: false,
      disableAuditLog: true,
      cacheRoot: join(fixtureDir, '.cache'),
      logger: silentServeLogger(),
    });
    const ctx = await createFunctionsWorkerHostCtx({
      persistenceKeyPrefix: 'functions-storage-peer',
      instanceId: 'functions-storage-peer-instance',
    });
    peer = await connectFunctionsWorkerPeer({
      url: `ws://127.0.0.1:${runtime.handle.port}/__pyric/sandbox`,
      ctx,
      sandboxId: 'functions-storage-peer-sb',
    });
    observer = await connectRemoteSandbox({ url: runtime.handle.url });
  });

  afterAll(async () => {
    if (child) await child.stop();
    observer?.close();
    if (peer) await peer.close();
    if (runtime) await runtime.handle.stop();
    tempDirs.cleanupTempDirs();
  });

  test('emits zero finalized triggers during beginUpload/putPart and fires once on finishUpload with full bytes', async () => {
    if (!runtime || !observer) throw new Error('peer runtime not initialized');
    const events: FunctionsChildEvent[] = [];
    child = spawnFunctionsChild({
      cwd: join(fixtureDir, 'functions'),
      entry: join(fixtureDir, 'functions/index.js'),
      childModuleUrl: pathToFileURL(childModule),
      env: buildChildEnv(process.env, {
        serveUrl: runtime.handle.url,
        registerUrl: registerModuleUrl(),
      }),
      instance: 'demo-project-default-rtdb',
      projectId: 'demo-project',
      location: 'us-central1',
      onEvent: (event) => events.push(event),
    });
    expect((await child.ready).triggerCount).toBe(1);

    const part0 = Buffer.from('chunk-part-zero::', 'utf8');
    const part1 = Buffer.from('chunk-part-one-complete', 'utf8');
    const combined = Buffer.concat([part0, part1]);

    const begun = (await observer.channel.op({
      method: 'storage.beginUpload',
      path: 'chunks/nested/assembled.txt',
      size: combined.byteLength,
      contentType: 'text/plain',
      actAs: { mode: 'admin' },
    })) as { uploadId: string };

    await observer.channel.op({
      method: 'storage.putPart',
      uploadId: begun.uploadId,
      partIndex: 0,
      dataB64: part0.toString('base64'),
      actAs: { mode: 'admin' },
    });
    await observer.channel.op({
      method: 'storage.putPart',
      uploadId: begun.uploadId,
      partIndex: 1,
      dataB64: part1.toString('base64'),
      actAs: { mode: 'admin' },
    });

    await new Promise((resolveSleep) => setTimeout(resolveSleep, 80));
    expect(events).toHaveLength(0);
    expect(await observer.rtdb.get('peerReceipts/chunks_nested_assembled_txt')).toBeNull();

    await observer.channel.op({
      method: 'storage.finishUpload',
      uploadId: begun.uploadId,
      actAs: { mode: 'admin' },
    });

    await waitForChildEvents(events, 1);
    const receipt = await waitForRtdbValue<{
      name: string;
      bucket: string;
      size: string;
      crc32c: string;
      md5Hash: string;
      text: string;
    }>(observer, 'peerReceipts/chunks_nested_assembled_txt');

    expect(receipt).toEqual({
      name: 'chunks/nested/assembled.txt',
      bucket: 'demo-project.appspot.com',
      size: String(combined.byteLength),
      crc32c: computeCrc32cBase64(combined),
      md5Hash: computeMd5Base64(combined),
      text: combined.toString('utf8'),
    });

    expect(await child.stop()).toBe(0);
    child = undefined;
  }, 20_000);
});
