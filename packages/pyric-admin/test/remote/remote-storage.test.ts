/**
 * `pyric-admin` remote-dispatch arm — Storage (remote sandbox, slice 2).
 *
 * Same headless harness as remote-dispatch.test.ts (REAL worker host behind
 * the REAL bridge core + the EXACT production handle from
 * `createRemoteSandboxHandle`) with ONE deliberate upgrade: every frame on
 * BOTH relay legs (Node ⇄ bridge, bridge ⇄ tab) is round-tripped through
 * `JSON.parse(JSON.stringify(frame))` — modelling the two WS legs that the
 * slice-1 in-process pipe skipped. This is the binary-corruption regression
 * seam: a Blob/TypedArray smuggled into a frame would be mangled here
 * exactly as it would on the wire, so byte-equality assertions after the
 * round-trip prove the base64 encoding is what keeps bytes faithful.
 *
 * Coverage (per the slice-2 spike test plan):
 *   - save → download round-trip of non-UTF8 binary, byte-for-byte
 *   - contentType/metadata via save options (read back via the worker)
 *   - exists / delete / idempotent re-delete; `No such object` parity
 *   - cross-visibility with an independent direct worker port (one store)
 *   - 8 MiB cap: client-side rejection before send + host-side rejection
 *   - non-default bucket / resumable / stream remediating throws
 *   - getSignedUrl stub byte-identical to the local arm
 *   - deny-all page rules bypassed by the pinned admin lens
 *   - no-peer fail-fast through the storage API
 *   - the local in-process arm still selected for plain sandboxes
 *   - conformance: the same consumer assertions pass on BOTH arms
 */

import 'fake-indexeddb/auto';
import { afterEach, describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getStorageSandbox } from 'pyric/storage';

import { createBridge, type Bridge } from '../../../cli/src/bridge/server/bridge.js';
import { createConsumerSession } from '../../../cli/src/bridge/server/peer.js';
import {
  WORKER_RELAY_CAPABILITY,
  type BridgeMessage,
} from '../../../cli/src/bridge/protocol.js';
import {
  createRemoteSandboxCore,
  createRemoteSandboxHandle,
  type RemoteSandbox,
} from '../../../cli/src/remote/index.js';
import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../../cli/src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
} from '../../../cli/src/serve/worker/protocol.js';
import {
  bytesToBase64,
  MAX_STORAGE_OP_BYTES,
} from '../../../cli/src/serve/worker/protocol.js';

import { initializeApp, deleteApp, getApps } from '../../src/app/index.js';
import { getStorage, type Storage } from '../../src/storage/index.js';

// ─── Harness (remote-dispatch.test.ts's, + JSON round-trips on both legs) ──

const SERVE_URL = 'http://localhost:5000';

const DENY_ALL_RULES = `
service firebase.storage {
  match /{allPaths=**} {
    allow read, write: if false;
  }
}`;

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

/** Model a WS leg: the frame must survive JSON serialization VERBATIM. */
function overWire<T>(frame: T): T {
  return JSON.parse(JSON.stringify(frame)) as T;
}

let dbSeq = 0;
function makeWorkerCtx(opts: { rules?: string } = {}): HostCtx {
  const sandbox = initializeSandbox();
  // Isolate this ctx's storage store (fake-indexeddb's default DB name is
  // process-global) and configure the PAGE's rules when the test needs them
  // — first-call-per-sandbox, exactly how a served page configures rules.
  getStorageSandbox(sandbox, {
    dbName: `pyric-admin-remote-storage-${++dbSeq}-${Math.random().toString(36).slice(2, 8)}`,
    ...(opts.rules ? { rules: opts.rules } : {}),
  });
  return {
    db: getFirestore(sandbox),
    sandbox,
    instanceId: 'admin-remote-storage-test',
    subs: new Map(),
  };
}

/** Fake browser tab backed by the REAL worker host. Frames cross this leg
 *  through a JSON round-trip in BOTH directions (the bridge⇄tab WS). */
