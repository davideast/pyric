import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildChildEnv, registerModuleUrl } from '../../src/cli/sandbox-runner.js';
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
  abortRouteUpload,
  beginRouteUpload,
  byteRouteOf,
  commitUpload,
  deleteObject as clientDeleteObject,
  getStorage as getClientStorage,
  ref as clientRef,
  rollBackUpload,
  sendRouteSlice,
  uploadBlobOf,
  uploadBytesResumable as clientUploadBytesResumable,
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

interface LifecycleEventRecord {
  seq: number;
  kind: 'finalized' | 'metadataUpdated' | 'archived' | 'deleted';
  id: string;
  type: string;
  time: string;
  bucket: string;
  subject: string;
  name: string;
  size: string;
  generation: string;
  metageneration: string;
  timeCreated: string;
  updated: string;
  hasTimeDeleted: boolean;
  timeDeleted?: string;
  hasMetadata: boolean;
  metadata?: Record<string, string>;
  md5Hash: string;
  crc32c: string;
  contentType: string;
  downloadedText?: string;
}

async function waitForLogLength(
  sandbox: RemoteSandbox,
  rtdbPath: string,
  expectedLength: number,
): Promise<LifecycleEventRecord[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const entries = await readLogEntries(sandbox, rtdbPath);
    if (entries.length >= expectedLength) return entries;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
  }
  throw new Error(`timed out waiting for ${expectedLength} lifecycle events at ${rtdbPath}`);
}

async function readLogEntries(
  sandbox: RemoteSandbox,
  rtdbPath: string,
): Promise<LifecycleEventRecord[]> {
  const raw = (await sandbox.rtdb.get(rtdbPath)) as Record<string, LifecycleEventRecord> | null;
  if (raw === null) return [];
  return Object.values(raw).sort((a, b) => a.seq - b.seq);
}

