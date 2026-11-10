import { initializeSandbox, type Sandbox } from 'pyric/sandbox';
import { getDatabase as getModularDatabase, sandbox as databaseSandbox } from 'pyric/database';
import { getFirestore as getModularFirestore } from 'pyric/firestore';
import { getFirestore as getLocalBaseFirestore } from 'pyric/sandbox/admin-firestore';
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

export function inProcessFirestoreArm(rules?: string): { app: PyricAdminApp; host: Sandbox } {
  const sandbox = initializeSandbox({ projectId: 'proj-1' });
  if (rules !== undefined) {
    getLocalBaseFirestore(sandbox.withAuth(null)).setRules(rules);
  }
  const app = initializeApp({ sandbox, projectId: 'proj-1' }, `firestore-admin-local-${++sequence}`);
  return { app, host: sandbox };
}

export function sharedWorkerFirestoreArm(rules?: string): { app: PyricAdminApp; host: Sandbox } {
  const bridge: Bridge = createBridge({ mode: 'sandbox', version: 'test' });
  const sandbox = initializeSandbox({ projectId: 'proj-1' });
  if (rules !== undefined) {
    getLocalBaseFirestore(sandbox.withAuth(null)).setRules(rules);
  }
  databaseSandbox.setDefaultPolicy(getModularDatabase(sandbox), 'allow');
  const ctx: HostCtx = {
    db: getModularFirestore(sandbox),
    sandbox,
    instanceId: `firestore-admin-arms-${++sequence}`,
    subs: new Map(),
    flushPersistence: async () => {},
  };
  let generation = 0;
  const tab: PortLike = {
    postMessage(raw: unknown) {
      const message = raw as OutboundMessage;
      if (message.t === 'res') {
        const reply = message.ok
          ? { type: 'worker-res', id: message.id, ok: true, value: message.value }
          : { type: 'worker-res', id: message.id, ok: false, error: message.error };
        bridge.handleSandboxMessage(overWire(reply) as BridgeMessage, generation);
      } else if (message.t === 'snap') {
        bridge.handleSandboxMessage(
          overWire({ type: 'worker-snap', subId: message.subId, value: message.value }) as BridgeMessage,
          generation,
        );
      }
    },
  };
  bridge.registerSandboxPeer(
    (message: BridgeMessage) => {
      if (generation === 0) generation = bridge.peerGeneration();
      const wire = overWire(message);
      if (wire.type === 'worker-op') {
        void handleMessage(ctx, tab, { ...wire.op, t: 'op', id: wire.id } as InboundMessage);
      } else if (wire.type === 'worker-sub') {
        void handleMessage(ctx, tab, { ...wire.sub, t: 'sub', subId: wire.subId } as InboundMessage);
      } else if (wire.type === 'worker-unsub') {
        void handleMessage(ctx, tab, { t: 'unsub', subId: wire.subId } as InboundMessage);
      }
    },
    [],
    'fake-tab',
    [WORKER_RELAY_CAPABILITY],
  );
  let deliver: (message: BridgeMessage) => void = () => {};
  const session = createConsumerSession(bridge, (message) => deliver(overWire(message)));
  const core = createRemoteSandboxCore(
    { send: (message) => session.handleMessage(overWire(message)) },
    { serveUrl: SERVE_URL },
  );
  deliver = core.handleMessage;
  core.start();
  const remote = createRemoteSandboxHandle({
    channel: core.channel,
    serveUrl: SERVE_URL,
    close: () => core.dispose('closed'),
  });
  return {
    app: initializeApp({ sandbox: remote, projectId: 'proj-1' }, `firestore-admin-remote-${++sequence}`),
    host: sandbox,
  };
}