function connectTab(bridge: Bridge, ctx: HostCtx): void {
  let gen = 0;
  const port: PortLike = {
    postMessage(raw: unknown) {
      const m = raw as OutboundMessage;
      if (m.t === 'res') {
        bridge.handleSandboxMessage(
          overWire(
            m.ok
              ? { type: 'worker-res', id: m.id, ok: true, value: m.value }
              : { type: 'worker-res', id: m.id, ok: false, error: m.error },
          ) as BridgeMessage,
          gen,
        );
      } else if (m.t === 'snap') {
        bridge.handleSandboxMessage(
          overWire({ type: 'worker-snap', subId: m.subId, value: m.value }) as BridgeMessage,
          gen,
        );
      }
    },
  };
  const send = (msg: BridgeMessage): void => {
    if (gen === 0) gen = bridge.peerGeneration();
    const wire = overWire(msg);
    if (wire.type === 'worker-op') {
      void handleMessage(ctx, port, { ...wire.op, t: 'op', id: wire.id } as InboundMessage);
    } else if (wire.type === 'worker-sub') {
      void handleMessage(ctx, port, { ...wire.sub, t: 'sub', subId: wire.subId } as InboundMessage);
    } else if (wire.type === 'worker-unsub') {
      void handleMessage(ctx, port, { t: 'unsub', subId: wire.subId } as InboundMessage);
    }
  };
  bridge.registerSandboxPeer(send, [], 'fake-tab', [WORKER_RELAY_CAPABILITY]);
}

/** The EXACT production remote handle, with the Node⇄bridge leg JSON
 *  round-tripped in both directions. */
function connectRemote(bridge: Bridge): RemoteSandbox {
  let handleMsg: (msg: BridgeMessage) => void = () => {};
  const session = createConsumerSession(bridge, (msg) => handleMsg(overWire(msg)));
  const core = createRemoteSandboxCore(
    { send: (msg) => session.handleMessage(overWire(msg)) },
    { serveUrl: SERVE_URL },
  );
  handleMsg = core.handleMessage;
  core.start();
  return createRemoteSandboxHandle({
    channel: core.channel,
    serveUrl: SERVE_URL,
    close: () => core.dispose('remote sandbox connection closed by the client'),
  });
}

/** Independent direct worker port — the oracle proving admin operations
 *  really landed in the worker's store (and letting "the browser app"
 *  write from its side). */
let directOpSeq = 0;
function workerOp(ctx: HostCtx, op: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const port: PortLike = {
      postMessage(raw: unknown) {
        const m = raw as OutboundMessage;
        if (m.t !== 'res') return;
        if (m.ok) resolve(m.value);
        else reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
      },
    };
    void handleMessage(ctx, port, {
      ...op,
      t: 'op',
      id: `direct-${++directOpSeq}`,
    } as InboundMessage);
  });
}

function makeStack(opts: { rules?: string } = {}) {
  const bridge = createBridge({ mode: 'sandbox', version: 'test' });
  const ctx = makeWorkerCtx(opts);
  connectTab(bridge, ctx);
  const remote = connectRemote(bridge);
  const app = initializeApp({ sandbox: remote });
  return { bridge, ctx, remote, app };
}

/** Non-UTF8 binary (PNG magic + 0x00/0xFF runs) — the corruption payload. */
function binaryFixture(): Buffer {
  const bytes = Buffer.alloc(1024);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.fill(0x00, 8, 512);
  bytes.fill(0xff, 512, 1024);
  bytes[700] = 0x7f;
  return bytes;
}

// ─── Data plane ─────────────────────────────────────────────────────────────

