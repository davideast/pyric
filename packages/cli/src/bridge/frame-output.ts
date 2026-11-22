import type { SandboxEvent, SandboxObservationGapEvent } from 'pyric/sandbox';
import type { EventStreamMessage, OutboundMessage } from '../serve/worker/protocol.js';
import {
  MAX_BRIDGE_FRAME_BYTES,
  MAX_QUEUED_OPERATION_BYTES,
  type BridgeMessage,
  type WorkerMessageResultFrame,
} from './protocol.js';

export const BRIDGE_FRAME_LIMIT_MESSAGE = 'Bridge response exceeds the 12 MiB encoded frame limit.';
/** Browser WebSocket.close permits application codes, not protocol code 1009. */
export const BROWSER_FRAME_LIMIT_CLOSE_CODE = 4009;

/** Per-consumer pending observation bounds (Ledger D7, #1385). */
export const MAX_PENDING_OBSERVATION_EVENTS = 1_000;
export const MAX_PENDING_OBSERVATION_BYTES = 16 * 1024 * 1024;
/** Socket bufferedAmount threshold above which observations wait in the consumer queue. */
export const OBSERVATION_SOCKET_HIGH_WATER_BYTES = 256 * 1024;

/** Reason a socket whose reader stalled on frames no operation can be told about. */
export const BRIDGE_BACKLOG_CLOSE_MESSAGE =
  `Client output backlog exceeds ${MAX_QUEUED_OPERATION_BYTES / (1024 * 1024)} MiB; reconnect to resume.`;

/** Error for a request that was never sent: it did not run, so its caller may retry. */
export const BRIDGE_BACKLOG_UNSENT_ERROR = {
  code: 'resource-exhausted',
  message: 'Bridge output backlog exceeded; the request was not sent. Retry this operation.',
};

/**
 * Error that replaces a response too large for the remaining backlog. The
 * operation already ran, so the text does not invite a retry of a write.
 */
export const BRIDGE_BACKLOG_UNDELIVERED_ERROR = {
  code: 'resource-exhausted',
  message:
    'Bridge output backlog exceeded; the response was not delivered. The operation may have completed.',
};

/**
 * Ceiling for one frame written to a socket already at its backlog limit: a
 * replacement error, or a response small enough to cost no more than one. The
 * correlation ids an error echoes come off the wire, so the bound cannot rest
 * on their being short.
 */
export const MAX_BACKLOG_REFUSAL_BYTES = 4 * 1024;

/** Error for a request whose own encoding is past the frame limit. */
export const BRIDGE_REQUEST_LIMIT_ERROR = {
  code: 'resource-exhausted',
  message: 'Bridge request exceeds the 12 MiB encoded frame limit.',
};

interface FrameError {
  code: string;
  message: string;
}

type ObservationFrame = WorkerMessageResultFrame & { message: EventStreamMessage };

const frameLimitError = { code: 'resource-exhausted', message: BRIDGE_FRAME_LIMIT_MESSAGE };
const utf8 = new TextEncoder();

function utf8ByteLength(value: string): number {
  return utf8.encode(value).byteLength;
}

/** Refuse an unsent request through its existing correlated reply owner. */
export function refuseBridgeRequest(frame: BridgeMessage, error: FrameError): BridgeMessage | undefined {
  if (frame.type === 'tool-call') return { type: 'tool-result', id: frame.id, ok: false, error };
  if (frame.type === 'worker-op') {
    return { type: 'worker-res', id: frame.id, clientSessionId: frame.clientSessionId, ok: false, error };
  }
  if (frame.type === 'worker-sub') {
    return { type: 'worker-snap', subId: frame.subId, clientSessionId: frame.clientSessionId, value: { __error: error } };
  }
  return undefined;
}

/** Replace an unsendable response with a small error under the same correlation id. */
export function failBridgeResponse(frame: BridgeMessage, error: FrameError): BridgeMessage | undefined {
  if (frame.type === 'tool-result') return { type: 'tool-result', id: frame.id, ok: false, error };
  if (frame.type === 'worker-res') {
    return { type: 'worker-res', id: frame.id, clientSessionId: frame.clientSessionId, ok: false, error };
  }
  if (frame.type === 'worker-message-result') {
    const message = frame.message;
    if (message.t !== 'res') return undefined;
    return {
      ...frame,
      message: { t: 'res', id: message.id, clientSessionId: message.clientSessionId, ok: false, error },
    };
  }
  return undefined;
}

