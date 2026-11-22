import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildChildEnv, registerModuleUrl } from '../../src/cli/sandbox-runner.js';
import { type FunctionsChildEvent } from '../../src/functions/child-protocol.js';
import {
  spawnFunctionsChild,
  type FunctionsChildHandle,
} from '../../src/functions/spawn.js';
import { computeCrc32cBase64, computeMd5Base64 } from '../../src/functions/storage/event.js';
import {
  connectRemoteSandbox,
  type RemoteSandbox,
} from '../../src/remote/index.js';
import {
  getStorage as getClientStorage,
  ref as clientRef,
  uploadBytes as clientUploadBytes,
  uploadString as clientUploadString,
} from '../../src/serve/worker/client/storage.js';
import { trackTempDirs } from '../use-temp-dirs.js';
import {
  childModule,
  createChannelClientPort,
  repoRoot,
  startNodeHostedRuntime,
  waitForRtdbValue,
  type HostedNodeServer,
  type TriggerReceipt,
} from './hosted-harness.js';

describe('isolated Functions Storage child against live HostedRuntime', () => {
  const tempDirs = trackTempDirs('pyric-fn-storage-hosted-');
  let fixtureDir = '';
  let hosted: HostedNodeServer | undefined;
  let observer: RemoteSandbox | undefined;
  let activeChild: FunctionsChildHandle | undefined;

  beforeAll(async () => {
    if (!existsSync(childModule)) {
      throw new Error(`Functions child is not built: ${childModule}`);
    }
    fixtureDir = tempDirs.makeTempDir();
    mkdirSync(join(fixtureDir, 'public'), { recursive: true });
    mkdirSync(join(fixtureDir, 'functions/node_modules'), { recursive: true });
    mkdirSync(join(fixtureDir, 'functions-esm/node_modules'), { recursive: true });
    writeFileSync(join(fixtureDir, 'public/index.html'), '<!doctype html><body>hosted</body>');
    writeFileSync(
      join(fixtureDir, 'firebase.json'),
      JSON.stringify({ hosting: { public: 'public' } }),
    );

    writeFileSync(
      join(fixtureDir, 'functions/package.json'),
      JSON.stringify({ name: 'storage-fn-cjs', private: true, type: 'commonjs' }),
    );
    writeFileSync(
      join(fixtureDir, 'functions/index.js'),
      [
        "const { initializeApp, getApps } = require('firebase-admin/app');",
        "const { getDatabase } = require('firebase-admin/database');",
        "const { getStorage } = require('firebase-admin/storage');",
        "const { onValueCreated } = require('firebase-functions/v2/database');",
        "const { onObjectFinalized, onObjectDeleted } = require('firebase-functions/v2/storage');",
        '',
        'function ensureAdmin() {',
        '  if (getApps().length === 0) initializeApp();',
        '}',
        '',
        'function receiptKey(name) {',
        "  return name.replace(/[^a-zA-Z0-9_-]/g, '_');",
        '}',
        '',
        'exports.onDefaultFinalized = onObjectFinalized(async (event) => {',
        '  ensureAdmin();',
        "  if (event.data.name.startsWith('derived/')) return;",
        '  const [downloaded] = await getStorage()',
        '    .bucket(event.data.bucket)',
        '    .file(event.data.name)',
        '    .download();',
        '  await getStorage()',
        '    .bucket(event.data.bucket)',
        "    .file('derived/' + event.data.name)",
        "    .save(Buffer.from('derived:' + downloaded.toString('utf8'), 'utf8'), {",
        "      contentType: 'text/plain',",
        '    });',
        "  await getDatabase().ref('receipts/' + receiptKey(event.data.name)).set({",
        '    id: event.id,',
        '    source: event.source,',
        '    specversion: event.specversion,',
        '    type: event.type,',
        '    time: event.time,',
        '    subject: event.subject,',
        '    bucket: event.bucket,',
        '    location: event.location,',
        '    name: event.data.name,',
        '    dataBucket: event.data.bucket,',
        '    size: event.data.size,',
        '    sizeType: typeof event.data.size,',
        '    generation: event.data.generation,',
        '    metageneration: event.data.metageneration,',
        '    contentType: event.data.contentType || null,',
        '    md5Hash: event.data.md5Hash || null,',
        '    crc32c: event.data.crc32c || null,',
        '    etag: event.data.etag || null,',
        '    storageClass: event.data.storageClass || null,',
        '    cacheControl: event.data.cacheControl || null,',
        '    contentDisposition: event.data.contentDisposition || null,',
        '    contentLanguage: event.data.contentLanguage || null,',
        '    metadata: event.data.metadata || null,',
        "    downloadedText: downloaded.toString('utf8'),",
        '  });',
        '});',
        '',
        'exports.onRegionalBucket = onObjectFinalized(',
        "  { bucket: 'regional-media-bucket', region: 'europe-west1' },",
        '  async (event) => {',
        '    ensureAdmin();',
        '    const [downloaded] = await getStorage()',
        '      .bucket(event.data.bucket)',
        '      .file(event.data.name)',
        '      .download();',
        "    await getDatabase().ref('regionalReceipts/' + receiptKey(event.data.name)).set({",
        '      bucket: event.bucket,',
        '      location: event.location,',
        '      name: event.data.name,',
        "      downloadedText: downloaded.toString('utf8'),",
        '    });',
        '  },',
        ');',
        '',
        'exports.seedViaAdminSave = onValueCreated(',
        "  '/adminSaveCommands/{cmdId}',",
        '  async (event) => {',
        '    ensureAdmin();',
        '    const cmd = event.data.val();',
        '    await getStorage()',
        '      .bucket()',
        '      .file(cmd.path)',
        "      .save(Buffer.from(cmd.text, 'utf8'), {",
        '        contentType: cmd.contentType,',
        '        metadata: { metadata: { uploadedVia: cmd.uploadedVia } },',
        '      });',
        '  },',
        ');',
        '',
        'exports.omittedFinalized = onObjectFinalized(',
        '  { omit: true },',
        '  () => undefined,',
        ');',
        '',
        'exports.pendingDeleteSupport = onObjectDeleted(() => undefined);',
      ].join('\n'),
    );
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(fixtureDir, 'functions/node_modules/firebase-functions'),
    );

    writeFileSync(
      join(fixtureDir, 'functions-esm/package.json'),
      JSON.stringify({
        name: 'storage-fn-esm',
        private: true,
        type: 'module',
        main: 'index.js',
      }),
    );
    writeFileSync(
      join(fixtureDir, 'functions-esm/index.js'),
      [
        "import { initializeApp, getApps } from 'firebase-admin/app';",
        "import { getDatabase } from 'firebase-admin/database';",
        "import { getStorage } from 'firebase-admin/storage';",
        "import { onObjectFinalized } from 'firebase-functions/v2/storage';",
        'await Promise.resolve();',
        'if (getApps().length === 0) initializeApp();',
        'export const onEsmFinalized = onObjectFinalized(async (event) => {',
        "  if (!event.data.name.startsWith('esm/')) return;",
        '  const [downloaded] = await getStorage()',
        '    .bucket(event.data.bucket)',
        '    .file(event.data.name)',
        '    .download();',
        "  await getDatabase().ref('esmReceipts/latest').set({",
        '    name: event.data.name,',
        '    bucket: event.bucket,',
        "    text: downloaded.toString('utf8'),",
        '  });',
        '});',
      ].join('\n'),
    );
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(fixtureDir, 'functions-esm/node_modules/firebase-functions'),
    );

    hosted = await startNodeHostedRuntime(fixtureDir);
    observer = await connectRemoteSandbox({
      cwd: fixtureDir,
      url: hosted.url,
      sessionToken: hosted.sessionToken,
    });
  }, 30_000);

  afterAll(async () => {
    if (activeChild) await activeChild.stop();
    observer?.close();
    if (hosted) await hosted.stop();
    tempDirs.cleanupTempDirs();
  });

  test('fires onObjectFinalized across putBytes, uploadString, HTTP byte route, and firebase-admin file().save() with live download()', async () => {
    if (!hosted || !observer) throw new Error('hosted runtime not initialized');
    const events: FunctionsChildEvent[] = [];
    activeChild = spawnFunctionsChild({
      cwd: join(fixtureDir, 'functions'),
      entry: join(fixtureDir, 'functions/index.js'),
      childModuleUrl: pathToFileURL(childModule),
      env: buildChildEnv(process.env, {
        serveUrl: hosted.url,
        registerUrl: registerModuleUrl(),
        instanceId: hosted.instanceId,
        sessionToken: hosted.sessionToken,
      }),
      instance: 'demo-project-default-rtdb',
      projectId: 'demo-project',
      location: 'us-central1',
      onEvent: (event) => events.push(event),
    });

    const ready = await activeChild.ready;
    expect(ready).toEqual({
      triggerCount: 4,
      unsupportedTriggers: [
        {
          exportName: 'omittedFinalized',
          eventType: 'google.cloud.storage.object.v1.finalized (omitted from emulation)',
        },
      ],
    });

    // 1. observer.storage.putBytes (unnamed default bucket BEFORE any admin call).
    const putBytesText = 'hello from hosted putBytes';
    const putBytesPayload = Buffer.from(putBytesText, 'utf8');
    await observer.storage.putBytes('uploads/put-bytes/nested/hello.txt', putBytesPayload, {
      contentType: 'text/plain',
      metadata: { customMetadata: { stage: 'put-bytes' } },
    });

    const putBytesReceipt = await waitForRtdbValue<TriggerReceipt>(
      observer,
      'receipts/uploads_put-bytes_nested_hello_txt',
    );
    expect(putBytesReceipt).toMatchObject({
      specversion: '1.0',
      type: 'google.cloud.storage.object.v1.finalized',
      source: '//storage.googleapis.com/projects/_/buckets/demo-project.firebasestorage.app',
      subject: 'objects/uploads/put-bytes/nested/hello.txt',
      bucket: 'demo-project.firebasestorage.app',
      location: 'us-central1',
      name: 'uploads/put-bytes/nested/hello.txt',
      dataBucket: 'demo-project.firebasestorage.app',
      size: String(putBytesPayload.byteLength),
      sizeType: 'string',
      metageneration: '1',
      contentType: 'text/plain',
      md5Hash: computeMd5Base64(putBytesPayload),
      crc32c: computeCrc32cBase64(putBytesPayload),
      storageClass: 'STANDARD',
      metadata: { stage: 'put-bytes' },
      downloadedText: putBytesText,
    });
    const derivedBytes = await observer.storage.getBytes(
      'derived/uploads/put-bytes/nested/hello.txt',
    );
    expect(derivedBytes.toString('utf8')).toBe(`derived:${putBytesText}`);

    // 2. Client uploadString (data_url with custom metadata and content headers).
    const clientPort = createChannelClientPort(observer, {
      baseUrl: hosted.url,
      sessionToken: hosted.sessionToken,
    });
    const clientStorage = getClientStorage({
      __kind: 'client-db',
      type: 'firestore',
      port: clientPort,
    });
    const stringText = 'uploadString payload 123456789';
    const stringBytes = Buffer.from(stringText, 'utf8');
    const dataUrl = `data:text/plain;base64,${stringBytes.toString('base64')}`;
    await clientUploadString(
      clientRef(clientStorage, 'uploads/put-string/nested/note.txt'),
      dataUrl,
      'data_url',
      {
        cacheControl: 'public, max-age=120',
        contentDisposition: 'attachment; filename="note.txt"',
        contentLanguage: 'en-US',
        customMetadata: { source: 'uploadString', author: 'alice' },
      },
    );

    const stringReceipt = await waitForRtdbValue<TriggerReceipt>(
      observer,
      'receipts/uploads_put-string_nested_note_txt',
    );
    expect(stringReceipt).toMatchObject({
      bucket: 'demo-project.firebasestorage.app',
      name: 'uploads/put-string/nested/note.txt',
      size: String(stringBytes.byteLength),
      contentType: 'text/plain',
      md5Hash: computeMd5Base64(stringBytes),
      crc32c: computeCrc32cBase64(stringBytes),
      cacheControl: 'public, max-age=120',
      contentDisposition: 'attachment; filename="note.txt"',
      contentLanguage: 'en-US',
      metadata: { source: 'uploadString', author: 'alice' },
      downloadedText: stringText,
    });

    // 3. Direct HTTP byte-route session upload (createUploadSession + PUT /__pyric/storage/v0/...).
    const sessionText = 'streamed directly over HTTP byte route';
    const sessionBytes = Buffer.from(sessionText, 'utf8');
    const sessionCreated = (await observer.channel.op({
      method: 'storage.createUploadSession',
      path: 'uploads/http-route/nested/stream.bin',
      contentType: 'application/octet-stream',
      metadata: { customMetadata: { transport: 'http-session' } },
      actAs: { mode: 'admin' },
    })) as { uploadUrl: string };
    const putResponse = await fetch(new URL(sessionCreated.uploadUrl, hosted.url), {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(sessionBytes.byteLength),
      },
      body: sessionBytes,
    });
    expect(putResponse.status).toBe(200);

    const sessionReceipt = await waitForRtdbValue<TriggerReceipt>(
      observer,
      'receipts/uploads_http-route_nested_stream_bin',
    );
    expect(sessionReceipt).toMatchObject({
      bucket: 'demo-project.firebasestorage.app',
      name: 'uploads/http-route/nested/stream.bin',
      size: String(sessionBytes.byteLength),
      contentType: 'application/octet-stream',
      md5Hash: computeMd5Base64(sessionBytes),
      crc32c: computeCrc32cBase64(sessionBytes),
      metadata: { transport: 'http-session' },
      downloadedText: sessionText,
    });

    // 4. firebase-admin/storage bucket().file().save() inside isolated child.
    const adminJsonText = JSON.stringify({ savedBy: 'firebase-admin', ok: true });
    const adminJsonBytes = Buffer.from(adminJsonText, 'utf8');
    await observer.rtdb.set('adminSaveCommands/cmd1', {
      path: 'uploads/admin-save/nested/config.json',
      text: adminJsonText,
      contentType: 'application/json',
      uploadedVia: 'file.save',
    });

    const adminSaveReceipt = await waitForRtdbValue<TriggerReceipt>(
      observer,
      'receipts/uploads_admin-save_nested_config_json',
    );
    expect(adminSaveReceipt).toMatchObject({
      bucket: 'demo-project.firebasestorage.app',
      name: 'uploads/admin-save/nested/config.json',
      size: String(adminJsonBytes.byteLength),
      contentType: 'application/json',
      md5Hash: computeMd5Base64(adminJsonBytes),
      crc32c: computeCrc32cBase64(adminJsonBytes),
      downloadedText: adminJsonText,
    });
    expect(adminSaveReceipt.metadata?.uploadedVia).toBe('file.save');

    // 5. Explicit non-default regional bucket routing.
    const regionalStorage = getClientStorage(
      { __kind: 'client-db', type: 'firestore', port: clientPort },
      undefined,
      'regional-media-bucket',
      true,
      'demo-project.firebasestorage.app',
    );
    await clientUploadBytes(
      clientRef(regionalStorage, 'clips/intro.txt'),
      Buffer.from('regional-clip', 'utf8'),
      { contentType: 'text/plain' },
    );
    const regionalReceipt = await waitForRtdbValue<{
      bucket: string;
      location: string;
      name: string;
      downloadedText: string;
    }>(observer, 'regionalReceipts/clips_intro_txt');
    expect(regionalReceipt).toEqual({
      bucket: 'regional-media-bucket',
      location: 'europe-west1',
      name: 'clips/intro.txt',
      downloadedText: 'regional-clip',
    });
    expect(await observer.rtdb.get('receipts/clips_intro_txt')).toBeNull();

    expect(events).toContainEqual({
      type: 'execution',
      exportName: 'onDefaultFinalized',
      ref: 'demo-project.firebasestorage.app/uploads/put-bytes/nested/hello.txt',
      params: {},
      status: 'fulfilled',
    });

    expect(await activeChild.stop()).toBe(0);
    activeChild = undefined;
  }, 30_000);

  test('loads unchanged ESM firebase-functions/v2/storage source and downloads inside handler', async () => {
    if (!hosted || !observer) throw new Error('hosted runtime not initialized');
    activeChild = spawnFunctionsChild({
      cwd: join(fixtureDir, 'functions-esm'),
      entry: join(fixtureDir, 'functions-esm/index.js'),
      childModuleUrl: pathToFileURL(childModule),
      env: buildChildEnv(process.env, {
        serveUrl: hosted.url,
        registerUrl: registerModuleUrl(),
        instanceId: hosted.instanceId,
        sessionToken: hosted.sessionToken,
      }),
      instance: 'demo-project-default-rtdb',
      projectId: 'demo-project',
      location: 'us-central1',
    });

    expect(await activeChild.ready).toEqual({
      triggerCount: 1,
      unsupportedTriggers: [],
    });

    await observer.storage.putBytes(
      'esm/nested/greeting.txt',
      Buffer.from('hello from esm trigger', 'utf8'),
      { contentType: 'text/plain' },
    );
    const esmReceipt = await waitForRtdbValue<{ name: string; bucket: string; text: string }>(
      observer,
      'esmReceipts/latest',
    );
    expect(esmReceipt).toEqual({
      name: 'esm/nested/greeting.txt',
      bucket: 'demo-project.firebasestorage.app',
      text: 'hello from esm trigger',
    });

    expect(await activeChild.stop()).toBe(0);
    activeChild = undefined;
  }, 20_000);

  test('adopts <projectId>.firebasestorage.app as default bucket after child subscribes and downloads inside omitted-bucket trigger', async () => {
    const modernDir = tempDirs.makeTempDir();
    mkdirSync(join(modernDir, 'public'), { recursive: true });
    mkdirSync(join(modernDir, 'functions/node_modules'), { recursive: true });
    writeFileSync(join(modernDir, 'public/index.html'), '<!doctype html><body>modern</body>');
    writeFileSync(
      join(modernDir, 'firebase.json'),
      JSON.stringify({ hosting: { public: 'public' } }),
    );
    writeFileSync(
      join(modernDir, 'functions/package.json'),
      JSON.stringify({ name: 'storage-fn-modern', private: true, type: 'commonjs' }),
    );
    writeFileSync(
      join(modernDir, 'functions/index.js'),
      [
        "const { initializeApp, getApps } = require('firebase-admin/app');",
        "const { getDatabase } = require('firebase-admin/database');",
        "const { getStorage } = require('firebase-admin/storage');",
        "const { onObjectFinalized } = require('firebase-functions/v2/storage');",
        'if (getApps().length === 0) initializeApp();',
        'exports.onModernDefault = onObjectFinalized(async (event) => {',
        '  const [downloaded] = await getStorage()',
        '    .bucket(event.data.bucket)',
        '    .file(event.data.name)',
        '    .download();',
        "  await getDatabase().ref('modernReceipts/latest').set({",
        '    bucket: event.bucket,',
        '    dataBucket: event.data.bucket,',
        '    name: event.data.name,',
        "    text: downloaded.toString('utf8'),",
        '  });',
        '});',
      ].join('\n'),
    );
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(modernDir, 'functions/node_modules/firebase-functions'),
    );

    const modernHosted = await startNodeHostedRuntime(modernDir, 'demo-project');
    const modernObserver = await connectRemoteSandbox({
      cwd: modernDir,
      url: modernHosted.url,
      sessionToken: modernHosted.sessionToken,
    });
    let modernChild: FunctionsChildHandle | undefined;
    try {
      modernChild = spawnFunctionsChild({
        cwd: join(modernDir, 'functions'),
        entry: join(modernDir, 'functions/index.js'),
        childModuleUrl: pathToFileURL(childModule),
        env: buildChildEnv(process.env, {
          serveUrl: modernHosted.url,
          registerUrl: registerModuleUrl(),
          instanceId: modernHosted.instanceId,
          sessionToken: modernHosted.sessionToken,
        }),
        instance: 'demo-project-default-rtdb',
        projectId: 'demo-project',
        location: 'us-central1',
      });
      expect((await modernChild.ready).triggerCount).toBe(1);

      const modernText = 'uploaded via firebasestorage.app default bucket';
      const modernBytes = Buffer.from(modernText, 'utf8');
      const session = (await modernObserver.channel.op({
        method: 'storage.createUploadSession',
        bucket: 'demo-project.firebasestorage.app',
        defaultBucket: 'demo-project.firebasestorage.app',
        path: 'modern/nested/asset.txt',
        contentType: 'text/plain',
        actAs: { mode: 'admin' },
      })) as { uploadUrl: string };
      const putRes = await fetch(new URL(session.uploadUrl, modernHosted.url), {
        method: 'PUT',
        headers: {
          'content-type': 'text/plain',
          'content-length': String(modernBytes.byteLength),
        },
        body: modernBytes,
      });
      expect(putRes.status).toBe(200);

      const receipt = await waitForRtdbValue<{
        bucket: string;
        dataBucket: string;
        name: string;
        text: string;
      }>(modernObserver, 'modernReceipts/latest');
      expect(receipt).toEqual({
        bucket: 'demo-project.firebasestorage.app',
        dataBucket: 'demo-project.firebasestorage.app',
        name: 'modern/nested/asset.txt',
        text: modernText,
      });

      expect(await modernChild.stop()).toBe(0);
      modernChild = undefined;
    } finally {
      if (modernChild) await modernChild.stop();
      modernObserver.close();
      await modernHosted.stop();
    }
  }, 25_000);
});
