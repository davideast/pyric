import WebSocket from 'ws';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { setRules as setDatabaseRules } from 'pyric/sandbox/database';
import { getFirestore as getBaseFirestore } from 'pyric/sandbox/admin-firestore';
import {
  isBridgeMessage,
  WORKER_RELAY_CAPABILITY,
  type BridgeMessage,
} from '../../src/bridge/protocol.js';
import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
} from '../../src/serve/worker/protocol.js';

export interface FunctionsWorkerHostOptions {
  persistenceKeyPrefix: string;
  instanceId: string;
  /**
   * Optional RTDB security rules to load into the stand-in sandbox. Used by the
   * #401 regression to gate the trigger's watched path behind auth: the trigger
   * subscription must reach the sandbox through the admin (rules-bypass) lens,
   * so an auth-gated `.read` there must NOT deny it.
   */
  databaseRules?: { rules: Record<string, unknown> };
  /** Optional Firestore ruleset deployed on the worker's sandbox before any
   *  relayed op — deployed synchronously through the LOCAL arm exactly as a
   *  served page would. Lets a test prove that a functions child's admin
   *  (rules-bypass) write lands against a ruleset that would DENY an
   *  anonymous/client-lens caller (#394). */
  firestoreRules?: string;
}

export interface FunctionsWorkerPeerOptions {
  url: string;
  ctx: HostCtx;
  sandboxId: string;
}

export async function createFunctionsWorkerHostCtx(
  options: FunctionsWorkerHostOptions,
): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  await sandbox.enablePersistence({
    key: `${options.persistenceKeyPrefix}-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });
  if (options.databaseRules) setDatabaseRules(sandbox, options.databaseRules);
  if (options.firestoreRules !== undefined) {
    getBaseFirestore(sandbox.withAuth(null)).setRules(options.firestoreRules);
  }
  return {
    db: getFirestore(sandbox),
    sandbox,
    instanceId: options.instanceId,
    subs: new Map(),
    messagingEnabled: true,
  };
}

export async function connectFunctionsWorkerPeer(
  options: FunctionsWorkerPeerOptions,
): Promise<{ close(): Promise<void> }> {
  const ws = new WebSocket(options.url);
  const port: PortLike = {
    postMessage(raw: unknown) {
      if (ws.readyState !== WebSocket.OPEN) return;
      const message = raw as OutboundMessage;
      if (message.t === 'res') {
        const response: BridgeMessage = message.ok
          ? { type: 'worker-res', id: message.id, ok: true, value: message.value }
          : { type: 'worker-res', id: message.id, ok: false, error: message.error };
        ws.send(JSON.stringify(response));
      } else if (message.t === 'snap') {
        ws.send(JSON.stringify({
          type: 'worker-snap',
          subId: message.subId,
          value: message.value,
        } satisfies BridgeMessage));
      }
    },
  };

  await new Promise<void>((resolveConnected, rejectConnected) => {
    ws.once('open', () => ws.send(JSON.stringify({
      type: 'hello',
      protocol: 1,
      tools: [],
      sandboxId: options.sandboxId,
      capabilities: [WORKER_RELAY_CAPABILITY],
    } satisfies BridgeMessage)));
    ws.on('message', (raw) => {
      let message: unknown;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!isBridgeMessage(message)) return;
      if (message.type === 'hello-ack') resolveConnected();
      else if (message.type === 'worker-op') {
        void handleMessage(options.ctx, port, {
          ...message.op,
          t: 'op',
          id: message.id,
        } as InboundMessage);
      } else if (message.type === 'worker-sub') {
        void handleMessage(options.ctx, port, {
          ...message.sub,
          t: 'sub',
          subId: message.subId,
        } as InboundMessage);
      } else if (message.type === 'worker-unsub') {
        void handleMessage(options.ctx, port, {
          t: 'unsub',
          subId: message.subId,
        } satisfies InboundMessage);
      }
    });
    ws.once('error', rejectConnected);
    ws.once('close', () => rejectConnected(new Error('worker peer closed before ready')));
  });

  return {
    close: () => new Promise<void>((resolveClosed) => {
      if (ws.readyState === WebSocket.CLOSED) return resolveClosed();
      ws.once('close', () => resolveClosed());
      ws.close();
    }),
  };
}