const RTDB_WRITE_FIELDS = ['value', 'values', 'priority'] as const;

function childPath(path: string, key: string): string {
  return path.endsWith('/') ? `${path}${key}` : `${path}/${key}`;
}

/** Where `value` holds something JSON drops or turns into null, and what it is. */
function findJsonLoss(value: unknown, path: string): { path: string; found: string } | undefined {
  const isLost = value === undefined || (typeof value === 'number' && !Number.isFinite(value));
  if (isLost) return { path, found: String(value) };
  const isLeaf = typeof value !== 'object' || value === null;
  if (isLeaf) return undefined;
  for (const [key, child] of Object.entries(value)) {
    const loss = findJsonLoss(child, childPath(path, key));
    if (loss !== undefined) return loss;
  }
  return undefined;
}

/**
 * Refuse an RTDB write whose value JSON cannot carry. NaN and Infinity encode
 * as null and an undefined member vanishes, so the host would store a delete
 * (RP-1, #1362). The served client refuses these first with the SDK's text;
 * this is the second line.
 */
function assertJsonSafeRtdbWrite(frame: BridgeMessage): void {
  const isOtherFrame = frame.type !== 'worker-message';
  if (isOtherFrame) return;
  const message = frame.message;
  const isRtdbOperation = message.t === 'op' && message.method.startsWith('rtdb.');
  if (!isRtdbOperation) return;
  const fields: Record<string, unknown> = { ...message };
  const path = typeof fields.path === 'string' ? fields.path : '/';
  for (const field of RTDB_WRITE_FIELDS) {
    const isAbsent = !Object.hasOwn(fields, field);
    if (isAbsent) continue;
    const loss = findJsonLoss(fields[field], path);
    const isJsonSafe = loss === undefined;
    if (isJsonSafe) continue;
    throw new Error(
      `RTDB ${message.method} ${field} at ${loss.path} holds ${loss.found}, which a JSON frame cannot carry. The write was not sent.`,
    );
  }
}

function summarizeBatchRange(events: readonly SandboxEvent[]): {
  at: number;
  omittedCount: number;
  omittedDenials: number;
  firstEventId: string;
  lastEventId: string;
} | null {
  const first = events[0];
  const last = events.at(-1);
  if (first === undefined || last === undefined) return null;
  let omittedCount = 0;
  let omittedDenials = 0;
  for (const event of events) {
    if (event.kind === 'observation_gap') {
      omittedCount += event.omittedCount;
      omittedDenials += event.omittedDenials ?? 0;
      continue;
    }
    omittedCount += 1;
    const isDenial =
      (event.kind === 'request' || event.kind === 'operation') && event.result === 'deny';
    if (isDenial) omittedDenials += 1;
  }
  const firstEventId = first.kind === 'observation_gap' ? first.firstEventId : first.id;
  const lastEventId = last.kind === 'observation_gap' ? last.lastEventId : last.id;
  return {
    at: first.at,
    omittedCount,
    omittedDenials,
    firstEventId,
    lastEventId,
  };
}

function buildObservationGapEvent(summary: {
  at: number;
  omittedCount: number;
  omittedDenials: number;
  firstEventId: string;
  lastEventId: string;
}): SandboxObservationGapEvent {
  const gap: SandboxObservationGapEvent = {
    kind: 'observation_gap',
    id: `observation-gap:${summary.firstEventId}:${summary.lastEventId}`,
    at: summary.at,
    reason: 'frame-limit',
    omittedCount: summary.omittedCount,
    firstEventId: summary.firstEventId,
    lastEventId: summary.lastEventId,
  };
  if (summary.omittedDenials > 0) {
    gap.omittedDenials = summary.omittedDenials;
  }
  return gap;
}

