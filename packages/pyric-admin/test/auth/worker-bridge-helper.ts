import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { WORKER_RELAY_CAPABILITY, type BridgeMessage } from '../../../cli/src/bridge/protocol.js';
import { createBridge, type Bridge } from '../../../cli/src/bridge/server/bridge.js';
import { createConsumerSession } from '../../../cli/src/bridge/server/peer.js';
import {
  createRemoteSandboxCore,
  createRemoteSandboxHandle,
  type RemoteSandbox,
} from '../../../cli/src/remote/index.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../cli/src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../cli/src/serve/worker/protocol.js';
import { initializeApp } from '../../src/app/index.js';
import { getAuth } from '../../src/auth/index.js';

export async function createWorkerBridgeRemoteAuth(appName: string): Promise<{
  auth: ReturnType<typeof getAuth>;
  dispose: () => void;
}> {
  const sandbox = initializeSandbox();
  await sandbox.enablePersistence({
    key: `auth-worker-${appName}`,
    injectedBackend: createMemoryBackend(),
  });
  const ctx: HostCtx = {
    db: getFirestore(sandbox),
    sandbox,
    instanceId: `auth-worker-${appName}`,
    subs: new Map(),
  };
  const bridge: Bridge = createBridge({ mode: 'sandbox', version: 'test' });
  let gen = 0;
  const port: PortLike = {
    postMessage(raw: unknown) {
      const m = raw as OutboundMessage;
      if (m.t === 'res') {
        if (m.ok) {
          bridge.handleSandboxMessage({ type: 'worker-res', id: m.id, ok: true, value: m.value }, gen);
        } else {
          bridge.handleSandboxMessage({ type: 'worker-res', id: m.id, ok: false, error: m.error }, gen);
        }
      } else if (m.t === 'snap') {
        bridge.handleSandboxMessage({ type: 'worker-snap', subId: m.subId, value: m.value }, gen);
      }
    },
  };
  const send = (msg: BridgeMessage): void => {
    if (gen === 0) gen = bridge.peerGeneration();
    if (msg.type === 'worker-op') {
      void handleMessage(ctx, port, { ...msg.op, t: 'op', id: msg.id } as InboundMessage);
    } else if (msg.type === 'worker-sub') {
      void handleMessage(ctx, port, { ...msg.sub, t: 'sub', subId: msg.subId } as InboundMessage);
    } else if (msg.type === 'worker-unsub') {
      void handleMessage(ctx, port, { t: 'unsub', subId: msg.subId } as InboundMessage);
    }
  };
  bridge.registerSandboxPeer(send, [], 'auth-worker-tab', [WORKER_RELAY_CAPABILITY]);

  let handleMsg: (msg: BridgeMessage) => void = () => {};
  const session = createConsumerSession(bridge, (msg) => handleMsg(msg));
  const core = createRemoteSandboxCore(
    { send: (msg) => session.handleMessage(msg) },
    { serveUrl: 'http://localhost:5000' },
  );
  handleMsg = core.handleMessage;
  core.start();
  const remote: RemoteSandbox = createRemoteSandboxHandle({
    channel: core.channel,
    serveUrl: 'http://localhost:5000',
    close: () => core.dispose('closed by test'),
  });
  const app = initializeApp({ sandbox: remote }, appName);
  return {
    auth: getAuth(app),
    dispose: () => {
      remote.dispose();
      sandbox.dispose();
    },
  };
}
