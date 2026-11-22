/**
 * Ledger D7 (#1385): per-consumer observation queue with count (1,000 events)
 * and byte (16 MiB) bounds, gap reporting via `observation_gap`, independent
 * operation/control scheduling, sibling consumer isolation, and drain /
 * disconnect cleanup of queued memory and timers.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'bun:test';
import type { SandboxEvent, SandboxObservationGapEvent } from 'pyric/sandbox';
import {
  ConsumerObservationQueue,
  MAX_PENDING_OBSERVATION_BYTES,
  MAX_PENDING_OBSERVATION_EVENTS,
  OBSERVATION_SOCKET_HIGH_WATER_BYTES,
  prepareObservationBridgeFrame,
} from '../../../src/bridge/frame-output.js';
import { type BridgeMessage } from '../../../src/bridge/protocol.js';
import { sendBridgeMessage } from '../../../src/bridge/server/socket-message.js';

function makeRequestEvent(index: number, padBytes = 0, deny = false): SandboxEvent {
  return {
    kind: 'request',
    id: `ev-${index}`,
    at: 1_700_000_000_000 + index,
    evalMs: 1,
    method: 'get',
    path: padBytes > 0 ? `items/doc-${index}-${'p'.repeat(padBytes)}` : `items/doc-${index}`,
    auth: null,
    result: deny ? 'deny' : 'allow',
    reasons: [],
    origin: 'user',
  };
}

function makeObservationFrame(
  events: readonly SandboxEvent[],
  clientSessionId = 'session-1',
  subId = 'obs-1',
  pageId?: string,
): Extract<BridgeMessage, { type: 'worker-message-result' }> & {
  message: { t: 'event'; subId: string; events: readonly SandboxEvent[]; pageId?: string };
} {
  const message: {
    t: 'event';
    subId: string;
    clientSessionId: string;
    events: readonly SandboxEvent[];
    pageId?: string;
  } = {
    t: 'event',
    subId,
    clientSessionId,
    events,
  };
  if (pageId !== undefined) message.pageId = pageId;
  return {
    type: 'worker-message-result',
    clientSessionId,
    message,
  };
}

class ControlledConsumerSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  stalledBytes = 0;
  /** When false, writes are immediately consumed (bufferedAmount stays 0). */
  backpressured = false;
  readonly _socket = new EventEmitter();
  readonly sent: BridgeMessage[] = [];
  readonly closes: Array<{ code: number; reason: string }> = [];

  get bufferedAmount(): number {
    return this.stalledBytes;
  }

  send(payload: string): void {
    if (this.backpressured) {
      this.stalledBytes += Buffer.byteLength(payload);
    }
    this.sent.push(JSON.parse(payload) as BridgeMessage);
  }

  close(code: number, reason: string): void {
    this.readyState = 3;
    this.closes.push({ code, reason });
    this.emit('close', code, reason);
  }

  drainAll(): void {
    this.backpressured = false;
    this.stalledBytes = 0;
    this._socket.emit('drain');
  }
}

function asWebSocket(socket: ControlledConsumerSocket): Parameters<typeof sendBridgeMessage>[0] {
  return socket as unknown as Parameters<typeof sendBridgeMessage>[0];
}

function extractEvents(frames: readonly BridgeMessage[]): SandboxEvent[] {
  const out: SandboxEvent[] = [];
  for (const frame of frames) {
    if (frame.type === 'worker-message-result' && frame.message.t === 'event') {
      out.push(...frame.message.events);
    }
  }
  return out;
}

