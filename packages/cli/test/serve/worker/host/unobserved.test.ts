/**
 * A live Node process sends its unobserved lists on its connection. Both
 * hosts call `handleMessage`, the SharedWorker for each port and the Node
 * host for each admitted socket, so both answer the frame. The live host
 * lists the lists under the client on their way in (`live-clients.ts`); the
 * sandbox keeps nothing and writes no event. A frame whose lists are not
 * bounded names is refused.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { handleMessage, type HostCtx, type PortLike } from '../../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../../src/serve/worker/protocol.js';
import { requestEnvelopeError } from '../../../../src/bridge/server/request-envelope.js';
import type { BridgeMessage } from '../../../../src/bridge/protocol.js';
import { createReproRecorder } from '../../../../src/serve/repro/recorder.js';

interface FakePort extends PortLike { messages: OutboundMessage[] }

function fakePort(): FakePort {
  const messages: OutboundMessage[] = [];
  return { messages, postMessage(message) { messages.push(message); } };
}

function makeCtx(): HostCtx {
  const sandbox = initializeSandbox();
  return { db: getFirestore(sandbox), sandbox, instanceId: 'unobserved-test', subs: new Map() };
}

let sequence = 0;

async function send(ctx: HostCtx, port: FakePort, lists: Record<string, unknown>): Promise<OutboundMessage | undefined> {
  const id = `unobserved-${++sequence}`;
  await handleMessage(ctx, port, { t: 'unobserved', id, ...lists } as InboundMessage);
  return port.messages.find((message) => message.t === 'res' && message.id === id);
}

describe('host: unobserved lists', () => {
  it('answers well-formed lists and writes nothing to the event stream', async () => {
    const ctx = makeCtx();
    const port = fakePort();
    const reply = await send(ctx, port, {
      unobserved: ['cloudtrace.googleapis.com'],
      unobservedAdmin: ['firebase-admin/remote-config'],
      gatedAdmin: ['firebase-admin/app-check'],
    });
    expect(reply).toMatchObject({ t: 'res', ok: true });
    expect(ctx.sandbox.history()).toEqual([]);
  });

  it('refuses lists that carry anything but bounded names', async () => {
    const ctx = makeCtx();
    const port = fakePort();
    const malformed = [
      { unobserved: ['https://user:secret@cloudtrace.googleapis.com/v2?key=k'] },
      { unobserved: ['cloudtrace.googleapis.com', 'cloudtrace.googleapis.com'] },
      { unobserved: Array.from({ length: 65 }, (_, index) => `host-${index}.googleapis.com`) },
      { unobservedAdmin: ['firebase-admin/remote-config/../../etc'] },
      { gatedAdmin: 'firebase-admin/app-check' },
    ];
    for (const lists of malformed) {
      const reply = await send(ctx, port, lists);
      expect(reply).toMatchObject({ t: 'res', ok: false, error: { code: 'invalid-argument' } });
    }
  });

  it('admits the frame through the bridge socket envelope only with a request id', () => {
    const envelope = (message: Record<string, unknown>) => ({ type: 'worker-message', message }) as unknown as BridgeMessage;
    expect(requestEnvelopeError(envelope({ t: 'unobserved', id: 'u1', unobserved: ['cloudtrace.googleapis.com'] }))).toBeUndefined();
    expect(requestEnvelopeError(envelope({ t: 'unobserved', unobserved: ['cloudtrace.googleapis.com'] }))).toBe('Invalid worker message envelope.');
  });

  it('leaves the frame out of a repro log: it is host status, not an operation', async () => {
    const recorder = createReproRecorder({ capture: async () => ({ at: 0, firestore: {}, rtdb: {}, auth: {} }) as never });
    await recorder.inbound('s-node', { t: 'unobserved', id: 'u1', unobserved: ['cloudtrace.googleapis.com'] } as InboundMessage);
    expect(JSON.stringify(await recorder.log())).not.toContain('cloudtrace.googleapis.com');
  });
});
