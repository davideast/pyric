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
import {
  connectRemoteSandbox,
  type RemoteSandbox,
} from '../../src/remote/index.js';
import {
  deleteObject as clientDeleteObject,
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

interface BucketTriggerRecord {
  handler: string;
  bucket: string;
  dataBucket: string;
  location: string;
  name: string;
  size: string;
  text: string;
}

interface BucketLifecycleRecord {
  handler: string;
  kind: 'metadataUpdated' | 'archived' | 'deleted';
  bucket: string;
  dataBucket: string;
  name: string;
  generation: string;
  metageneration: string;
  size: string;
  contentType: string;
  hasTimeDeleted: boolean;
  hasMetadata: boolean;
  metadata?: Record<string, string>;
}

async function waitForEventCount(
  events: readonly FunctionsChildEvent[],
  expectedCount: number,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (events.length < expectedCount && Date.now() < deadline) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
  }
  if (events.length < expectedCount) {
    throw new Error(`timed out waiting for ${expectedCount} child events; got ${events.length}`);
  }
}

describe('multi-bucket Storage trigger isolation against live HostedRuntime', () => {
  const tempDirs = trackTempDirs('pyric-fn-storage-multibucket-');
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
    writeFileSync(join(fixtureDir, 'public/index.html'), '<!doctype html><body>buckets</body>');
    writeFileSync(
      join(fixtureDir, 'firebase.json'),
      JSON.stringify({ hosting: { public: 'public' } }),
    );
    writeFileSync(
      join(fixtureDir, 'functions/package.json'),
      JSON.stringify({ name: 'storage-multibucket-fn', private: true, type: 'commonjs' }),
    );
    writeFileSync(
      join(fixtureDir, 'functions/index.js'),
      [
        "const { initializeApp, getApps } = require('firebase-admin/app');",
        "const { getDatabase } = require('firebase-admin/database');",
        "const { getStorage } = require('firebase-admin/storage');",
        'const {',
        '  onObjectFinalized,',
        '  onObjectMetadataUpdated,',
        '  onObjectArchived,',
        '  onObjectDeleted,',
        "} = require('firebase-functions/v2/storage');",
        '',
        'if (getApps().length === 0) initializeApp();',
        '',
        'async function recordHit(handler, event) {',
        '  const [bytes] = await getStorage()',
        '    .bucket(event.data.bucket)',
        '    .file(event.data.name)',
        '    .download();',
        "  const pathHex = Buffer.from(event.data.name, 'utf8').toString('hex');",
        "  await getDatabase().ref('bucketHits/' + handler + '/' + pathHex).set({",
        '    handler,',
        '    bucket: event.bucket,',
        '    dataBucket: event.data.bucket,',
        '    location: event.location,',
        '    name: event.data.name,',
        '    size: event.data.size,',
        "    text: bytes.toString('utf8'),",
        '  });',
        '}',
        '',
        'async function recordLifecycleHit(handler, kind, event) {',
        "  const pathHex = Buffer.from(event.data.name, 'utf8').toString('hex');",
        '  const entry = {',
        '    handler,',
        '    kind,',
        '    bucket: event.bucket,',
        '    dataBucket: event.data.bucket,',
        '    name: event.data.name,',
        '    generation: event.data.generation,',
        '    metageneration: event.data.metageneration,',
        '    size: event.data.size,',
        "    contentType: event.data.contentType || '',",
        "    hasTimeDeleted: Object.prototype.hasOwnProperty.call(event.data, 'timeDeleted'),",
        "    hasMetadata: Object.prototype.hasOwnProperty.call(event.data, 'metadata'),",
        '  };',
        '  if (event.data.metadata !== undefined) {',
        '    entry.metadata = event.data.metadata;',
        '  }',
        "  await getDatabase().ref('lifecycleHits/' + handler + '/' + pathHex).set(entry);",
        '}',
        '',
        'exports.onDefaultOmitted = onObjectFinalized(async (event) => {',
        "  await recordHit('onDefaultOmitted', event);",
        '});',
        '',
        'exports.onDefaultExplicit = onObjectFinalized(',
        "  { bucket: 'demo-project.appspot.com' },",
        '  async (event) => {',
        "    await recordHit('onDefaultExplicit', event);",
        '  },',
        ');',
        '',
        'exports.onBucketAlpha = onObjectFinalized(',
        "  { bucket: 'bucket-alpha', region: 'us-east1' },",
        '  async (event) => {',
        "    await recordHit('onBucketAlpha', event);",
        "    if (event.data.name.startsWith('relay-to-beta/')) {",
        '      const [bytes] = await getStorage()',
        '        .bucket(event.data.bucket)',
        '        .file(event.data.name)',
        '        .download();',
        "      const rest = event.data.name.slice('relay-to-beta/'.length);",
        '      await getStorage()',
        "        .bucket('bucket-beta')",
        "        .file('mirrored/' + rest)",
        "        .save(Buffer.from('alpha->beta:' + bytes.toString('utf8'), 'utf8'), {",
        "          contentType: 'text/plain',",
        '        });',
        '    }',
        '  },',
        ');',
        '',
        'exports.onBucketBeta = onObjectFinalized(',
        "  { bucket: 'bucket-beta', region: 'europe-west1' },",
        '  async (event) => {',
        "    await recordHit('onBucketBeta', event);",
        '  },',
        ');',
        '',
        'exports.onDefaultMeta = onObjectMetadataUpdated((event) =>',
        "  recordLifecycleHit('onDefaultMeta', 'metadataUpdated', event),",
        ');',
        'exports.onDefaultArchived = onObjectArchived((event) =>',
        "  recordLifecycleHit('onDefaultArchived', 'archived', event),",
        ');',
        'exports.onDefaultDeleted = onObjectDeleted((event) =>',
        "  recordLifecycleHit('onDefaultDeleted', 'deleted', event),",
        ');',
        '',
        'exports.onAlphaMeta = onObjectMetadataUpdated(',
        "  { bucket: 'bucket-alpha' },",
        "  (event) => recordLifecycleHit('onAlphaMeta', 'metadataUpdated', event),",
        ');',
        'exports.onAlphaArchived = onObjectArchived(',
        "  { bucket: 'bucket-alpha' },",
        "  (event) => recordLifecycleHit('onAlphaArchived', 'archived', event),",
        ');',
        'exports.onAlphaDeleted = onObjectDeleted(',
        "  { bucket: 'bucket-alpha' },",
        "  (event) => recordLifecycleHit('onAlphaDeleted', 'deleted', event),",
        ');',
        '',
        'exports.onBetaMeta = onObjectMetadataUpdated(',
        "  { bucket: 'bucket-beta' },",
        "  (event) => recordLifecycleHit('onBetaMeta', 'metadataUpdated', event),",
        ');',
        'exports.onBetaArchived = onObjectArchived(',
        "  { bucket: 'bucket-beta' },",
        "  (event) => recordLifecycleHit('onBetaArchived', 'archived', event),",
        ');',
        'exports.onBetaDeleted = onObjectDeleted(',
        "  { bucket: 'bucket-beta' },",
        "  (event) => recordLifecycleHit('onBetaDeleted', 'deleted', event),",
        ');',
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
      triggerCount: 13,
      unsupportedTriggers: [],
    });
  }, 30_000);

  afterAll(async () => {
    if (child) await child.stop();
    observer?.close();
    if (hosted) await hosted.stop();
    tempDirs.cleanupTempDirs();
  });

  test('uploads to bucket-beta only fire bucket-beta handlers and never bucket-alpha or default bucket', async () => {
    if (!hosted || !observer) throw new Error('hosted runtime not initialized');
    const clientPort = createChannelClientPort(observer, {
      baseUrl: hosted.url,
      sessionToken: hosted.sessionToken,
    });
    const betaStorage = getClientStorage(
      { __kind: 'client-db', type: 'firestore', port: clientPort },
      undefined,
      'bucket-beta',
      true,
      'demo-project.appspot.com',
    );
    const sharedPath = 'reports/2026/summary.txt';
    const pathHex = Buffer.from(sharedPath, 'utf8').toString('hex');

    await clientUploadBytes(
      clientRef(betaStorage, sharedPath),
      Buffer.from('payload-in-beta', 'utf8'),
      { contentType: 'text/plain' },
    );

    await waitForEventCount(events, 1);
    const betaHit = await waitForRtdbValue<BucketTriggerRecord>(
      observer,
      `bucketHits/onBucketBeta/${pathHex}`,
    );
    expect(betaHit).toEqual({
      handler: 'onBucketBeta',
      bucket: 'bucket-beta',
      dataBucket: 'bucket-beta',
      location: 'europe-west1',
      name: sharedPath,
      size: '15',
      text: 'payload-in-beta',
    });

    expect(await observer.rtdb.get(`bucketHits/onBucketAlpha/${pathHex}`)).toBeNull();
    expect(await observer.rtdb.get(`bucketHits/onDefaultOmitted/${pathHex}`)).toBeNull();
    expect(await observer.rtdb.get(`bucketHits/onDefaultExplicit/${pathHex}`)).toBeNull();
  }, 20_000);

  test('same object path across bucket-alpha, default bucket, and unsubscribed bucket stays isolated', async () => {
    if (!hosted || !observer) throw new Error('hosted runtime not initialized');
    const clientPort = createChannelClientPort(observer, {
      baseUrl: hosted.url,
      sessionToken: hosted.sessionToken,
    });
    const alphaStorage = getClientStorage(
      { __kind: 'client-db', type: 'firestore', port: clientPort },
      undefined,
      'bucket-alpha',
      true,
      'demo-project.appspot.com',
    );
    const unwatchedStorage = getClientStorage(
      { __kind: 'client-db', type: 'firestore', port: clientPort },
      undefined,
      'bucket-unwatched',
      true,
      'demo-project.appspot.com',
    );
    const sharedPath = 'reports/2026/summary.txt';
    const pathHex = Buffer.from(sharedPath, 'utf8').toString('hex');

    // Upload to unsubscribed bucket-unwatched: 0 triggers fire.
    const beforeUnwatched = events.length;
    await clientUploadBytes(
      clientRef(unwatchedStorage, sharedPath),
      Buffer.from('payload-unwatched', 'utf8'),
      { contentType: 'text/plain' },
    );
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 120));
    expect(events.length).toBe(beforeUnwatched);

    // Upload to bucket-alpha at the exact same object path: only onBucketAlpha fires.
    await clientUploadBytes(
      clientRef(alphaStorage, sharedPath),
      Buffer.from('payload-in-alpha', 'utf8'),
      { contentType: 'text/plain' },
    );
    await waitForEventCount(events, beforeUnwatched + 1);
    const alphaHit = await waitForRtdbValue<BucketTriggerRecord>(
      observer,
      `bucketHits/onBucketAlpha/${pathHex}`,
    );
    expect(alphaHit).toEqual({
      handler: 'onBucketAlpha',
      bucket: 'bucket-alpha',
      dataBucket: 'bucket-alpha',
      location: 'us-east1',
      name: sharedPath,
      size: '16',
      text: 'payload-in-alpha',
    });
    expect(await observer.rtdb.get(`bucketHits/onDefaultOmitted/${pathHex}`)).toBeNull();
    expect(await observer.rtdb.get(`bucketHits/onDefaultExplicit/${pathHex}`)).toBeNull();

    // Upload to default bucket at the exact same object path: both default triggers fire, named buckets stay untouched.
    const beforeDefault = events.length;
    await observer.storage.putBytes(sharedPath, Buffer.from('payload-in-default', 'utf8'), {
      contentType: 'text/plain',
    });
    await waitForEventCount(events, beforeDefault + 2);
    const omittedHit = await waitForRtdbValue<BucketTriggerRecord>(
      observer,
      `bucketHits/onDefaultOmitted/${pathHex}`,
    );
    const explicitHit = await waitForRtdbValue<BucketTriggerRecord>(
      observer,
      `bucketHits/onDefaultExplicit/${pathHex}`,
    );
    expect(omittedHit.text).toBe('payload-in-default');
    expect(omittedHit.bucket).toBe('demo-project.appspot.com');
    expect(explicitHit.text).toBe('payload-in-default');
    expect(explicitHit.bucket).toBe('demo-project.appspot.com');

    // Earlier bucket-beta receipt still holds beta's payload, uncorrupted.
    const betaHitAfter = await waitForRtdbValue<BucketTriggerRecord>(
      observer,
      `bucketHits/onBucketBeta/${pathHex}`,
    );
    expect(betaHitAfter.text).toBe('payload-in-beta');
  }, 20_000);

  test('cross-bucket admin save inside bucket-alpha handler triggers bucket-beta handler without leaking to default', async () => {
    if (!hosted || !observer) throw new Error('hosted runtime not initialized');
    const clientPort = createChannelClientPort(observer, {
      baseUrl: hosted.url,
      sessionToken: hosted.sessionToken,
    });
    const alphaStorage = getClientStorage(
      { __kind: 'client-db', type: 'firestore', port: clientPort },
      undefined,
      'bucket-alpha',
      true,
      'demo-project.appspot.com',
    );
    const sourcePath = 'relay-to-beta/job-9.txt';
    const mirroredPath = 'mirrored/job-9.txt';
    const mirroredHex = Buffer.from(mirroredPath, 'utf8').toString('hex');
    const beforeCount = events.length;

    await clientUploadBytes(
      clientRef(alphaStorage, sourcePath),
      Buffer.from('cross-bucket-data', 'utf8'),
      { contentType: 'text/plain' },
    );

    await waitForEventCount(events, beforeCount + 2);
    const mirroredHit = await waitForRtdbValue<BucketTriggerRecord>(
      observer,
      `bucketHits/onBucketBeta/${mirroredHex}`,
    );
    expect(mirroredHit).toEqual({
      handler: 'onBucketBeta',
      bucket: 'bucket-beta',
      dataBucket: 'bucket-beta',
      location: 'europe-west1',
      name: mirroredPath,
      size: String('alpha->beta:cross-bucket-data'.length),
      text: 'alpha->beta:cross-bucket-data',
    });
    expect(await observer.rtdb.get(`bucketHits/onDefaultOmitted/${mirroredHex}`)).toBeNull();
  }, 20_000);

  test('metadataUpdated, archived, and deleted on bucket-beta never leak to bucket-alpha or default bucket', async () => {
    if (!hosted || !observer) throw new Error('hosted runtime not initialized');
    const clientPort = createChannelClientPort(observer, {
      baseUrl: hosted.url,
      sessionToken: hosted.sessionToken,
    });
    const alphaStorage = getClientStorage(
      { __kind: 'client-db', type: 'firestore', port: clientPort },
      undefined,
      'bucket-alpha',
      true,
      'demo-project.appspot.com',
    );
    const betaStorage = getClientStorage(
      { __kind: 'client-db', type: 'firestore', port: clientPort },
      undefined,
      'bucket-beta',
      true,
      'demo-project.appspot.com',
    );
    const sharedPath = 'lifecycle-isolated/item.txt';
    const pathHex = Buffer.from(sharedPath, 'utf8').toString('hex');

    // Seed the identical path across default, bucket-alpha, and bucket-beta.
    const beforeSeed = events.length;
    await observer.storage.putBytes(sharedPath, Buffer.from('default-v1', 'utf8'), {
      contentType: 'text/plain',
    });
    await clientUploadBytes(
      clientRef(alphaStorage, sharedPath),
      Buffer.from('alpha-v1', 'utf8'),
      { contentType: 'text/plain' },
    );
    const betaSeed = await clientUploadBytes(
      clientRef(betaStorage, sharedPath),
      Buffer.from('beta-v1', 'utf8'),
      { contentType: 'text/plain' },
    );
    await waitForEventCount(events, beforeSeed + 4);
    const betaGen1 = betaSeed.metadata.generation;

    // 1. Metadata update on bucket-beta only triggers onBetaMeta.
    const beforeMeta = events.length;
    await observer.channel.op({
      method: 'storage.setMetadata',
      path: sharedPath,
      bucket: 'bucket-beta',
      namedBucket: true,
      patch: {
        settable: { contentType: 'text/markdown' },
        customMetadata: { owner: 'beta' },
      },
      actAs: { mode: 'admin' },
    });
    await waitForEventCount(events, beforeMeta + 1);
    const betaMetaHit = await waitForRtdbValue<BucketLifecycleRecord>(
      observer,
      `lifecycleHits/onBetaMeta/${pathHex}`,
    );
    expect(betaMetaHit).toEqual({
      handler: 'onBetaMeta',
      kind: 'metadataUpdated',
      bucket: 'bucket-beta',
      dataBucket: 'bucket-beta',
      name: sharedPath,
      generation: betaGen1,
      metageneration: '2',
      size: '7',
      contentType: 'text/markdown',
      hasTimeDeleted: false,
      hasMetadata: true,
      metadata: { owner: 'beta' },
    });
    expect(await observer.rtdb.get(`lifecycleHits/onAlphaMeta/${pathHex}`)).toBeNull();
    expect(await observer.rtdb.get(`lifecycleHits/onDefaultMeta/${pathHex}`)).toBeNull();

    // 2. Overwrite on bucket-beta triggers onBetaArchived + onBucketBeta only.
    const beforeOverwrite = events.length;
    const betaV2 = await clientUploadBytes(
      clientRef(betaStorage, sharedPath),
      Buffer.from('beta-v2-updated', 'utf8'),
      { contentType: 'text/plain' },
    );
    await waitForEventCount(events, beforeOverwrite + 2);
    const betaArchivedHit = await waitForRtdbValue<BucketLifecycleRecord>(
      observer,
      `lifecycleHits/onBetaArchived/${pathHex}`,
    );
    expect(betaArchivedHit).toMatchObject({
      handler: 'onBetaArchived',
      kind: 'archived',
      bucket: 'bucket-beta',
      dataBucket: 'bucket-beta',
      name: sharedPath,
      generation: betaGen1,
      metageneration: '2',
      size: '7',
      contentType: 'text/markdown',
      hasTimeDeleted: false,
    });
    expect(await observer.rtdb.get(`lifecycleHits/onAlphaArchived/${pathHex}`)).toBeNull();
    expect(await observer.rtdb.get(`lifecycleHits/onDefaultArchived/${pathHex}`)).toBeNull();

    // 3. Delete on bucket-beta triggers onBetaDeleted only; alpha & default stay intact.
    const beforeDelete = events.length;
    await clientDeleteObject(clientRef(betaStorage, sharedPath));
    await waitForEventCount(events, beforeDelete + 1);
    const betaDeletedHit = await waitForRtdbValue<BucketLifecycleRecord>(
      observer,
      `lifecycleHits/onBetaDeleted/${pathHex}`,
    );
    expect(betaDeletedHit).toMatchObject({
      handler: 'onBetaDeleted',
      kind: 'deleted',
      bucket: 'bucket-beta',
      dataBucket: 'bucket-beta',
      name: sharedPath,
      generation: betaV2.metadata.generation,
      metageneration: '1',
      size: '15',
      contentType: 'text/plain',
      hasTimeDeleted: true,
    });
    expect(await observer.rtdb.get(`lifecycleHits/onAlphaDeleted/${pathHex}`)).toBeNull();
    expect(await observer.rtdb.get(`lifecycleHits/onDefaultDeleted/${pathHex}`)).toBeNull();
  }, 25_000);
});
