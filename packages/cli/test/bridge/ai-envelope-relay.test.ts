import { describe, expect, it } from 'bun:test';
import { getFirestore } from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import {
  WORKER_RELAY_CAPABILITY,
  type BridgeMessage,
  type WorkerResFrame,
  type WorkerSnapFrame,
} from '../../src/bridge/protocol.js';
import { createBridge, type Bridge } from '../../src/bridge/server/bridge.js';
import { createConsumerSession } from '../../src/bridge/server/peer.js';
import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
} from '../../src/serve/worker/protocol.js';

function overWire<T>(frame: T): T {
  return JSON.parse(JSON.stringify(frame)) as T;
}

function connectWorkerPeer(bridge: Bridge, ctx: HostCtx): void {
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
  bridge.registerSandboxPeer(send, [], 'ai-relay-tab', [WORKER_RELAY_CAPABILITY]);
}

describe('aiEnvelope fidelity over the worker relay', () => {
  it('preserves structured aiEnvelope and ErrorInfo details across worker-res and worker-snap', async () => {
    const sandbox = initializeSandbox({ projectId: 'demo-ai-relay' });
    const ctx: HostCtx = {
      db: getFirestore(sandbox),
      sandbox,
      instanceId: 'ai-envelope-relay-test',
      subs: new Map(),
      aiEngine: {
        kind: 'scripted',
        script: [
          {
            match: 'ERR_LOCATION_UNARY',
            respond: {
              error: {
                code: 400,
                message: 'Precondition check failed.',
                status: 'FAILED_PRECONDITION',
                details: [
                  {
                    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                    reason: 'USER_LOCATION_NOT_SUPPORTED',
                  },
                ],
              },
            },
          },
          {
            match: 'ERR_LOCATION_STREAM',
            respond: {
              error: {
                code: 400,
                message: 'Precondition check failed.',
                status: 'FAILED_PRECONDITION',
                details: [
                  {
                    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                    reason: 'USER_LOCATION_NOT_SUPPORTED',
                  },
                ],
              },
            },
          },
        ],
      },
    };

    try {
      const bridge = createBridge({ version: 'test' });
      connectWorkerPeer(bridge, ctx);

      const outbound: BridgeMessage[] = [];
      const consumer = createConsumerSession(bridge, (msg) => outbound.push(overWire(msg)));
      consumer.handleMessage({
        type: 'attach',
        protocol: 1,
        clientSessionId: 'flutter-consumer-1',
        clientInfo: { platform: 'flutter' },
      });

      consumer.handleMessage({
        type: 'worker-op',
        id: 'op-retired',
        op: {
          method: 'ai.generateContent',
          model: 'models/gemini-1.5-flash',
          request: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
        },
      });
      consumer.handleMessage({
        type: 'worker-op',
        id: 'op-location',
        op: {
          method: 'ai.generateContent',
          model: 'models/gemini-2.5-flash',
          request: { contents: [{ role: 'user', parts: [{ text: 'ERR_LOCATION_UNARY' }] }] },
        },
      });
      consumer.handleMessage({
        type: 'worker-sub',
        subId: 'sub-location',
        sub: {
          target: { service: 'ai', op: 'streamGenerateContent' },
          model: 'models/gemini-2.5-flash',
          request: { contents: [{ role: 'user', parts: [{ text: 'ERR_LOCATION_STREAM' }] }] },
        },
      });

      await new Promise((r) => setTimeout(r, 30));

      const retiredRes = outbound.find(
        (m): m is WorkerResFrame => m.type === 'worker-res' && m.id === 'op-retired',
      );
      expect(retiredRes?.ok).toBe(false);
      expect(retiredRes?.error?.code).toBe('ai/NOT_FOUND');
      const retiredEnv = retiredRes?.error?.aiEnvelope as {
        error?: { code?: number; details?: Array<{ reason?: string }> };
      };
      expect(retiredEnv.error?.code).toBe(404);
      expect(retiredEnv.error?.details?.[0]?.reason).toBe('RETIRED_MODEL');

      const locationRes = outbound.find(
        (m): m is WorkerResFrame => m.type === 'worker-res' && m.id === 'op-location',
      );
      expect(locationRes?.ok).toBe(false);
      const locationEnv = locationRes?.error?.aiEnvelope as {
        error?: { status?: string; details?: Array<{ reason?: string }> };
      };
      expect(locationEnv.error?.status).toBe('FAILED_PRECONDITION');
      expect(locationEnv.error?.details?.[0]?.reason).toBe('USER_LOCATION_NOT_SUPPORTED');

      const snapErr = outbound.find(
        (m): m is WorkerSnapFrame => m.type === 'worker-snap' && m.subId === 'sub-location',
      );
      const snapErrPayload = (snapErr?.value as { __error?: { aiEnvelope?: typeof locationEnv } }).__error;
      expect(snapErrPayload?.aiEnvelope?.error?.details?.[0]?.reason).toBe('USER_LOCATION_NOT_SUPPORTED');

      consumer.dispose();
    } finally {
      sandbox.dispose();
    }
  });
});
