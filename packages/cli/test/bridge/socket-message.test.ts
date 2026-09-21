/**
 * Output-backlog policy for `sendBridgeMessage`.
 *
 * A socket whose reader has stalled must not take unrelated operations down
 * with it. A frame that would push the socket past
 * `MAX_QUEUED_OPERATION_BYTES` fails only the operation it belongs to: an
 * outbound request goes back to its local requester, an outbound response is
 * replaced by a small error carrying the same correlation id. A frame with no
 * request behind it (a pushed subscription event) still closes the socket with
 * 1013, because a reader that is not draining pushed frames cannot be helped.
 */

import { describe, it, expect } from 'bun:test';
import { sendBridgeMessage } from '../../src/bridge/server/socket-message.js';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { createConsumerSession } from '../../src/bridge/server/peer.js';
import {
  MAX_PENDING_OPERATIONS,
  MAX_QUEUED_OPERATION_BYTES,
  WORKER_RELAY_CAPABILITY,
  type BridgeMessage,
} from '../../src/bridge/protocol.js';
import type { SandboxEvent } from 'pyric/sandbox';

const backlogError = {
  code: 'resource-exhausted',
  message: 'Bridge output backlog exceeded; retry this operation.',
};

interface FakeSocket {
  readonly OPEN: number;
  readyState: number;
  readonly bufferedAmount: number;
  /** Bytes the reader has not drained; the backlog this socket reports. */
  stalledBytes: number;
  sent: BridgeMessage[];
  closes: Array<{ code: number; reason: string }>;
  send(payload: string): void;
  close(code: number, reason: string): void;
}

/** A socket whose output backlog is the stalled bytes plus everything sent since. */
function fakeSocket(stalledBytes = 0): FakeSocket {
  const socket: FakeSocket = {
    OPEN: 1,
    readyState: 1,
    stalledBytes,
    sent: [],
    closes: [],
    get bufferedAmount(): number {
      return socket.stalledBytes;
    },
    send(payload: string): void {
      socket.stalledBytes += Buffer.byteLength(payload);
      socket.sent.push(JSON.parse(payload) as BridgeMessage);
    },
    close(code: number, reason: string): void {
      socket.readyState = 3;
      socket.closes.push({ code, reason });
    },
  };
  return socket;
}

function asWebSocket(socket: FakeSocket): Parameters<typeof sendBridgeMessage>[0] {
  return socket as unknown as Parameters<typeof sendBridgeMessage>[0];
}

/** Headroom left before this socket reaches the queued-operation limit. */
const HEADROOM = 4096;

/** A payload that cannot fit in the socket's remaining backlog room. */
function oversizedValue(socket: FakeSocket): string {
  return 'x'.repeat(MAX_QUEUED_OPERATION_BYTES - socket.bufferedAmount + 1);
}

/** A pushed observation batch larger than the socket's remaining room. */
function oversizedEvents(): SandboxEvent[] {
  return Array.from({ length: 200 }, (_unused, index) => ({
    kind: 'observation_gap' as const,
    id: `gap-${index}`,
    at: 1_700_000_000_000 + index,
    reason: 'history-limit' as const,
    omittedCount: 1,
    firstEventId: `event-${index}`,
    lastEventId: `event-${index}`,
  }));
}

