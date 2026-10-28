/**
 * The two arms a `pyric-admin/storage` suite runs on: the in-process sandbox,
 * and a remote handle on a SharedWorker host (the real worker host behind the
 * bridge, every frame JSON round-tripped as the wire would carry it).
 */
import 'fake-indexeddb/auto';
import { initializeSandbox, type Sandbox } from 'pyric/sandbox';
import { getClock } from 'pyric/sandbox/internal';
import { getFirestore } from 'pyric/firestore';
import { getStorageSandbox } from 'pyric/storage';
import { createBridge, type Bridge } from '../../../cli/src/bridge/server/bridge.js';
import { createConsumerSession } from '../../../cli/src/bridge/server/peer.js';
import { WORKER_RELAY_CAPABILITY, type BridgeMessage } from '../../../cli/src/bridge/protocol.js';
import { createRemoteSandboxCore, createRemoteSandboxHandle } from '../../../cli/src/remote/index.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../cli/src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../cli/src/serve/worker/protocol.js';
import { initializeApp, type PyricAdminApp } from '../../src/app/index.js';

const OPEN_RULES = `
service firebase.storage {
  match /{allPaths=**} {
    allow read, write: if true;
  }
}`;

/** Options an arm's app is initialized with, besides its sandbox. */
export interface ArmOptions {
  storageBucket?: string;
  /** Pin the host sandbox's clock to this instant. */
  fixedClockAt?: number;
}

/** A fresh host sandbox, its clock pinned when the arm asks. */
function hostSandbox(fixedClockAt: number | undefined): Sandbox {
  const sandbox = initializeSandbox();
  if (fixedClockAt !== undefined) getClock(sandbox).set(fixedClockAt);
  return sandbox;
}

const overWire = <T>(frame: T): T => JSON.parse(JSON.stringify(frame)) as T;

let sequence = 0;

/** An app on the in-process sandbox. */
export function inProcessApp({ fixedClockAt, ...options }: ArmOptions = {}): PyricAdminApp {
  return initializeApp({ sandbox: hostSandbox(fixedClockAt), ...options }, `storage-admin-local-${++sequence}`);
}

/** An app on a remote handle to a SharedWorker host. */
export function sharedWorkerApp({ fixedClockAt, ...options }: ArmOptions = {}): PyricAdminApp {
  const sandbox = hostSandbox(fixedClockAt);
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
  return initializeApp({ sandbox: remote, ...options }, `storage-admin-shared-worker-${sequence}`);
}

export const STORAGE_ARMS: Array<[string, (options?: ArmOptions) => PyricAdminApp]> = [
  ['in-process', inProcessApp],
  ['SharedWorker host', sharedWorkerApp],
];