describe('v2 Storage lifecycle triggers (deleted, metadataUpdated, archived, rollback safety) on HostedRuntime', () => {
  const tempDirs = trackTempDirs('pyric-fn-storage-lifecycle-');
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
    writeFileSync(join(fixtureDir, 'public/index.html'), '<!doctype html><body>lifecycle</body>');
    writeFileSync(
      join(fixtureDir, 'firebase.json'),
      JSON.stringify({ hosting: { public: 'public' } }),
    );
    writeFileSync(
      join(fixtureDir, 'functions/package.json'),
      JSON.stringify({ name: 'storage-fn-lifecycle', private: true, type: 'commonjs' }),
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
        '  onObjectArchived,',
        '  onObjectDeleted,',
        "} = require('firebase-functions/v2/storage');",
        '',
        'function ensureAdmin() {',
        '  if (getApps().length === 0) initializeApp();',
        '}',
        '',
        'let seq = 0;',
        'async function recordEvent(kind, event, tryDownload) {',
        '  ensureAdmin();',
        '  seq += 1;',
        '  const currentSeq = seq;',
        '  let downloadedText = null;',
        '  if (tryDownload) {',
        '    const [bytes] = await getStorage()',
        '      .bucket(event.data.bucket)',
        '      .file(event.data.name)',
        '      .download();',
        "    downloadedText = bytes.toString('utf8');",
        '  }',
        "  const safePath = event.data.name.replace(/[^a-zA-Z0-9_-]/g, '_');",
        '  const entry = {',
        '    seq: currentSeq,',
        '    kind,',
        '    id: event.id,',
        '    type: event.type,',
        '    time: event.time,',
        '    bucket: event.bucket,',
        '    subject: event.subject,',
        '    name: event.data.name,',
        '    size: event.data.size,',
        '    generation: event.data.generation,',
        '    metageneration: event.data.metageneration,',
        '    timeCreated: event.data.timeCreated,',
        '    updated: event.data.updated,',
        "    hasTimeDeleted: Object.prototype.hasOwnProperty.call(event.data, 'timeDeleted'),",
        "    hasMetadata: Object.prototype.hasOwnProperty.call(event.data, 'metadata'),",
        '    md5Hash: event.data.md5Hash,',
        '    crc32c: event.data.crc32c,',
        '    contentType: event.data.contentType,',
        '  };',
        '  if (event.data.timeDeleted !== undefined) entry.timeDeleted = event.data.timeDeleted;',
        '  if (event.data.metadata !== undefined) entry.metadata = event.data.metadata;',
        '  if (downloadedText !== null) entry.downloadedText = downloadedText;',
        "  await getDatabase().ref('byPath/' + safePath + '/e' + String(currentSeq).padStart(4, '0')).set(entry);",
        '}',
        '',
        'exports.onFinalized = onObjectFinalized((event) => recordEvent("finalized", event, true));',
        'exports.onMetadataUpdated = onObjectMetadataUpdated((event) => recordEvent("metadataUpdated", event, true));',
        'exports.onArchived = onObjectArchived((event) => recordEvent("archived", event, false));',
        'exports.onDeleted = onObjectDeleted((event) => recordEvent("deleted", event, false));',
        '',
        'exports.adminCommands = onValueCreated("/adminCommands/{cmdId}", async (event) => {',
        '  ensureAdmin();',
        '  const cmd = event.data.val();',
        '  const file = getStorage().bucket().file(cmd.path);',
        '  if (cmd.action === "setMetadata") {',
        '    const patch = Object.assign({}, cmd.patch || {});',
        '    if (Array.isArray(cmd.clearKeys)) {',
        '      patch.metadata = Object.assign({}, patch.metadata || {});',
        '      for (const key of cmd.clearKeys) patch.metadata[key] = null;',
        '    }',
        '    await file.setMetadata(patch);',
        '  } else if (cmd.action === "save") {',
        "    await file.save(Buffer.from(cmd.text, 'utf8'), {",
        '      contentType: cmd.contentType,',
        '      metadata: cmd.metadata || undefined,',
        '    });',
        '  } else if (cmd.action === "delete") {',
        '    await file.delete();',
        '  }',
        '  await getDatabase().ref("adminCommandDone/" + event.params.cmdId).set(true);',
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
    });

    const ready = await activeChild.ready;
    expect(ready).toEqual({
      triggerCount: 5,
      unsupportedTriggers: [],
    });
  }, 30_000);

  afterAll(async () => {
    if (activeChild) await activeChild.stop();
    observer?.close();
    if (hosted) await hosted.stop();
    tempDirs.cleanupTempDirs();
  });

  test('emits metadataUpdated, archived + finalized on overwrite, and deleted across client, host, and firebase-admin', async () => {
    if (!hosted || !observer) throw new Error('hosted runtime not initialized');
    const objectPath = 'lifecycle/docs/spec.txt';
    const logPath = 'byPath/lifecycle_docs_spec_txt';

    // 1. Initial upload v1 -> finalized only.
    const v1Text = 'spec-v1';
    const v1Bytes = Buffer.from(v1Text, 'utf8');
    await observer.storage.putBytes(objectPath, v1Bytes, {
      contentType: 'text/plain',
      metadata: { customMetadata: { stage: 'draft', reviewer: 'ada' } },
    });

    let entries = await waitForLogLength(observer, logPath, 1);
    const created = entries[0];
    if (created === undefined) throw new Error('missing created event');
    expect(created).toMatchObject({
      kind: 'finalized',
      type: 'google.cloud.storage.object.v1.finalized',
      bucket: 'demo-project.appspot.com',
      subject: `objects/${objectPath}`,
      name: objectPath,
      size: String(v1Bytes.byteLength),
      metageneration: '1',
      hasTimeDeleted: false,
      hasMetadata: true,
      metadata: { stage: 'draft', reviewer: 'ada' },
      md5Hash: computeMd5Base64(v1Bytes),
      crc32c: computeCrc32cBase64(v1Bytes),
      contentType: 'text/plain',
      downloadedText: v1Text,
    });
    expect(created.timeDeleted).toBeUndefined();
    const g1 = created.generation;

    // 2a. Host storage.setMetadata patching contentType, updating stage, and removing reviewer with null.
    await observer.channel.op({
      method: 'storage.setMetadata',
      path: objectPath,
      patch: {
        settable: { contentType: 'text/markdown' },
        customMetadata: { stage: 'reviewed', reviewer: null },
      },
      actAs: { mode: 'admin' },
    });

    entries = await waitForLogLength(observer, logPath, 2);
    const meta1 = entries[1];
    if (meta1 === undefined) throw new Error('missing first metadataUpdated event');
    expect(meta1).toMatchObject({
      kind: 'metadataUpdated',
      type: 'google.cloud.storage.object.v1.metadataUpdated',
      generation: g1,
      metageneration: '2',
      size: String(v1Bytes.byteLength),
      timeCreated: created.timeCreated,
      hasTimeDeleted: false,
      hasMetadata: true,
      metadata: { stage: 'reviewed' },
      md5Hash: computeMd5Base64(v1Bytes),
      crc32c: computeCrc32cBase64(v1Bytes),
      contentType: 'text/markdown',
      downloadedText: v1Text,
    });
    expect(meta1.timeDeleted).toBeUndefined();

    // 2b. firebase-admin file.setMetadata clearing the last custom key with null -> omits event.data.metadata.
    await observer.rtdb.set('adminCommands/clearMeta', {
      action: 'setMetadata',
      path: objectPath,
      clearKeys: ['stage'],
    });
    await waitForRtdbValue<boolean>(observer, 'adminCommandDone/clearMeta');

    entries = await waitForLogLength(observer, logPath, 3);
    const meta2 = entries[2];
    if (meta2 === undefined) throw new Error('missing second metadataUpdated event');
    expect(meta2).toMatchObject({
      kind: 'metadataUpdated',
      type: 'google.cloud.storage.object.v1.metadataUpdated',
      generation: g1,
      metageneration: '3',
      size: String(v1Bytes.byteLength),
      hasTimeDeleted: false,
      hasMetadata: false,
      downloadedText: v1Text,
    });
    expect(meta2.metadata).toBeUndefined();

    // 3. Overwrite v1 with v2 via firebase-admin file.save() -> archived(g1) then finalized(g2).
    const v2Text = 'spec-v2-published';
    const v2Bytes = Buffer.from(v2Text, 'utf8');
    await observer.rtdb.set('adminCommands/overwriteV2', {
      action: 'save',
      path: objectPath,
      text: v2Text,
      contentType: 'text/plain',
      metadata: { metadata: { edition: '2' } },
    });
    await waitForRtdbValue<boolean>(observer, 'adminCommandDone/overwriteV2');

    entries = await waitForLogLength(observer, logPath, 5);
    const archived = entries[3];
    const finalizedV2 = entries[4];
    if (archived === undefined || finalizedV2 === undefined) {
      throw new Error('missing archived + finalized pair');
    }
    expect(archived).toMatchObject({
      kind: 'archived',
      type: 'google.cloud.storage.object.v1.archived',
      generation: g1,
      metageneration: '3',
      size: String(v1Bytes.byteLength),
      hasTimeDeleted: false,
      hasMetadata: false,
      md5Hash: computeMd5Base64(v1Bytes),
      crc32c: computeCrc32cBase64(v1Bytes),
    });
    expect(archived.timeDeleted).toBeUndefined();
    const g2 = finalizedV2.generation;
    expect(g2).not.toBe(g1);
    expect(finalizedV2).toMatchObject({
      kind: 'finalized',
      type: 'google.cloud.storage.object.v1.finalized',
      generation: g2,
      metageneration: '1',
      size: String(v2Bytes.byteLength),
      hasTimeDeleted: false,
      hasMetadata: true,
      metadata: { edition: '2' },
      md5Hash: computeMd5Base64(v2Bytes),
      crc32c: computeCrc32cBase64(v2Bytes),
      contentType: 'text/plain',
      downloadedText: v2Text,
    });

    // 4. Delete v2 via client deleteObject -> deleted(g2) with timeDeleted; missing delete emits 0 triggers.
    const clientPort = createChannelClientPort(observer, {
      baseUrl: hosted.url,
      sessionToken: hosted.sessionToken,
    });
    const clientStorage = getClientStorage({
      __kind: 'client-db',
      type: 'firestore',
      port: clientPort,
    });
    await clientDeleteObject(clientRef(clientStorage, objectPath));

    entries = await waitForLogLength(observer, logPath, 6);
    const deleted = entries[5];
    if (deleted === undefined) throw new Error('missing deleted event');
    expect(deleted).toMatchObject({
      kind: 'deleted',
      type: 'google.cloud.storage.object.v1.deleted',
      generation: g2,
      metageneration: '1',
      size: String(v2Bytes.byteLength),
      hasTimeDeleted: true,
      timeDeleted: deleted.time,
      hasMetadata: true,
      metadata: { edition: '2' },
      md5Hash: computeMd5Base64(v2Bytes),
      crc32c: computeCrc32cBase64(v2Bytes),
    });
    expect(Number.isNaN(Date.parse(deleted.timeDeleted ?? ''))).toBe(false);

    // Deleting a non-existent path rejects and emits zero triggers.
    await expect(
      clientDeleteObject(clientRef(clientStorage, 'lifecycle/docs/does-not-exist.txt')),
    ).rejects.toMatchObject({ code: 'storage/object-not-found' });

    // Also verify firebase-admin file.delete() emits onObjectDeleted cleanly.
    const adminDelPath = 'lifecycle/docs/admin-del.txt';
    await observer.storage.putBytes(adminDelPath, Buffer.from('bye-admin', 'utf8'), {
      contentType: 'text/plain',
    });
    await waitForLogLength(observer, 'byPath/lifecycle_docs_admin-del_txt', 1);
    await observer.rtdb.set('adminCommands/deleteViaAdmin', {
      action: 'delete',
      path: adminDelPath,
    });
    await waitForRtdbValue<boolean>(observer, 'adminCommandDone/deleteViaAdmin');
    const adminDelEntries = await waitForLogLength(observer, 'byPath/lifecycle_docs_admin-del_txt', 2);
    expect(adminDelEntries[1]?.kind).toBe('deleted');
    expect(adminDelEntries[1]?.hasTimeDeleted).toBe(true);
  }, 25_000);

  test('does not emit spurious triggers on abortUpload, canceled uploadBytesResumable, or rollbackUpload', async () => {
    if (!hosted || !observer) throw new Error('hosted runtime not initialized');

    const clientPort = createChannelClientPort(observer, {
      baseUrl: hosted.url,
      sessionToken: hosted.sessionToken,
    });
    const clientStorage = getClientStorage({
      __kind: 'client-db',
      type: 'firestore',
      port: clientPort,
    });

    // 1. Staged route upload with uploaded slice aborted via storage.abortUpload -> 0 events.
    const stagedRef = clientRef(clientStorage, 'lifecycle/cancel/aborted-staged.bin');
    const route = byteRouteOf(stagedRef);
    if (route === undefined) throw new Error('expected byte route on hosted client port');
    const stagedBlob = uploadBlobOf(Buffer.from('aborted-staged-upload', 'utf8'));
    const stagedUpload = await beginRouteUpload(
      stagedRef,
      route,
      stagedBlob.size,
      'application/octet-stream',
      undefined,
    );
    await sendRouteSlice(stagedUpload, stagedBlob, 0);
    await abortRouteUpload(stagedUpload);

    // 2. Client uploadBytesResumable canceled over HostedRuntime HTTP byte route -> 0 events.
    const resumableBytes = new Uint8Array(512 * 1024);
    resumableBytes.fill(0x61);
    const task = clientUploadBytesResumable(
      clientRef(clientStorage, 'lifecycle/cancel/resumable-canceled.bin'),
      resumableBytes,
      { contentType: 'application/octet-stream' },
    );
    expect(task.cancel()).toBe(true);
    const canceledError = await task.then(
      () => null,
      (error: unknown) => error,
    );
    expect(canceledError).toMatchObject({ code: 'storage/canceled' });

    // 3. storage.rollbackUpload on a newly committed upload -> rollback delete emits 0 deleted events.
    const rbNewPath = 'lifecycle/cancel/rb-new.txt';
    const rbNewLog = 'byPath/lifecycle_cancel_rb-new_txt';
    const rbNewRef = clientRef(clientStorage, rbNewPath);
    const committedNew = await commitUpload(
      rbNewRef,
      Buffer.from('raced-new', 'utf8'),
      { contentType: 'text/plain' },
      true,
    );
    if (committedNew.rollbackToken === undefined) {
      throw new Error('expected rollbackToken on committedNew');
    }
    await waitForLogLength(observer, rbNewLog, 1);
    await rollBackUpload(rbNewRef, committedNew.rollbackToken);

    // 4. storage.rollbackUpload on an overwritten upload -> restoring v1 emits 0 spurious finalized/archived/deleted events!
    const rbOverwritePath = 'lifecycle/cancel/rb-overwrite.txt';
    const rbOverwriteLog = 'byPath/lifecycle_cancel_rb-overwrite_txt';
    const rbOverwriteRef = clientRef(clientStorage, rbOverwritePath);
    await observer.storage.putBytes(rbOverwritePath, Buffer.from('keep-v1', 'utf8'), {
      contentType: 'text/plain',
      metadata: { customMetadata: { kept: 'yes' } },
    });
    const seedEntries = await waitForLogLength(observer, rbOverwriteLog, 1);
    const v1Generation = seedEntries[0]?.generation;

    const committedOverwrite = await commitUpload(
      rbOverwriteRef,
      Buffer.from('raced-v2-canceled', 'utf8'),
      { contentType: 'text/plain' },
      true,
    );
    if (committedOverwrite.rollbackToken === undefined) {
      throw new Error('expected rollbackToken on committedOverwrite');
    }
    // The commit before rollback produced archived(v1) + finalized(v2) -> total 3 entries so far.
    await waitForLogLength(observer, rbOverwriteLog, 3);
    await rollBackUpload(rbOverwriteRef, committedOverwrite.rollbackToken);

    // Write a sentinel object afterwards and wait for its trigger so we know the FIFO subscription
    // stream flushed past all four cancel/rollback operations without emitting anything for them!
    await observer.storage.putBytes(
      'lifecycle/cancel/sentinel-after.txt',
      Buffer.from('sentinel', 'utf8'),
      { contentType: 'text/plain' },
    );
    await waitForLogLength(observer, 'byPath/lifecycle_cancel_sentinel-after_txt', 1);

    expect(await readLogEntries(observer, 'byPath/lifecycle_cancel_aborted-staged_bin')).toEqual([]);
    expect(await readLogEntries(observer, 'byPath/lifecycle_cancel_resumable-canceled_bin')).toEqual([]);

    const finalNewEntries = await readLogEntries(observer, rbNewLog);
    expect(finalNewEntries.map((item) => item.kind)).toEqual(['finalized']);
    await expect(observer.storage.getBytes(rbNewPath)).rejects.toThrow();

    const finalOverwriteEntries = await readLogEntries(observer, rbOverwriteLog);
    expect(finalOverwriteEntries.map((item) => item.kind)).toEqual([
      'finalized',
      'archived',
      'finalized',
    ]);
    const restoredBytes = await observer.storage.getBytes(rbOverwritePath);
    expect(restoredBytes.toString('utf8')).toBe('keep-v1');
    const restoredMeta = await observer.storage.getMetadata(rbOverwritePath);
    expect(restoredMeta.generation).toBe(v1Generation);
  }, 25_000);
});