function buildGapObservationFrame(options: {
  clientSessionId: string;
  messageClientSessionId?: string;
  subId: string;
  pageId?: string;
  at: number;
  omittedCount: number;
  omittedDenials: number;
  firstEventId: string;
  lastEventId: string;
}): ObservationFrame {
  const gapEvent = buildObservationGapEvent(options);
  const message: EventStreamMessage & { clientSessionId?: string } = {
    t: 'event',
    subId: options.subId,
    events: [gapEvent],
  };
  if (options.messageClientSessionId !== undefined) {
    message.clientSessionId = options.messageClientSessionId;
  }
  if (options.pageId !== undefined) {
    message.pageId = options.pageId;
  }
  return {
    type: 'worker-message-result',
    clientSessionId: options.clientSessionId,
    message,
  };
}

/** Encode bounded output, retaining correlation when an oversized result can be refused. */
export function encodeBridgeMessage(frame: BridgeMessage): string | undefined {
  assertJsonSafeRtdbWrite(frame);
  const payload = JSON.stringify(frame);
  const fitsFrameLimit = utf8ByteLength(payload) <= MAX_BRIDGE_FRAME_BYTES;
  if (fitsFrameLimit) return payload;
  const reducedFrame = reduceOversizedFrame(frame);
  const reduced = JSON.stringify(reducedFrame);
  const stillExceedsLimit = utf8ByteLength(reduced) > MAX_BRIDGE_FRAME_BYTES;
  if (stillExceedsLimit) return encodeObservationGap(reducedFrame);
  return reduced;
}

/** Keep an undeliverable observation batch from closing the operation connection. */
function encodeObservationGap(frame: BridgeMessage): string | undefined {
  if (!isObservationBridgeFrame(frame)) return undefined;
  const summary = summarizeBatchRange(frame.message.events);
  if (summary === null) return undefined;
  const refusal = buildGapObservationFrame({
    clientSessionId: frame.clientSessionId,
    messageClientSessionId: frame.message.clientSessionId,
    subId: frame.message.subId,
    pageId: frame.message.pageId,
    ...summary,
  });
  const payload = JSON.stringify(refusal);
  const fitsFrameLimit = utf8ByteLength(payload) <= MAX_BRIDGE_FRAME_BYTES;
  if (fitsFrameLimit) return payload;
  return undefined;
}

function reduceOversizedFrame(frame: BridgeMessage): BridgeMessage {
  switch (frame.type) {
    case 'tool-result':
      return { type: 'tool-result', id: frame.id, ok: false, error: frameLimitError };
    case 'worker-message-result':
      return { ...frame, message: reduceOversizedWorkerMessage(frame.message) };
    case 'worker-res':
      return {
        type: 'worker-res',
        id: frame.id,
        clientSessionId: frame.clientSessionId,
        ok: false,
        error: frameLimitError,
      };
    case 'worker-snap':
      return { ...frame, value: { __error: frameLimitError } };
    default:
      return frame;
  }
}

function reduceOversizedWorkerMessage(message: OutboundMessage): OutboundMessage {
  switch (message.t) {
    case 'res':
      return {
        t: 'res',
        id: message.id,
        clientSessionId: message.clientSessionId,
        ok: false,
        error: frameLimitError,
      };
    case 'snap':
      return { ...message, value: { __error: frameLimitError } };
    case 'event': {
      // Snapshot samples are optional; retain every observation and its metadata.
      const events = message.events.map(event => {
        const isSnapshotDelivery = event.kind === 'snapshot_delivery';
        if (isSnapshotDelivery) {
          const summary = { ...event };
          delete summary.sample;
          return summary;
        }
        return event;
      });
      return { ...message, events };
    }
    default:
      return message;
  }
}

export function isObservationBridgeFrame(frame: BridgeMessage): frame is ObservationFrame {
  return frame.type === 'worker-message-result' && frame.message.t === 'event';
}

interface PreparedObservationBatch {
  kind: 'batch' | 'gap';
  clientSessionId: string;
  messageClientSessionId?: string;
  subId: string;
  pageId?: string;
  eventCount: number;
  at: number;
  omittedCount: number;
  omittedDenials: number;
  firstEventId: string;
  lastEventId: string;
  payload: string;
  bytes: number;
}