describe('ledger D7 (#1385): per-consumer observation queue', () => {
  it('enforces the 1,000-event count bound and coalesces dropped batches into observation_gap', () => {
    const queue = new ConsumerObservationQueue();
    const totalSent = MAX_PENDING_OBSERVATION_EVENTS + 250;
    for (let i = 1; i <= totalSent; i += 1) {
      const prepared = prepareObservationBridgeFrame(
        makeObservationFrame([makeRequestEvent(i, 0, i <= 5)]),
      );
      if (prepared === undefined || prepared.kind === 'empty') {
        throw new Error('Expected prepared observation batch');
      }
      queue.enqueue(prepared);
      expect(queue.queuedEvents).toBeLessThanOrEqual(MAX_PENDING_OBSERVATION_EVENTS);
    }

    const drained: BridgeMessage[] = [];
    while (!queue.isEmpty) {
      const next = queue.shift();
      if (next !== undefined) drained.push(JSON.parse(next.payload) as BridgeMessage);
    }
    const events = extractEvents(drained);
    expect(events).toHaveLength(MAX_PENDING_OBSERVATION_EVENTS);

    const headGap = events[0] as SandboxObservationGapEvent;
    expect(headGap.kind).toBe('observation_gap');
    expect(headGap.reason).toBe('frame-limit');
    // 1 gap entry + 999 live events = 1,000 entries -> 251 events omitted (ev-1 .. ev-251).
    expect(headGap.omittedCount).toBe(251);
    expect(headGap.omittedDenials).toBe(5);
    expect(headGap.firstEventId).toBe('ev-1');
    expect(headGap.lastEventId).toBe('ev-251');
    expect(events[1]?.id).toBe('ev-252');
    expect(events.at(-1)?.id).toBe(`ev-${totalSent}`);
  });

  it('enforces the 16 MiB serialized byte bound well below 1,000 events and preserves pageId', () => {
    const queue = new ConsumerObservationQueue();
    // 24 batches of ~1 MiB each = ~24 MiB (> 16 MiB) with only 24 events total.
    const oneMiBPad = 1024 * 1024;
    for (let i = 1; i <= 24; i += 1) {
      const pageId = i === 1 ? 'page-initial-1' : undefined;
      const prepared = prepareObservationBridgeFrame(
        makeObservationFrame([makeRequestEvent(i, oneMiBPad)], 'session-1', 'obs-1', pageId),
      );
      if (prepared === undefined || prepared.kind === 'empty') {
        throw new Error('Expected prepared observation batch');
      }
      queue.enqueue(prepared);
      expect(queue.queuedBytes).toBeLessThanOrEqual(MAX_PENDING_OBSERVATION_BYTES);
    }

    const drained: BridgeMessage[] = [];
    while (!queue.isEmpty) {
      const next = queue.shift();
      if (next !== undefined) drained.push(JSON.parse(next.payload) as BridgeMessage);
    }

    const firstFrame = drained[0];
    expect(firstFrame?.type).toBe('worker-message-result');
    if (firstFrame?.type === 'worker-message-result' && firstFrame.message.t === 'event') {
      expect(firstFrame.message.pageId).toBe('page-initial-1');
      const gap = firstFrame.message.events[0] as SandboxObservationGapEvent;
      expect(gap.kind).toBe('observation_gap');
      expect(gap.firstEventId).toBe('ev-1');
      expect(gap.omittedCount).toBeGreaterThanOrEqual(8);
      const nextFrame = drained[1];
      if (nextFrame?.type === 'worker-message-result' && nextFrame.message.t === 'event') {
        expect(nextFrame.message.events[0]?.id).toBe(`ev-${gap.omittedCount + 1}`);
      }
    }
  });

  it('preserves chronological event ordering before, between, and after multiple gaps', () => {
    const queue = new ConsumerObservationQueue(5, MAX_PENDING_OBSERVATION_BYTES);
    const pushEvent = (index: number) => {
      const prepared = prepareObservationBridgeFrame(makeObservationFrame([makeRequestEvent(index)]));
      if (prepared === undefined || prepared.kind === 'empty') {
        throw new Error('Expected prepared observation batch');
      }
      queue.enqueue(prepared);
    };

    // Wave 1: 8 events into a max-5 queue -> gap(ev-1..ev-4), live ev-5..ev-8.
    for (let i = 1; i <= 8; i += 1) pushEvent(i);
    // Consumer drains the first gap and two live events (ev-5, ev-6), leaving [ev-7, ev-8].
    const wave1Delivered: SandboxEvent[] = [];
    for (let k = 0; k < 3; k += 1) {
      const next = queue.shift();
      if (next !== undefined) {
        wave1Delivered.push(...extractEvents([JSON.parse(next.payload) as BridgeMessage]));
      }
    }

    // Wave 2: consumer stalls again while ev-9..ev-15 arrive (9 events queued -> ev-7..ev-11 become second gap).
    for (let i = 9; i <= 15; i += 1) pushEvent(i);
    while (!queue.isEmpty) {
      const next = queue.shift();
      if (next !== undefined) {
        wave1Delivered.push(...extractEvents([JSON.parse(next.payload) as BridgeMessage]));
      }
    }

    const summary = wave1Delivered.map(event =>
      event.kind === 'observation_gap'
        ? `gap:${event.firstEventId}..${event.lastEventId}(${event.omittedCount})`
        : event.id,
    );
    expect(summary).toEqual([
      'gap:ev-1..ev-4(4)',
      'ev-5',
      'ev-6',
      'gap:ev-7..ev-11(5)',
      'ev-12',
      'ev-13',
      'ev-14',
      'ev-15',
    ]);
  });

  it('delivers an operation reply and ping/pong to a stalled consumer while queuing observations, without affecting a healthy sibling consumer', () => {
    const slow = new ControlledConsumerSocket();
    slow.backpressured = true;
    slow.stalledBytes = OBSERVATION_SOCKET_HIGH_WATER_BYTES + 1024;

    const healthy = new ControlledConsumerSocket();

    for (let i = 1; i <= MAX_PENDING_OBSERVATION_EVENTS + 120; i += 1) {
      const frame = makeObservationFrame([makeRequestEvent(i)]);
      sendBridgeMessage(asWebSocket(slow), frame);
      sendBridgeMessage(asWebSocket(healthy), frame);
    }

    // Operation reply and control frame arrive while `slow` is still backpressured on observations.
    const opReply: BridgeMessage = {
      type: 'worker-message-result',
      clientSessionId: 'session-1',
      message: { t: 'res', id: 'op-live-1', clientSessionId: 'session-1', ok: true, value: { ok: 1 } },
    };
    const pong: BridgeMessage = { type: 'pong', id: 'hb-1' };
    sendBridgeMessage(asWebSocket(slow), opReply);
    sendBridgeMessage(asWebSocket(slow), pong);

    expect(slow.closes).toEqual([]);
    // Operation and control frames were scheduled independently and never dropped or blocked behind observations.
    expect(slow.sent).toEqual([opReply, pong]);

    // Sibling healthy consumer received every observation immediately with zero gaps.
    const healthyEvents = extractEvents(healthy.sent);
    expect(healthyEvents).toHaveLength(MAX_PENDING_OBSERVATION_EVENTS + 120);
    expect(healthyEvents.some(e => e.kind === 'observation_gap')).toBe(false);

    // Now `slow` drains its TCP socket and receives the gap + surviving observations.
    slow.sent.length = 0;
    slow.drainAll();

    expect(slow.closes).toEqual([]);
    const slowEvents = extractEvents(slow.sent);
    expect(slowEvents).toHaveLength(MAX_PENDING_OBSERVATION_EVENTS);
    const gap = slowEvents[0] as SandboxObservationGapEvent;
    expect(gap.kind).toBe('observation_gap');
    expect(gap.omittedCount).toBe(121);
    expect(gap.firstEventId).toBe('ev-1');
    expect(gap.lastEventId).toBe('ev-121');
    expect(slowEvents[1]?.id).toBe('ev-122');
    expect(slowEvents.at(-1)?.id).toBe(`ev-${MAX_PENDING_OBSERVATION_EVENTS + 120}`);
  });

  it('releases all queued memory and timers on drain and on disconnect', async () => {
    const createHeldBatchRef = (socket: ControlledConsumerSocket): WeakRef<object> => {
      const batch = [makeRequestEvent(1, 64 * 1024)];
      const ref = new WeakRef<object>(batch);
      sendBridgeMessage(asWebSocket(socket), makeObservationFrame(batch));
      return ref;
    };

    // 1. Drain cleanup.
    const drainedSocket = new ControlledConsumerSocket();
    drainedSocket.backpressured = true;
    drainedSocket.stalledBytes = OBSERVATION_SOCKET_HIGH_WATER_BYTES + 1024;
    const drainRef = createHeldBatchRef(drainedSocket);
    expect(drainedSocket.listenerCount('close')).toBe(1);
    drainedSocket.drainAll();
    drainedSocket.sent.length = 0;
    expect(drainedSocket.listenerCount('close')).toBe(0);
    expect(drainedSocket._socket.listenerCount('drain')).toBe(0);

    // 2. Disconnect cleanup without draining.
    const disconnectedSocket = new ControlledConsumerSocket();
    disconnectedSocket.backpressured = true;
    disconnectedSocket.stalledBytes = OBSERVATION_SOCKET_HIGH_WATER_BYTES + 1024;
    const disconnectRef = createHeldBatchRef(disconnectedSocket);
    expect(disconnectedSocket.listenerCount('close')).toBe(1);
    disconnectedSocket.close(1001, 'going away');
    expect(disconnectedSocket.listenerCount('close')).toBe(0);
    expect(disconnectedSocket._socket.listenerCount('drain')).toBe(0);
    expect(disconnectedSocket.sent).toEqual([]);

    await new Promise(resolve => setTimeout(resolve, 30));
    Bun.gc(true);
    await new Promise(resolve => setTimeout(resolve, 10));
    Bun.gc(true);

    expect(drainRef.deref()).toBeUndefined();
    expect(disconnectRef.deref()).toBeUndefined();
  });
});