describe('pyric-admin remote dispatch — Storage data plane', () => {
  it('save → download round-trips non-UTF8 binary byte-for-byte through JSON-round-tripped frames', async () => {
    const { app } = makeStack();
    const bucket = getStorage(app).bucket();
    const bytes = binaryFixture();

    await bucket.file('uploads/avatar.png').save(bytes, { contentType: 'image/png' });
    const [roundTripped] = await bucket.file('uploads/avatar.png').download();
    expect(Buffer.isBuffer(roundTripped)).toBe(true);
    expect(roundTripped.equals(bytes)).toBe(true);
  });

  it('save accepts string and Uint8Array inputs (local-arm input parity)', async () => {
    const { app } = makeStack();
    const bucket = getStorage(app).bucket();

    await bucket.file('reports/run-1.json').save('{"ok":true}', {
      contentType: 'application/json',
    });
    const [text] = await bucket.file('reports/run-1.json').download();
    expect(text.toString('utf8')).toBe('{"ok":true}');

    const raw = new Uint8Array([0, 255, 128, 1]);
    await bucket.file('raw/bytes').save(raw);
    const [back] = await bucket.file('raw/bytes').download();
    expect(Array.from(back)).toEqual([0, 255, 128, 1]);
  });

  it('contentType + metadata round-trip via save options (read back through the worker)', async () => {
    const { ctx, app } = makeStack();
    const bucket = getStorage(app).bucket();

    await bucket.file('docs/tagged.json').save(Buffer.from('{}'), {
      contentType: 'application/json',
      metadata: { cacheControl: 'no-store', metadata: { owner: 'ada' } },
    });

    const meta = (await workerOp(ctx, {
      method: 'storage.getMetadata',
      path: 'docs/tagged.json',
      actAs: { mode: 'admin' },
    })) as {
      contentType: string;
      cacheControl?: string;
      customMetadata?: Record<string, string>;
      size: number;
    };
    expect(meta.contentType).toBe('application/json');
    expect(meta.cacheControl).toBe('no-store');
    expect(meta.customMetadata).toEqual({ owner: 'ada' });
    expect(meta.size).toBe(2);
  });

  it('exists / delete / idempotent re-delete; missing download throws "No such object" (local parity)', async () => {
    const { app } = makeStack();
    const bucket = getStorage(app).bucket();
    const file = bucket.file('tmp/scratch');

    expect(await file.exists()).toEqual([false]);
    await file.save(Buffer.from('x'));
    expect(await file.exists()).toEqual([true]);

    await file.delete();
    expect(await file.exists()).toEqual([false]);
    await file.delete(); // idempotent — no throw

    await expect(file.download()).rejects.toThrow('No such object: pyric-default/tmp/scratch');
  });

  it('cross-visibility: a browser-side write (direct worker port) is readable via admin download, and vice versa', async () => {
    const { ctx, app } = makeStack();
    const bucket = getStorage(app).bucket();

    // "The browser app" uploads through its own port…
    await workerOp(ctx, {
      method: 'storage.putBytes',
      path: 'shared/from-browser.txt',
      dataB64: bytesToBase64(new TextEncoder().encode('hello from the page')),
      contentType: 'text/plain',
    });
    // …and the admin arm reads the SAME store.
    const [fromBrowser] = await bucket.file('shared/from-browser.txt').download();
    expect(fromBrowser.toString('utf8')).toBe('hello from the page');

    // Admin writes are visible to the browser side.
    await bucket.file('shared/from-admin.txt').save('hello from the server');
    const wire = (await workerOp(ctx, {
      method: 'storage.getBytes',
      path: 'shared/from-admin.txt',
    })) as { dataB64: string };
    expect(Buffer.from(wire.dataB64, 'base64').toString('utf8')).toBe('hello from the server');
  });

  it('getSignedUrl returns the deterministic local stub, byte-identical to the local arm', async () => {
    const { app } = makeStack();
    const remoteFile = getStorage(app).bucket().file('assets/logo.png');

    const localApp = initializeApp({ sandbox: initializeSandbox() }, `local-${Date.now()}`);
    const localFile = getStorage(localApp).bucket().file('assets/logo.png');

    const options = { action: 'read' as const, expires: 1_800_000_000_000 };
    const [remoteUrl] = await remoteFile.getSignedUrl(options);
    const [localUrl] = await localFile.getSignedUrl(options);
    expect(remoteUrl).toBe(localUrl);
    expect(remoteUrl).toBe(
      'pyric-sandbox-storage://pyric-default/assets/logo.png?expires=1800000000000&action=read',
    );
  });
});