export function prepareObservationBridgeFrame(
  frame: ObservationFrame,
): { kind: 'empty'; payload: string; bytes: number } | PreparedObservationBatch | undefined {
  const summary = summarizeBatchRange(frame.message.events);
  if (summary === null) {
    const emptyPayload = JSON.stringify(frame);
    const emptyBytes = utf8ByteLength(emptyPayload);
    if (emptyBytes > MAX_BRIDGE_FRAME_BYTES) return undefined;
    return { kind: 'empty', payload: emptyPayload, bytes: emptyBytes };
  }
  const directPayload = JSON.stringify(frame);
  const directBytes = utf8ByteLength(directPayload);
  if (directBytes <= MAX_BRIDGE_FRAME_BYTES) {
    const isSingleGap =
      frame.message.events.length === 1 && frame.message.events[0]?.kind === 'observation_gap';
    return {
      kind: isSingleGap ? 'gap' : 'batch',
      clientSessionId: frame.clientSessionId,
      messageClientSessionId: frame.message.clientSessionId,
      subId: frame.message.subId,
      pageId: frame.message.pageId,
      eventCount: frame.message.events.length,
      ...summary,
      payload: directPayload,
      bytes: directBytes,
    };
  }
  const reducedFrame = reduceOversizedFrame(frame) as ObservationFrame;
  const reducedPayload = JSON.stringify(reducedFrame);
  const reducedBytes = utf8ByteLength(reducedPayload);
  if (reducedBytes <= MAX_BRIDGE_FRAME_BYTES) {
    return {
      kind: 'batch',
      clientSessionId: frame.clientSessionId,
      messageClientSessionId: frame.message.clientSessionId,
      subId: frame.message.subId,
      pageId: frame.message.pageId,
      eventCount: reducedFrame.message.events.length,
      ...summary,
      payload: reducedPayload,
      bytes: reducedBytes,
    };
  }
  const gapFrame = buildGapObservationFrame({
    clientSessionId: frame.clientSessionId,
    messageClientSessionId: frame.message.clientSessionId,
    subId: frame.message.subId,
    pageId: frame.message.pageId,
    ...summary,
  });
  const gapPayload = JSON.stringify(gapFrame);
  const gapBytes = utf8ByteLength(gapPayload);
  if (gapBytes > MAX_BRIDGE_FRAME_BYTES) return undefined;
  return {
    kind: 'gap',
    clientSessionId: frame.clientSessionId,
    messageClientSessionId: frame.message.clientSessionId,
    subId: frame.message.subId,
    pageId: frame.message.pageId,
    eventCount: 1,
    ...summary,
    payload: gapPayload,
    bytes: gapBytes,
  };
}

/**
 * Per-consumer bounded observation queue (#1385).
 *
 * Caps queued observations for one consumer at `maxEvents` (1,000) and
 * `maxBytes` (16 MiB). When pressure exceeds either bound, the oldest queued
 * observation batch is converted in place into an `observation_gap` envelope
 * and coalesced with adjacent gaps on the same subscription, preserving chronological
 * ordering of live events before and after every gap.
 */
export class ConsumerObservationQueue {
  private readonly entries: PreparedObservationBatch[] = [];
  private totalEvents = 0;
  private totalBytes = 0;

  constructor(
    private readonly maxEvents = MAX_PENDING_OBSERVATION_EVENTS,
    private readonly maxBytes = MAX_PENDING_OBSERVATION_BYTES,
  ) {}

  get isEmpty(): boolean {
    return this.entries.length === 0;
  }

  get queuedEvents(): number {
    return this.totalEvents;
  }

  get queuedBytes(): number {
    return this.totalBytes;
  }

  enqueue(entry: PreparedObservationBatch): void {
    this.entries.push({ ...entry });
    this.totalEvents += entry.eventCount;
    this.totalBytes += entry.bytes;
    if (entry.kind === 'gap') {
      this.coalesceGapNeighbors(this.entries.length - 1);
    }
    this.enforceBounds();
  }

  peek(): { payload: string; bytes: number } | undefined {
    const head = this.entries[0];
    if (head === undefined) return undefined;
    return { payload: head.payload, bytes: head.bytes };
  }

