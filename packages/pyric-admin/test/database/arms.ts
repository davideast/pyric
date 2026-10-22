/**
 * The two arms a `pyric-admin/database` suite runs on: the in-process sandbox,
 * and a remote handle on a SharedWorker host (the real worker host behind the
 * bridge, every frame JSON round-tripped as the wire would carry it).
 */
import { initializeSandbox } from 'pyric/sandbox';
import { getDatabase as getModularDatabase, sandbox as databaseSandbox } from 'pyric/database';
import { getFirestore } from 'pyric/firestore';
import { createBridge, type Bridge } from '../../../cli/src/bridge/server/bridge.js';
import { createConsumerSession } from '../../../cli/src/bridge/server/peer.js';
import { WORKER_RELAY_CAPABILITY, type BridgeMessage } from '../../../cli/src/bridge/protocol.js';
import { createRemoteSandboxCore, createRemoteSandboxHandle } from '../../../cli/src/remote/index.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../cli/src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../cli/src/serve/worker/protocol.js';
import { initializeApp, type PyricAdminApp } from '../../src/app/index.js';

const SERVE_URL = 'http://localhost:5000';

const overWire = <T>(frame: T): T => JSON.parse(JSON.stringify(frame)) as T;

let sequence = 0;

/** An app on the in-process sandbox. */
export function inProcessApp(): PyricAdminApp {
  return initializeApp({ sandbox: initializeSandbox() }, `database-admin-local-${++sequence}`);
}

/** The worker host's side of the bridge: replies go back through `bridge`. */
function hostPeer(bridge: Bridge): void {
  const sandbox = initializeSandbox();
  databaseSandbox.setDefaultPolicy(getModularDatabase(sandbox), 'allow');
  // No persistence is enabled, so there is nothing to flush after a write.
  const ctx: HostCtx = {
    db: getFirestore(sandbox),
    sandbox,
    instanceId: 'database-admin-arms',
    subs: new Map(),
    flushPersistence: async () => {},
  };
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
}

/** An app on a remote handle to a SharedWorker host. */
export function sharedWorkerApp(): PyricAdminApp {
  const bridge = createBridge({ mode: 'sandbox', version: 'test' });
  hostPeer(bridge);
  let deliver: (message: BridgeMessage) => void = () => {};
  const session = createConsumerSession(bridge, (message) => deliver(overWire(message)));
  const core = createRemoteSandboxCore({ send: (message) => session.handleMessage(overWire(message)) }, { serveUrl: SERVE_URL });
  deliver = core.handleMessage;
  core.start();
  const remote = createRemoteSandboxHandle({ channel: core.channel, serveUrl: SERVE_URL, close: () => core.dispose('closed') });
  return initializeApp({ sandbox: remote }, `database-admin-shared-worker-${++sequence}`);
}
