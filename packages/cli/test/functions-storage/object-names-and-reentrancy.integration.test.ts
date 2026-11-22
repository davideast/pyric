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
} from '../../src/serve/worker/client/storage.js';
import { trackTempDirs } from '../use-temp-dirs.js';
import {
  childModule,
  createChannelClientPort,
  repoRoot,
  startNodeHostedRuntime,
  waitForRtdbValue,
  type HostedNodeServer,
} from './hosted-harness.js';

interface ObjectNameReceipt {
  name: string;
  subject: string;
  selfLink: string;
  mediaLink: string;
  bucket: string;
  generation: string;
  metageneration: string;
  size: string;
  contentType: string;
  cacheControl?: string;
  md5Hash: string;
  crc32c: string;
  downloadedHex: string;
  downloadedLength: number;
  hasMetadata: boolean;
  metadata?: Record<string, string>;
}

interface MetadataUpdateReceipt {
  name: string;
  bucket: string;
  generation: string;
  metageneration: string;
  size: string;
  contentType: string;
  cacheControl?: string;
  md5Hash: string;
  crc32c: string;
  downloadedHex: string;
  hasMetadata: boolean;
  metadata?: Record<string, string>;
}

describe('special/Unicode object names, zero-byte uploads, and re-entrant prefix guard', () => {
  const tempDirs = trackTempDirs('pyric-fn-storage-names-');
  let fixtureDir = '';
  let hosted: HostedNodeServer | undefined;
  let observer: RemoteSandbox | undefined;
  let child: FunctionsChildHandle | undefined;
  const events: FunctionsChildEvent[] = [];

  beforeAll(async () => {
    if (!existsSync(childModule)) {
      throw new Error(`Functions child is not built: ${childModule}`);
    }
    fixtureDir = tempDirs.makeTempDir();
    mkdirSync(join(fixtureDir, 'public'), { recursive: true });
    mkdirSync(join(fixtureDir, 'functions/node_modules'), { recursive: true });
    writeFileSync(join(fixtureDir, 'public/index.html'), '<!doctype html><body>names</body>');
    writeFileSync(
      join(fixtureDir, 'firebase.json'),
      JSON.stringify({ hosting: { public: 'public' } }),
    );
    writeFileSync(
      join(fixtureDir, 'functions/package.json'),
      JSON.stringify({ name: 'storage-names-fn', private: true, type: 'commonjs' }),
    );
    writeFileSync(
      join(fixtureDir, 'functions/index.js'),
      [
        "const { initializeApp, getApps } = require('firebase-admin/app');",
        "const { getDatabase } = require('firebase-admin/database');",
        "const { getStorage } = require('firebase-admin/storage');",
        "const { onValueCreated } = require('firebase-functions/v2/database');",
        'const {',
        '  onObjectFinalized,',
        '  onObjectMetadataUpdated,',
        "} = require('firebase-functions/v2/storage');",
        '',
        'if (getApps().length === 0) initializeApp();',
        '',
        'let thumbInvocations = 0;',
        'let thumbRawWrites = 0;',
        'let thumbSkipped = 0;',
        '',
        'exports.inspectAndThumbnail = onObjectFinalized(async (event) => {',
        "  const nameHex = Buffer.from(event.data.name, 'utf8').toString('hex');",
        '  const [downloaded] = await getStorage()',
        '    .bucket(event.data.bucket)',
        '    .file(event.data.name)',
        '    .download();',
        '',
        '  const receipt = {',
        '    name: event.data.name,',
        '    subject: event.subject,',
        '    selfLink: event.data.selfLink,',
        '    mediaLink: event.data.mediaLink,',
        '    bucket: event.bucket,',
        '    generation: event.data.generation,',
        '    metageneration: event.data.metageneration,',
        '    size: event.data.size,',
        '    contentType: event.data.contentType || null,',
        '    md5Hash: event.data.md5Hash || null,',
        '    crc32c: event.data.crc32c || null,',
        "    downloadedHex: downloaded.toString('hex'),",
        '    downloadedLength: downloaded.length,',
        "    hasMetadata: typeof event.data.metadata === 'object' && event.data.metadata !== null,",
        '    metadata: event.data.metadata || null,',
        '  };',
        '  if (event.data.cacheControl !== undefined) {',
        '    receipt.cacheControl = event.data.cacheControl;',
        '  }',
        "  await getDatabase().ref('nameReceipts/' + nameHex).set(receipt);",
        '',
        "  if (event.data.name.startsWith('thumb-raw/') || event.data.name.startsWith('processed/')) {",
        '    thumbInvocations += 1;',
        "    if (!event.data.name.startsWith('thumb-raw/')) {",
        '      thumbSkipped += 1;',
        "      await getDatabase().ref('thumbStats').set({",
        '        invocations: thumbInvocations,',
        '        rawWrites: thumbRawWrites,',
        '        skipped: thumbSkipped,',
        '        lastSeen: event.data.name,',
        '      });',
        '      return;',
        '    }',
        '    thumbRawWrites += 1;',
        "    const suffix = event.data.name.slice('thumb-raw/'.length);",
        "    const thumbBytes = Buffer.concat([Buffer.from('THUMB:', 'utf8'), downloaded]);",
        '    await getStorage()',
        '      .bucket(event.data.bucket)',
        "      .file('processed/' + suffix)",
        '      .save(thumbBytes, {',
        "        contentType: 'image/webp',",
        '        metadata: {',
        '          metadata: {',
        '            sourceName: event.data.name,',
        '            sourceGeneration: event.data.generation,',
        '          },',
        '        },',
        '      });',
        '  }',
        '});',
        '',
        'exports.onNamedSpecialBucket = onObjectFinalized(',
        "  { bucket: 'bucket-special' },",
        '  async (event) => {',
        "    const nameHex = Buffer.from(event.data.name, 'utf8').toString('hex');",
        '    const [downloaded] = await getStorage()',
        '      .bucket(event.data.bucket)',
        '      .file(event.data.name)',
        '      .download();',
        "    await getDatabase().ref('namedSpecialReceipts/' + nameHex).set({",
        '      name: event.data.name,',
        '      bucket: event.bucket,',
        "      downloadedHex: downloaded.toString('hex'),",
        '      crc32c: event.data.crc32c,',
        '    });',
        '  },',
        ');',
        '',
        'exports.saveAdminObject = onValueCreated(',
        "  '/adminObjectWrites/{id}',",
        '  async (event) => {',
        '    const req = event.data.val();',
        '    const file = getStorage().bucket().file(req.path);',
        "    if (req.action === 'setMetadata') {",
        '      await file.setMetadata(req.patch);',
        '      return;',
        '    }',
        "    const payload = Buffer.from(req.hex || '', 'hex');",
        '    await file.save(payload, {',
        "      contentType: req.contentType || 'application/octet-stream',",
        '    });',
        '  },',
        ');',
        '',
        'exports.onMetadataChanged = onObjectMetadataUpdated(async (event) => {',
        "  const nameHex = Buffer.from(event.data.name, 'utf8').toString('hex');",
        '  const [downloaded] = await getStorage()',
        '    .bucket(event.data.bucket)',
        '    .file(event.data.name)',
        '    .download();',
        '  const entry = {',
        '    name: event.data.name,',
        '    bucket: event.bucket,',
        '    generation: event.data.generation,',
        '    metageneration: event.data.metageneration,',
        '    size: event.data.size,',
        "    contentType: event.data.contentType || '',",
        '    md5Hash: event.data.md5Hash || null,',
        '    crc32c: event.data.crc32c || null,',
        "    downloadedHex: downloaded.toString('hex'),",
        "    hasMetadata: typeof event.data.metadata === 'object' && event.data.metadata !== null,",
        '    metadata: event.data.metadata || null,',
        '  };',
        '  if (event.data.cacheControl !== undefined) {',
        '    entry.cacheControl = event.data.cacheControl;',
        '  }',
        "  await getDatabase().ref('metaReceipts/' + nameHex + '/m' + event.data.metageneration).set(entry);",
        '});',
      ].join('\n'),
    );
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(fixtureDir, 'functions/node_modules/firebase-functions'),
    );

    hosted = await startNodeHostedRuntime(fixtureDir, 'demo-project');
    observer = await connectRemoteSandbox({
      cwd: fixtureDir,
      url: hosted.url,
      sessionToken: hosted.sessionToken,
    });
    child = spawnFunctionsChild({
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
    expect(await child.ready).toEqual({
      triggerCount: 4,
      unsupportedTriggers: [],
    });
  }, 30_000);

  afterAll(async () => {
    if (child) await child.stop();
    observer?.close();
    if (hosted) await hosted.stop();
    tempDirs.cleanupTempDirs();
  });

  test('round-trips special characters (spaces, slashes, #, ?, %) and Unicode + arbitrary binary bytes', async () => {
    if (!observer) throw new Error('observer not initialized');

    const cases: Array<{ path: string; bytes: Uint8Array; contentType: string }> = [
      {
        path: 'folders with spaces/annual report (final) v2.txt',
        bytes: Buffer.from('spaces in directory and filename', 'utf8'),
        contentType: 'text/plain',
      },
      {
        path: 'deep/a/b/c/d/e/f/item.v1.2.bin',
        bytes: new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]),
        contentType: 'application/octet-stream',
      },
      {
        path: 'fragments/release#2026-11#rc1.txt',
        bytes: Buffer.from('hash fragment characters in object name', 'utf8'),
        contentType: 'text/plain',
      },
      {
        path: 'queries/search?q=storage&page=1.json',
        bytes: Buffer.from('{"query":true}', 'utf8'),
        contentType: 'application/json',
      },
      {
        path: 'percent/100%raw%20literal%25done.txt',
        bytes: Buffer.from('literal percent signs must not double-decode', 'utf8'),
        contentType: 'text/plain',
      },
      {
        path: 'unicode/caf\u00e9/\u65e5\u672c\u8a9e-\ud83d\ude80/binary.dat',
        bytes: new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff, 0x42, 0x99]),
        contentType: 'application/octet-stream',
      },
    ];

    for (const item of cases) {
      await observer.storage.putBytes(item.path, item.bytes, {
        contentType: item.contentType,
      });

      const nameHex = Buffer.from(item.path, 'utf8').toString('hex');
      const receipt = await waitForRtdbValue<ObjectNameReceipt>(
        observer,
        `nameReceipts/${nameHex}`,
      );
      const encodedName = encodeURIComponent(item.path);

      expect(receipt).toEqual({
        name: item.path,
        subject: `objects/${item.path}`,
        selfLink: `https://www.googleapis.com/storage/v1/b/demo-project.firebasestorage.app/o/${encodedName}`,
        mediaLink: receipt.mediaLink,
        bucket: 'demo-project.firebasestorage.app',
        generation: receipt.generation,
        metageneration: '1',
        size: String(item.bytes.byteLength),
        contentType: item.contentType,
        md5Hash: computeMd5Base64(item.bytes),
        crc32c: computeCrc32cBase64(item.bytes),
        downloadedHex: Buffer.from(item.bytes).toString('hex'),
        downloadedLength: item.bytes.byteLength,
        hasMetadata: false,
      });
      expect(receipt.mediaLink).toContain(`/b/demo-project.firebasestorage.app/o/${encodedName}?generation=`);
      expect(receipt.mediaLink).toEndWith('&alt=media');
    }

    // Also verify special + Unicode + binary round-trip on a named non-default bucket.
    if (!hosted) throw new Error('hosted runtime not initialized');
    const clientPort = createChannelClientPort(observer, {
      baseUrl: hosted.url,
      sessionToken: hosted.sessionToken,
    });
    const namedSpecial = getClientStorage(
      { __kind: 'client-db', type: 'firestore', port: clientPort },
      undefined,
      'bucket-special',
      true,
      'demo-project.firebasestorage.app',
    );
    const namedPath = 'named/caf\u00e9/query?x=1#tag%25/data.bin';
    const namedBytes = new Uint8Array([0x00, 0x7f, 0x80, 0xff, 0x10]);
    await clientUploadBytes(clientRef(namedSpecial, namedPath), namedBytes, {
      contentType: 'application/octet-stream',
    });
    const namedHex = Buffer.from(namedPath, 'utf8').toString('hex');
    const namedReceipt = await waitForRtdbValue<{
      name: string;
      bucket: string;
      downloadedHex: string;
      crc32c: string;
    }>(observer, `namedSpecialReceipts/${namedHex}`);
    expect(namedReceipt).toEqual({
      name: namedPath,
      bucket: 'bucket-special',
      downloadedHex: Buffer.from(namedBytes).toString('hex'),
      crc32c: computeCrc32cBase64(namedBytes),
    });
  }, 30_000);

  test('delivers zero-byte uploads via putBytes and firebase-admin save() with empty digests and 0-byte download()', async () => {
    if (!observer) throw new Error('observer not initialized');
    const emptyBytes = new Uint8Array(0);

    await observer.storage.putBytes('empty/zero-via-putbytes.bin', emptyBytes, {
      contentType: 'application/x-empty',
    });
    const putZeroHex = Buffer.from('empty/zero-via-putbytes.bin', 'utf8').toString('hex');
    const putZeroReceipt = await waitForRtdbValue<ObjectNameReceipt>(
      observer,
      `nameReceipts/${putZeroHex}`,
    );
    expect(putZeroReceipt).toMatchObject({
      name: 'empty/zero-via-putbytes.bin',
      size: '0',
      contentType: 'application/x-empty',
      md5Hash: '1B2M2Y8AsgTpgAmY7PhCfg==',
      crc32c: 'AAAAAA==',
      downloadedHex: '',
      downloadedLength: 0,
    });

    await observer.rtdb.set('adminObjectWrites/zero1', {
      path: 'empty/zero-via-admin-save.bin',
      hex: '',
      contentType: 'application/octet-stream',
    });
    const adminZeroHex = Buffer.from('empty/zero-via-admin-save.bin', 'utf8').toString('hex');
    const adminZeroReceipt = await waitForRtdbValue<ObjectNameReceipt>(
      observer,
      `nameReceipts/${adminZeroHex}`,
    );
    expect(adminZeroReceipt).toMatchObject({
      name: 'empty/zero-via-admin-save.bin',
      size: '0',
      contentType: 'application/octet-stream',
      md5Hash: '1B2M2Y8AsgTpgAmY7PhCfg==',
      crc32c: 'AAAAAA==',
      downloadedHex: '',
      downloadedLength: 0,
    });
  }, 20_000);

  test('updates contentType and cacheControl via firebase-admin and host setMetadata while preserving generation and digests', async () => {
    if (!observer) throw new Error('observer not initialized');
    const targetPath = 'media/photo#1 (raw).bin';
    const rawBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x80, 0xff]);
    const targetHex = Buffer.from(targetPath, 'utf8').toString('hex');

    await observer.storage.putBytes(targetPath, rawBytes, {
      contentType: 'application/octet-stream',
    });
    const finalized = await waitForRtdbValue<ObjectNameReceipt>(
      observer,
      `nameReceipts/${targetHex}`,
    );
    expect(finalized.contentType).toBe('application/octet-stream');
    expect(finalized.metageneration).toBe('1');

    // 1. Update contentType + cacheControl + custom metadata via firebase-admin file.setMetadata().
    await observer.rtdb.set('adminObjectWrites/retypeWebp', {
      action: 'setMetadata',
      path: targetPath,
      patch: {
        contentType: 'image/webp',
        cacheControl: 'public, max-age=86400',
        metadata: { convertedFrom: 'octet-stream' },
      },
    });
    const webpMeta = await waitForRtdbValue<MetadataUpdateReceipt>(
      observer,
      `metaReceipts/${targetHex}/m2`,
    );
    expect(webpMeta).toEqual({
      name: targetPath,
      bucket: 'demo-project.firebasestorage.app',
      generation: finalized.generation,
      metageneration: '2',
      size: String(rawBytes.byteLength),
      contentType: 'image/webp',
      cacheControl: 'public, max-age=86400',
      md5Hash: computeMd5Base64(rawBytes),
      crc32c: computeCrc32cBase64(rawBytes),
      downloadedHex: Buffer.from(rawBytes).toString('hex'),
      hasMetadata: true,
      metadata: { convertedFrom: 'octet-stream' },
    });

    // 2. Update contentType on the zero-byte upload via host storage.setMetadata; empty digests stay intact.
    const zeroPath = 'empty/zero-via-putbytes.bin';
    const zeroHex = Buffer.from(zeroPath, 'utf8').toString('hex');
    await observer.channel.op({
      method: 'storage.setMetadata',
      path: zeroPath,
      patch: {
        settable: { contentType: 'text/plain; charset=utf-8' },
      },
      actAs: { mode: 'admin' },
    });
    const zeroMeta = await waitForRtdbValue<MetadataUpdateReceipt>(
      observer,
      `metaReceipts/${zeroHex}/m2`,
    );
    expect(zeroMeta).toMatchObject({
      name: zeroPath,
      bucket: 'demo-project.firebasestorage.app',
      metageneration: '2',
      size: '0',
      contentType: 'text/plain; charset=utf-8',
      md5Hash: '1B2M2Y8AsgTpgAmY7PhCfg==',
      crc32c: 'AAAAAA==',
      downloadedHex: '',
      hasMetadata: false,
    });
  }, 20_000);

  test('re-entrant thumbnail write-back writes processed/<name> and terminates cleanly via prefix guard', async () => {
    if (!observer) throw new Error('observer not initialized');
    const rawImage = Buffer.from('RAW_PNG_PAYLOAD_2026', 'utf8');
    const expectedThumb = Buffer.concat([Buffer.from('THUMB:', 'utf8'), rawImage]);
    const beforeEvents = events.length;

    await observer.storage.putBytes('thumb-raw/albums/cover.png', rawImage, {
      contentType: 'image/png',
    });

    const stats = await waitForRtdbValue<{
      invocations: number;
      rawWrites: number;
      skipped: number;
      lastSeen: string;
    }>(observer, 'thumbStats');
    expect(stats).toEqual({
      invocations: 2,
      rawWrites: 1,
      skipped: 1,
      lastSeen: 'processed/albums/cover.png',
    });

    const processedHex = Buffer.from('processed/albums/cover.png', 'utf8').toString('hex');
    const processedReceipt = await waitForRtdbValue<ObjectNameReceipt>(
      observer,
      `nameReceipts/${processedHex}`,
    );
    expect(processedReceipt).toMatchObject({
      name: 'processed/albums/cover.png',
      size: String(expectedThumb.byteLength),
      contentType: 'image/webp',
      md5Hash: computeMd5Base64(expectedThumb),
      crc32c: computeCrc32cBase64(expectedThumb),
      downloadedHex: expectedThumb.toString('hex'),
      downloadedLength: expectedThumb.byteLength,
    });
    expect(processedReceipt.metadata?.sourceName).toBe('thumb-raw/albums/cover.png');

    // Give the event loop a brief quiet window to prove no runaway re-entrant trigger fires.
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 150));
    expect(events.length).toBe(beforeEvents + 2);
    expect(await observer.rtdb.get('thumbStats')).toEqual({
      invocations: 2,
      rawWrites: 1,
      skipped: 1,
      lastSeen: 'processed/albums/cover.png',
    });
  }, 20_000);
});