// ─── Remediating throws + caps ──────────────────────────────────────────────

describe('pyric-admin remote dispatch — Storage remediating throws', () => {
  it('throws loudly on non-default bucket names (single-bucket worker store)', () => {
    const { app } = makeStack();
    const storage = getStorage(app);
    expect(() => storage.bucket('my-other-bucket')).toThrow(/single bucket/);
    expect(() => storage.bucket('my-other-bucket')).toThrow(/my-other-bucket/);
    // The default bucket — named or unnamed — is fine.
    expect(storage.bucket().name).toBe('pyric-default');
    expect(storage.bucket('pyric-default').name).toBe('pyric-default');
  });

  it('rejects an over-cap save CLIENT-SIDE (before anything hits the wire)', async () => {
    const { app } = makeStack();
    const file = getStorage(app).bucket().file('big/blob');
    const oversized = Buffer.alloc(MAX_STORAGE_OP_BYTES + 1);
    try {
      await file.save(oversized);
      throw new Error('expected rejection');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('payload-too-large');
      expect((err as Error).message).toContain('8 MiB');
    }
    expect(await file.exists()).toEqual([false]);
  });

  it('rejects an over-cap download HOST-SIDE (a big browser object cannot blow up the relay)', async () => {
    const { ctx, app } = makeStack();
    // Plant an over-cap object directly in the worker's store (the page's
    // own in-worker surface has no cap).
    const { uploadBytes, ref } = await import('pyric/storage');
    const storage = getStorageSandbox(ctx.sandbox);
    await uploadBytes(ref(storage, 'big/native'), new Uint8Array(MAX_STORAGE_OP_BYTES + 1));

    const file = getStorage(app).bucket().file('big/native');
    try {
      await file.download();
      throw new Error('expected rejection');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('payload-too-large');
      expect((err as Error).message).toContain('8 MiB');
    }
  });

  it('resumable saves and streams throw with remote-flavored remediation', async () => {
    const { app } = makeStack();
    const file = getStorage(app).bucket().file('x/y');
    await expect(file.save(Buffer.from('x'), { resumable: true })).rejects.toThrow(
      /resumable uploads/,
    );
    const asStreams = file as unknown as {
      createWriteStream(): never;
      createReadStream(): never;
    };
    expect(() => asStreams.createWriteStream()).toThrow(/createWriteStream.*save/s);
    expect(() => asStreams.createReadStream()).toThrow(/createReadStream.*download/s);
  });
});

// ─── Rules: the pinned admin lens bypasses page-configured rules ────────────

describe('pyric-admin remote dispatch — Storage vs page-configured rules', () => {
  it('deny-all page rules: every admin File op still succeeds (rules bypass), while page ops stay denied', async () => {
    const { ctx, app } = makeStack({ rules: DENY_ALL_RULES });
    const bucket = getStorage(app).bucket();
    const file = bucket.file('locked/secret.bin');
    const bytes = binaryFixture();

    // The PAGE (no lens) is denied — the rules are genuinely live.
    await expect(
      workerOp(ctx, {
        method: 'storage.putBytes',
        path: 'locked/secret.bin',
        dataB64: bytesToBase64(bytes),
      }),
    ).rejects.toThrow(/unauthorized/);

    // The admin arm bypasses: full CRUD against the same denied tree.
    await file.save(bytes, { contentType: 'application/octet-stream' });
    expect(await file.exists()).toEqual([true]);
    const [back] = await file.download();
    expect(back.equals(bytes)).toBe(true);

    // Page reads stay denied even though the object now exists.
    await expect(
      workerOp(ctx, { method: 'storage.getBytes', path: 'locked/secret.bin' }),
    ).rejects.toThrow(/unauthorized/);

    await file.delete();
    expect(await file.exists()).toEqual([false]);
  });
});