describe('sendBridgeMessage — output backlog', () => {
  it('replaces an over-backlog correlated response with a small error for the same id', () => {
    const socket = fakeSocket(MAX_QUEUED_OPERATION_BYTES - HEADROOM);
    sendBridgeMessage(asWebSocket(socket), {
      type: 'worker-res',
      id: 'op-9',
      clientSessionId: 'session-a',
      ok: true,
      value: oversizedValue(socket),
    });

    expect(socket.closes).toEqual([]);
    expect(socket.sent).toEqual([
      {
        type: 'worker-res',
        id: 'op-9',
        clientSessionId: 'session-a',
        ok: false,
        error: backlogError,
      },
    ]);
  });

  it('replaces an over-backlog tool result with a small error for the same id', () => {
    const socket = fakeSocket(MAX_QUEUED_OPERATION_BYTES - HEADROOM);
    sendBridgeMessage(asWebSocket(socket), {
      type: 'tool-result',
      id: 'call-3',
      ok: true,
      result: { ok: true, summary: oversizedValue(socket) },
    });

    expect(socket.closes).toEqual([]);
    expect(socket.sent).toEqual([
      { type: 'tool-result', id: 'call-3', ok: false, error: backlogError },
    ]);
  });

  it('replaces an over-backlog relayed worker result with a small error for the same id', () => {
    const socket = fakeSocket(MAX_QUEUED_OPERATION_BYTES - HEADROOM);
    sendBridgeMessage(asWebSocket(socket), {
      type: 'worker-message-result',
      clientSessionId: 'session-b',
      message: {
        t: 'res',
        id: 'op-4',
        clientSessionId: 'session-b',
        ok: true,
        value: oversizedValue(socket),
      },
    });

    expect(socket.closes).toEqual([]);
    expect(socket.sent).toEqual([
      {
        type: 'worker-message-result',
        clientSessionId: 'session-b',
        message: {
          t: 'res',
          id: 'op-4',
          clientSessionId: 'session-b',
          ok: false,
          error: backlogError,
        },
      },
    ]);
  });

  it('refuses an over-backlog outbound worker op to its local requester', () => {
    const socket = fakeSocket(MAX_QUEUED_OPERATION_BYTES - HEADROOM);
    const refusals: BridgeMessage[] = [];
    sendBridgeMessage(
      asWebSocket(socket),
      {
        type: 'worker-op',
        id: 'op-7',
        clientSessionId: 'session-c',
        op: { method: 'setDoc', path: 'files/one', data: oversizedValue(socket) },
      },
      (refusal) => refusals.push(refusal),
    );

    expect(socket.closes).toEqual([]);
    expect(socket.sent).toEqual([]);
    expect(refusals).toEqual([
      {
        type: 'worker-res',
        id: 'op-7',
        clientSessionId: 'session-c',
        ok: false,
        error: backlogError,
      },
    ]);
  });

  it('refuses an over-backlog outbound tool call to its local requester', () => {
    const socket = fakeSocket(MAX_QUEUED_OPERATION_BYTES - HEADROOM);
    const refusals: BridgeMessage[] = [];
    sendBridgeMessage(
      asWebSocket(socket),
      {
        type: 'tool-call',
        id: 'call-8',
        name: 'firestore_set_document',
        args: { data: oversizedValue(socket) },
      },
      (refusal) => refusals.push(refusal),
    );

    expect(socket.closes).toEqual([]);
    expect(socket.sent).toEqual([]);
    expect(refusals).toEqual([
      { type: 'tool-result', id: 'call-8', ok: false, error: backlogError },
    ]);
  });

  it('closes an over-backlog pushed observation batch with 1013', () => {
    const socket = fakeSocket(MAX_QUEUED_OPERATION_BYTES - HEADROOM);
    sendBridgeMessage(asWebSocket(socket), {
      type: 'worker-message-result',
      clientSessionId: 'session-d',
      message: {
        t: 'event',
        subId: 'sub-1',
        clientSessionId: 'session-d',
        events: oversizedEvents(),
      },
    });

    expect(socket.sent).toEqual([]);
    expect(socket.closes).toHaveLength(1);
    expect(socket.closes[0]?.code).toBe(1013);
  });

  it('closes an over-backlog pushed snapshot with 1013', () => {
    const socket = fakeSocket(MAX_QUEUED_OPERATION_BYTES - HEADROOM);
    sendBridgeMessage(asWebSocket(socket), {
      type: 'worker-snap',
      subId: 'sub-2',
      clientSessionId: 'session-e',
      value: oversizedValue(socket),
    });

    expect(socket.sent).toEqual([]);
    expect(socket.closes).toHaveLength(1);
    expect(socket.closes[0]?.code).toBe(1013);
  });

  it('closes a socket that never drains once its refusals reach the overshoot bound', () => {
    const socket = fakeSocket(MAX_QUEUED_OPERATION_BYTES - HEADROOM);
    const body = 'x'.repeat(2 * HEADROOM);
    for (let attempt = 0; attempt < 20_000 && socket.closes.length === 0; attempt += 1) {
      sendBridgeMessage(asWebSocket(socket), {
        type: 'worker-res',
        id: `op-${attempt}`,
        clientSessionId: 'session-g',
        ok: true,
        value: body,
      });
    }

    const refusalBytes = socket.sent.reduce(
      (total, refusal) => total + Buffer.byteLength(JSON.stringify(refusal)),
      0,
    );
    expect(refusalBytes).toBeLessThanOrEqual(MAX_PENDING_OPERATIONS * 4 * 1024);
    expect(socket.closes).toHaveLength(1);
    expect(socket.closes[0]?.code).toBe(1013);
  });

  it('sends a frame that fits the backlog unchanged', () => {
    const socket = fakeSocket(MAX_QUEUED_OPERATION_BYTES - HEADROOM);
    const frame: BridgeMessage = {
      type: 'worker-res',
      id: 'op-1',
      clientSessionId: 'session-f',
      ok: true,
      value: { path: 'files/one', size: 12 },
    };
    sendBridgeMessage(asWebSocket(socket), frame);

    expect(socket.closes).toEqual([]);
    expect(socket.sent).toEqual([frame]);
  });

  it('takes its limit from MAX_QUEUED_OPERATION_BYTES', () => {
    const frame: BridgeMessage = { type: 'ping', id: 'p' };
    const frameBytes = Buffer.byteLength(JSON.stringify(frame));

    const atLimit = fakeSocket(MAX_QUEUED_OPERATION_BYTES - frameBytes);
    sendBridgeMessage(asWebSocket(atLimit), frame);
    expect(atLimit.sent).toEqual([frame]);
    expect(atLimit.closes).toEqual([]);

    const overLimit = fakeSocket(MAX_QUEUED_OPERATION_BYTES - frameBytes + 1);
    sendBridgeMessage(asWebSocket(overLimit), frame);
    expect(overLimit.sent).toEqual([]);
    expect(overLimit.closes).toHaveLength(1);
    expect(overLimit.closes[0]?.code).toBe(1013);
  });
});