  shift(): { payload: string; bytes: number } | undefined {
    const head = this.entries.shift();
    if (head === undefined) return undefined;
    this.totalEvents -= head.eventCount;
    this.totalBytes -= head.bytes;
    return { payload: head.payload, bytes: head.bytes };
  }

  clear(): void {
    this.entries.length = 0;
    this.totalEvents = 0;
    this.totalBytes = 0;
  }

  private enforceBounds(): void {
    while (this.totalEvents > this.maxEvents || this.totalBytes > this.maxBytes) {
      const batchIndex = this.entries.findIndex(item => item.kind === 'batch');
      if (batchIndex >= 0) {
        this.convertBatchToGap(batchIndex);
        this.coalesceGapNeighbors(batchIndex);
        continue;
      }
      if (this.entries.length <= 1) break;
      const dropped = this.entries.shift();
      if (dropped === undefined) break;
      this.totalEvents -= dropped.eventCount;
      this.totalBytes -= dropped.bytes;
    }
  }

  private convertBatchToGap(index: number): void {
    const current = this.entries[index];
    if (current === undefined || current.kind === 'gap') return;
    const gapFrame = buildGapObservationFrame(current);
    const payload = JSON.stringify(gapFrame);
    const bytes = utf8ByteLength(payload);
    this.totalEvents -= current.eventCount;
    this.totalBytes -= current.bytes;
    current.kind = 'gap';
    current.eventCount = 1;
    current.payload = payload;
    current.bytes = bytes;
    this.totalEvents += 1;
    this.totalBytes += bytes;
  }

  private sameStream(a: PreparedObservationBatch, b: PreparedObservationBatch): boolean {
    return a.clientSessionId === b.clientSessionId && a.subId === b.subId;
  }

  private reencodeGap(entry: PreparedObservationBatch): void {
    const gapFrame = buildGapObservationFrame(entry);
    const payload = JSON.stringify(gapFrame);
    const bytes = utf8ByteLength(payload);
    this.totalBytes -= entry.bytes;
    entry.payload = payload;
    entry.bytes = bytes;
    this.totalBytes += bytes;
  }

  private coalesceGapNeighbors(index: number): void {
    let currentIndex = index;
    const current = this.entries[currentIndex];
    if (current === undefined || current.kind !== 'gap') return;

    // Look backward for a gap on the same subscription with no live batch between them.
    for (let prevIndex = currentIndex - 1; prevIndex >= 0; prevIndex -= 1) {
      const candidate = this.entries[prevIndex];
      if (candidate === undefined) continue;
      if (!this.sameStream(candidate, current)) continue;
      if (candidate.kind === 'batch') break;
      candidate.omittedCount += current.omittedCount;
      candidate.omittedDenials += current.omittedDenials;
      candidate.lastEventId = current.lastEventId;
      if (candidate.pageId === undefined && current.pageId !== undefined) {
        candidate.pageId = current.pageId;
      }
      this.entries.splice(currentIndex, 1);
      this.totalEvents -= current.eventCount;
      this.totalBytes -= current.bytes;
      this.reencodeGap(candidate);
      currentIndex = prevIndex;
      break;
    }

    const active = this.entries[currentIndex];
    if (active === undefined || active.kind !== 'gap') return;

    // Look forward for a gap on the same subscription with no live batch between them.
    for (let nextIndex = currentIndex + 1; nextIndex < this.entries.length; nextIndex += 1) {
      const candidate = this.entries[nextIndex];
      if (candidate === undefined) continue;
      if (!this.sameStream(active, candidate)) continue;
      if (candidate.kind === 'batch') break;
      active.omittedCount += candidate.omittedCount;
      active.omittedDenials += candidate.omittedDenials;
      active.lastEventId = candidate.lastEventId;
      if (active.pageId === undefined && candidate.pageId !== undefined) {
        active.pageId = candidate.pageId;
      }
      this.entries.splice(nextIndex, 1);
      this.totalEvents -= candidate.eventCount;
      this.totalBytes -= candidate.bytes;
      this.reencodeGap(active);
      break;
    }
  }
}
