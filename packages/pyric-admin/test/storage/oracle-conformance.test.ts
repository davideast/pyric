/**
 * Oracle conformance suite for the `storage-admin` surface: `pyric-admin/storage`
 * `File` metadata and `getDownloadURL`. One assertion set per registry row,
 * replaying the production capture `admin-storage-metadata-download-url`.
 *
 * Each set runs on two arms: the in-process sandbox, and a remote handle on a
 * SharedWorker host (the real worker host behind the bridge). Neither serves
 * bytes over HTTP, so their download URLs are `data:` URIs; where that differs
 * from production the set pins both sides. The Node host, which serves the
 * HTTP URL, replays the same capture in `packages/cli/test/serve/hosted-sqlite.test.ts`.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getStorageSandbox } from 'pyric/storage';
import { createObservationGate } from '../../../../packages/conformance/src/observation-gate.ts';
import { createBridge, type Bridge } from '../../../cli/src/bridge/server/bridge.js';
import { createConsumerSession } from '../../../cli/src/bridge/server/peer.js';
import { WORKER_RELAY_CAPABILITY, type BridgeMessage } from '../../../cli/src/bridge/protocol.js';
import { createRemoteSandboxCore, createRemoteSandboxHandle } from '../../../cli/src/remote/index.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../cli/src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../cli/src/serve/worker/protocol.js';
import { deleteApp, getApps, initializeApp, type PyricAdminApp } from '../../src/app/index.js';
import { getDownloadURL, getStorage, type File } from '../../src/storage/index.js';

const OBS_DIR = join(import.meta.dir, '..', '..', '..', 'conformance', 'observations', 'storage-admin');

/** Observations that cannot be replayed against the pyric-admin sandbox, with the reason. */
const NOT_APPLICABLE: Record<string, string> = {};

const obsGate = createObservationGate({
  dir: OBS_DIR,
  match: (f) => f.startsWith('admin-storage-'),
  notApplicable: NOT_APPLICABLE,
});

const production = () => obsGate.load('admin-storage-metadata-download-url');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BYTES = Buffer.from(Array.from({ length: 64 }, (_, index) => index));

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

// ─── Arms ──────────────────────────────────────────────────────────────────

const OPEN_RULES = `
service firebase.storage {
  match /{allPaths=**} {
    allow read, write: if true;
  }
}`;

const overWire = <T>(frame: T): T => JSON.parse(JSON.stringify(frame)) as T;

let sequence = 0;

/** A remote handle on a SharedWorker host: the real worker host behind the bridge, frames JSON round-tripped. */
function sharedWorkerApp(): PyricAdminApp {
  const sandbox = initializeSandbox();
  getStorageSandbox(sandbox, { dbName: `storage-admin-oracle-${++sequence}-${Math.random().toString(36).slice(2, 8)}`, rules: OPEN_RULES });
  const ctx: HostCtx = { db: getFirestore(sandbox), sandbox, instanceId: 'storage-admin-oracle', subs: new Map() };
  const bridge: Bridge = createBridge({ mode: 'sandbox', version: 'test' });
  let generation = 0;
  const tab: PortLike = {
    postMessage(raw: unknown) {
      const message = raw as OutboundMessage;
      if (message.t !== 'res') return;
      const reply = message.ok
        ? { type: 'worker-res', id: message.id, ok: true, value: message.value }
        : { type: 'worker-res', id: message.id, ok: false, error: message.error };
      bridge.handleSandboxMessage(overWire(reply) as BridgeMessage, generation);
    },
  };
  bridge.registerSandboxPeer((message: BridgeMessage) => {
    if (generation === 0) generation = bridge.peerGeneration();
    const wire = overWire(message);
    if (wire.type === 'worker-op') void handleMessage(ctx, tab, { ...wire.op, t: 'op', id: wire.id } as InboundMessage);
  }, [], 'fake-tab', [WORKER_RELAY_CAPABILITY]);
  let deliver: (message: BridgeMessage) => void = () => {};
  const session = createConsumerSession(bridge, (message) => deliver(overWire(message)));
  const core = createRemoteSandboxCore({ send: (message) => session.handleMessage(overWire(message)) }, { serveUrl: 'http://localhost:5000' });
  deliver = core.handleMessage;
  core.start();
  const remote = createRemoteSandboxHandle({ channel: core.channel, serveUrl: 'http://localhost:5000', close: () => core.dispose('closed') });
  return initializeApp({ sandbox: remote }, `storage-admin-shared-worker-${sequence}`);
}

const ARMS: Array<[string, () => PyricAdminApp]> = [
  ['in-process', () => initializeApp({ sandbox: initializeSandbox() }, `storage-admin-local-${++sequence}`)],
  ['SharedWorker host', sharedWorkerApp],
];

async function savedFile(app: PyricAdminApp): Promise<File> {
  const file = getStorage(app).bucket().file('pyric_oracle/admin_storage/take one.wav');
  await file.save(BYTES, { contentType: 'audio/wav' });
  return file;
}

// ─── One assertion set per row ─────────────────────────────────────────────