/** Answer every relayed op with a response body of the size its path names. */
function connectSizedPeer(bridge: ReturnType<typeof createBridge>): void {
  let generation = 0;
  bridge.registerSandboxPeer(
    (out: BridgeMessage) => {
      if (generation === 0) generation = bridge.peerGeneration();
      const isOperation = out.type === 'worker-op';
      if (!isOperation) return;
      const path = (out.op as { path?: string }).path ?? 'sized/0';
      const bytes = Number(path.slice(path.indexOf('/') + 1));
      bridge.handleSandboxMessage(
        { type: 'worker-res', id: out.id, ok: true, value: 'x'.repeat(bytes) },
        generation,
      );
    },
    [],
    'sized-peer',
    [WORKER_RELAY_CAPABILITY],
  );
}

describe('backlogged connection — one response fails alone', () => {
  it('fails only the over-backlog response while concurrent operations finish', async () => {
    const bridge = createBridge({ version: 'test' });
    connectSizedPeer(bridge);
    const socket = fakeSocket(0);
    const session = createConsumerSession(bridge, (out) =>
      sendBridgeMessage(asWebSocket(socket), out),
    );
    session.handleMessage({ type: 'attach', protocol: 1, clientSessionId: 'session-a' });
    socket.sent.length = 0;
    socket.stalledBytes = 21 * 1024 * 1024;

    const twoMiB = 2 * 1024 * 1024;
    session.handleMessage({
      type: 'worker-op',
      id: 'fits',
      op: { method: 'getDoc', path: `sized/${twoMiB}` },
    });
    session.handleMessage({
      type: 'worker-op',
      id: 'over',
      op: { method: 'getDoc', path: `sized/${twoMiB}` },
    });
    session.handleMessage({
      type: 'worker-op',
      id: 'small',
      op: { method: 'getDoc', path: 'sized/8' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const outcomes = socket.sent.map((frame) => {
      const response = frame as { id: string; ok: boolean; error?: { message: string } };
      return { id: response.id, ok: response.ok, message: response.error?.message };
    });
    expect(outcomes).toEqual([
      { id: 'fits', ok: true, message: undefined },
      { id: 'over', ok: false, message: backlogError.message },
      { id: 'small', ok: true, message: undefined },
    ]);
    expect(socket.closes).toEqual([]);
  });
});