// ─── Arm selection + no-peer failure mode ───────────────────────────────────

describe('pyric-admin remote dispatch — Storage arm selection', () => {
  it('routes a remote-branded sandbox to the remote arm (no local state, no onEvent hook)', async () => {
    const { ctx, app } = makeStack();
    // The handle's `onEvent` throws — the local arm subscribes to it when
    // creating its WeakMap state, so a working handle + a write landing in
    // the WORKER's store proves the remote arm was selected.
    const bucket = getStorage(app).bucket();
    await bucket.file('dispatch/probe').save('via remote arm');
    const wire = (await workerOp(ctx, {
      method: 'storage.getBytes',
      path: 'dispatch/probe',
    })) as { dataB64: string };
    expect(Buffer.from(wire.dataB64, 'base64').toString('utf8')).toBe('via remote arm');
  });

  it('getStorage(app) reuses one remote Storage per handle', () => {
    const { app } = makeStack();
    expect(getStorage(app)).toBe(getStorage(app));
  });

  it('still routes a plain in-process sandbox to the local arm', async () => {
    const app = initializeApp({ sandbox: initializeSandbox() });
    const bucket = getStorage(app).bucket();
    await bucket.file('local/probe').save('via local arm');
    const [back] = await bucket.file('local/probe').download();
    expect(back.toString('utf8')).toBe('via local arm');
    // Local-arm signature: real multi-bucket isolation still works.
    const other = getStorage(app).bucket('secondary');
    expect(await other.file('local/probe').exists()).toEqual([false]);
  });
});

describe('pyric-admin remote dispatch — Storage with no browser tab', () => {
  it('fails fast with the "open <serve url>" guidance through the storage API', async () => {
    const bridge = createBridge({ mode: 'sandbox', version: 'test' });
    const remote = connectRemote(bridge); // NO tab registered
    const app = initializeApp({ sandbox: remote });
    const file = getStorage(app).bucket().file('x/y');

    const started = Date.now();
    await expect(file.save(Buffer.from('x'))).rejects.toThrow(/open http:\/\/localhost:5000/);
    await expect(file.download()).rejects.toThrow(/open http:\/\/localhost:5000/);
    await expect(file.exists()).rejects.toThrow(/open http:\/\/localhost:5000/);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

// ─── Conformance: one consumer flow, two arms ───────────────────────────────

describe('pyric-admin storage conformance — same assertions, both arms', () => {
  function runConsumerFlow(storage: Storage): Promise<void> {
    return (async () => {
      const bucket = storage.bucket();
      const file = bucket.file('conformance/data.json');

      expect(await file.exists()).toEqual([false]);
      await expect(file.download()).rejects.toThrow(/No such object/);

      await file.save(Buffer.from('{"n":1}'), { contentType: 'application/json' });
      expect(await file.exists()).toEqual([true]);
      const [buf] = await file.download();
      expect(buf.toString('utf8')).toBe('{"n":1}');

      // Overwrite replaces content (no append semantics).
      await file.save('{"n":2}');
      const [buf2] = await file.download();
      expect(buf2.toString('utf8')).toBe('{"n":2}');

      const [url] = await file.getSignedUrl({ action: 'read', expires: 1_800_000_000_000 });
      expect(url).toBe(
        'pyric-sandbox-storage://pyric-default/conformance/data.json?expires=1800000000000&action=read',
      );

      await expect(file.save(Buffer.from('x'), { resumable: true })).rejects.toThrow(/resumable/);

      await file.delete();
      await file.delete(); // idempotent
      expect(await file.exists()).toEqual([false]);
    })();
  }

  it('local arm passes the consumer flow', async () => {
    const app = initializeApp({ sandbox: initializeSandbox() });
    await runConsumerFlow(getStorage(app));
  });

  it('remote arm passes the identical consumer flow', async () => {
    const { app } = makeStack();
    await runConsumerFlow(getStorage(app));
  });
});