describe.each(ARMS)('storage-admin conformance, %s', (_arm, open) => {
  it('storage-admin#1: setMetadata stores custom metadata, getMetadata returns it under metadata', async () => {
    const observed = production();
    const file = await savedFile(open());
    const [afterSave] = await file.getMetadata();
    expect(afterSave.metadata ?? null).toEqual(observed.afterSave.customMetadata);
    const [set] = await file.setMetadata({ metadata: { note: 'first' } });
    expect(set.metadata !== undefined).toBe(observed.setMetadataResolvesWithMetadata);
    const [afterSet] = await file.getMetadata();
    expect(afterSet.metadata?.note).toBe(observed.afterSet.customMetadata.note);
    expect(Number(afterSet.metageneration) > Number(afterSave.metageneration)).toBe(observed.afterSet.metagenerationAdvanced);
  });

  it('storage-admin#2: a custom key set to null is removed, the others stay', async () => {
    const observed = production();
    const file = await savedFile(open());
    await file.setMetadata({ metadata: { note: 'first', firebaseStorageDownloadTokens: 'token-kept' } });
    await file.setMetadata({ metadata: { note: null } });
    const [after] = await file.getMetadata();
    expect(!Object.prototype.hasOwnProperty.call(after.metadata ?? {}, 'note')).toBe(observed.nullRemovesKey.noteRemoved);
    expect(after.metadata?.firebaseStorageDownloadTokens === 'token-kept').toBe(observed.nullRemovesKey.tokenKept);
  });

  it('storage-admin#3: getDownloadURL (divergence: a data: URI here, production an https URL with the token)', async () => {
    const observed = production();
    // Production's form, from the capture.
    expect(observed.downloadURL.origin).toBe('https://firebasestorage.googleapis.com');
    expect(observed.downloadURL.pathForm).toBe('/v0/b/<bucket>/o/<encoded path>');
    expect(observed.downloadURL.alt).toBe('media');
    expect(observed.downloadURL.queryKeys).toEqual(['alt', 'token']);
    expect(observed.downloadURL.tokenEqualsStored).toBe(true);
    expect(observed.firebaseMetadataEndpoint.downloadTokensEqualsSet).toBe(true);
    expect(observed.firebaseMetadataEndpoint.metadataHasTokenKey).toBe(false);
    expect(observed.firebaseMetadataEndpoint.customMetadataKeys).toEqual(['note']);
    // The sandbox's: no HTTP origin, so the URL carries the bytes.
    const file = await savedFile(open());
    const url = await getDownloadURL(file);
    expect(url.startsWith('data:audio/wav;base64,')).toBe(true);
    expect(Buffer.from(await (await fetch(url)).arrayBuffer()).equals(BYTES)).toBe(true);
  });

  it('storage-admin#4: getDownloadURL mints a UUID token into firebaseStorageDownloadTokens', async () => {
    const observed = production();
    const file = await savedFile(open());
    const [before] = await file.getMetadata();
    expect(Boolean(before.metadata?.firebaseStorageDownloadTokens)).toBe(observed.afterSave.hasDownloadTokens);
    let threw = false;
    try { await getDownloadURL(file); } catch { threw = true; }
    expect(threw).toBe(observed.getDownloadURLWithoutToken.threw);
    const [after] = await file.getMetadata();
    const minted = after.metadata?.firebaseStorageDownloadTokens;
    expect(typeof minted === 'string' && minted.length > 0).toBe(observed.getDownloadURLWithoutToken.mintsTokenIntoMetadata);
    expect(UUID.test(String(minted))).toBe(observed.getDownloadURLWithoutToken.mintedTokenIsUuid);
    // The same token is kept: a second call mints nothing.
    await getDownloadURL(file);
    expect((await file.getMetadata())[0].metadata?.firebaseStorageDownloadTokens).toBe(minted);
  });

  it('storage-admin#5: removing the token revokes it and the next call mints another (divergence: a data: URI cannot be revoked)', async () => {
    const observed = production();
    const file = await savedFile(open());
    const revokedUrl = await getDownloadURL(file);
    const [minted] = await file.getMetadata();
    await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: null } });
    const [after] = await file.getMetadata();
    expect(!Object.prototype.hasOwnProperty.call(after.metadata ?? {}, 'firebaseStorageDownloadTokens')).toBe(observed.revocation.tokenRemoved);
    await getDownloadURL(file);
    const [reminted] = await file.getMetadata();
    const next = reminted.metadata?.firebaseStorageDownloadTokens;
    expect(typeof next === 'string' && next !== minted.metadata?.firebaseStorageDownloadTokens).toBe(observed.revocation.getDownloadURLAfterRevoke.mintsNewToken);
    // Production answers the revoked URL 403; a data: URI still resolves.
    expect(observed.revocation.revokedUrlStatus).toBe(403);
    expect((await fetch(revokedUrl)).status).toBe(200);
  });

  it('storage-admin#6: the URL serves the bytes and content type (divergence: a data: URI ignores Range)', async () => {
    const observed = production();
    const file = await savedFile(open());
    const url = await getDownloadURL(file);
    const whole = await fetch(url);
    expect(whole.status).toBe(observed.unauthenticatedGet.status);
    expect(whole.headers.get('content-type')).toBe(observed.unauthenticatedGet.contentType);
    expect(Buffer.from(await whole.arrayBuffer()).equals(BYTES)).toBe(observed.unauthenticatedGet.bytesMatch);
    // Production answers a Range request with 206; a data: URI answers 200 with every byte.
    expect(observed.rangeGet.status).toBe(206);
    expect(observed.rangeGet.contentRange).toBe('bytes 2-5/64');
    expect(observed.rangeGet.bytesMatch).toBe(true);
    const ranged = await fetch(url, { headers: { range: 'bytes=2-5' } });
    expect(ranged.status).toBe(200);
    expect(Buffer.from(await ranged.arrayBuffer()).byteLength).toBe(BYTES.byteLength);
  });
});

describe('storage-admin observations', () => {
  it('every admin-storage observation is asserted or explicitly not applicable', () => {
    const report = obsGate.report();
    expect(report.committed.length).toBeGreaterThanOrEqual(1);
    expect(report.loadedButUnused).toEqual([]);
    expect(report.uncovered).toEqual([]);
  });
});
