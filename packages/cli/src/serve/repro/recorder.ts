/**
 * The Node host's operation log for repro files.
 *
 * The recorder keeps the frames every port sends and receives, in the order
 * the host handles them, and the starting state the log applies to. Memory is
 * bounded: the log is kept in windows of at most `limit` entries. When the
 * current window is full, the recorder reads a new starting state and opens a
 * new window, and the window before the previous one is dropped. A repro
 * therefore holds between `limit` and twice `limit` entries, replayed from the
 * starting state of the older window it carries.
 *
 * Denied replies dropped with older windows are retained in a separate bounded
 * denial lane so `pyric serve denials` still reports early denials after
 * sustained allowed traffic. Archived replies carry no matching inbound frame,
 * so replay skips them cleanly.
 *
 * The starting state is read between frames. A frame another port is still
 * handling while it is read can land on either side of it; replay reports such
 * a frame as a divergence rather than hiding it.
 *
 * An observed call is recorded without its claim values, write data and
 * returned document: the host holds those in memory for its local rules, and
 * a repro file is made to share.
 */
import type { ObservedCall } from 'pyric/sandbox';
import type { InboundMessage, OutboundMessage, SerializedError } from '../worker/protocol.js';
import { isPlainObject, type ReproBase, type ReproEntry } from './format.js';

/** Entries one window holds before the recorder reads a new starting state. */
export const DEFAULT_REPRO_WINDOW = 1000;

/** Encoded JSON bytes one window holds before the recorder opens a new window. */
export const DEFAULT_REPRO_WINDOW_BYTES = 2 * 1024 * 1024;

const DEFAULT_RETAINED_DENIALS = 1000;
const DEFAULT_RETAINED_DENIAL_BYTES = 2 * 1024 * 1024;
const DENIAL_QUEUE_COMPACT_THRESHOLD = 256;
const MAX_EVICTION_SKIP_INBOUNDS = 32;
const utf8 = new TextEncoder();

/** What the host supplies when a window opens; the recorder adds the listeners it tracked. */
export type ReproBaseCapture = () => Promise<Omit<ReproBase, 'subscriptions'>>;

/** An upload chunk whose bytes live in the host's staging file until a repro file is written. */
export interface RecordedUploadSlice {
  kind: 'upload-slice';
  at: number;
  uploadId: string;
  partIndex: number;
  offset: number;
  length: number;
}

export type RecordedEntry = ReproEntry | RecordedUploadSlice;

type OutboundReproEntry = Extract<ReproEntry, { kind: 'out' }>;

interface ArchivedDenial {
  entry: OutboundReproEntry;
  bytes: number;
}

interface Window {
  base: ReproBase;
  entries: RecordedEntry[];
  bytes: number;
}

export interface ReproLog {
  base: ReproBase;
  entries: RecordedEntry[];
  truncated: boolean;
}

export interface ReproRecorder {
  /** Record a frame a port sent. Resolves once it is in the log, after any new starting state is read. */
  inbound(session: string, frame: InboundMessage): Promise<void>;
  /** Record a result or listener event the host sent a port. */
  outbound(session: string, frame: OutboundMessage): void;
  /** Record a rules deploy, transport disconnect, byte-route upload, or out-of-band state change. */
  note(entry: Exclude<ReproEntry, { kind: 'in' | 'out' }> | RecordedUploadSlice): void;
  /** The log since the oldest starting state kept. Reads a starting state when nothing is recorded yet. */
  log(): Promise<ReproLog>;
}

/**
 * Event-stream and clock frames are Studio telemetry, and a live Node
 * process's unobserved lists are host status, not application operations.
 */
function isRecordedInbound(frame: InboundMessage): boolean {
  if (frame.t === 'clock-subscribe' || frame.t === 'unobserved') return false;
  const isEventStream = frame.t === 'sub' && frame.target === 'events';
  return !isEventStream;
}

/**
 * An observe frame's outcome without production's message, which only the
 * host's terminal prints: a message can quote document data, such as the
 * value Firestore's invalid-data error names.
 */
function recordedOutcome(outcome: ObservedCall['outcome']): ObservedCall['outcome'] {
  if (outcome.status !== 'error') return outcome;
  const { message: _message, ...answer } = outcome;
  return answer;
}

/** An observe frame without the values the host keeps in memory only, or the terminal prints only; any other frame as it came. */
function recordedFrame(frame: InboundMessage): InboundMessage {
  if (frame.t !== 'observe') return frame;
  const { sessionData: _sessionData, ...restFrame } = frame;
  const { writeData: _writeData, document: _document, account, outcome, ...rest } = restFrame.call;
  const call = { ...rest, outcome: recordedOutcome(outcome) };
  if (account === undefined) return { ...restFrame, call };
  const { claims: _claims, ...named } = account;
  return { ...restFrame, call: { ...call, account: named } };
}

function isSerializedDenialError(value: unknown): value is SerializedError {
  if (!isPlainObject(value)) return false;
  if (typeof value.code !== 'string' || typeof value.message !== 'string') return false;
  return isPlainObject(value.denialContext);
}

function encodedValueBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    if (typeof Buffer === 'function') return Buffer.byteLength(json);
    return utf8.encode(json).byteLength;
  } catch {
    return Infinity;
  }
}

function encodedEntryBytes(entry: RecordedEntry): number {
  return encodedValueBytes(entry);
}

/**
 * Normalizes a dropped denial reply into a replay-safe `res` error entry.
 * Dropped `snap` denials are converted to failed `res` entries keyed by `subId`
 * so `listDenials` reads them identically while `replayRepro` skips them
 * without waiting for a missing listener delivery.
 */
function archivedDenialEntry(entry: RecordedEntry): OutboundReproEntry | null {
  if (entry.kind !== 'out') return null;
  const { frame } = entry;
  if (frame.t === 'res' && !frame.ok && isSerializedDenialError(frame.error)) {
    return entry;
  }
  if (frame.t !== 'snap') return null;
  if (!isPlainObject(frame.value)) return null;
  const snapError = frame.value.__error;
  if (!isSerializedDenialError(snapError)) return null;
  const archivedFrame: OutboundMessage = {
    t: 'res',
    id: frame.subId,
    ok: false,
    error: snapError,
  };
  if (frame.clientSessionId !== undefined) {
    archivedFrame.clientSessionId = frame.clientSessionId;
  }
  return {
    kind: 'out',
    at: entry.at,
    session: entry.session,
    frame: archivedFrame,
  };
}

export function createReproRecorder(options: {
  capture: ReproBaseCapture;
  limit?: number;
  byteLimit?: number;
  denialLimit?: number;
  denialByteLimit?: number;
  now?: () => number;
  onDrop?: (dropped: RecordedEntry[], retained: RecordedEntry[]) => void;
}): ReproRecorder {
  const limit = Math.max(1, options.limit ?? DEFAULT_REPRO_WINDOW);
  const byteLimit = Math.max(1, options.byteLimit ?? DEFAULT_REPRO_WINDOW_BYTES);
  const maxRetainedBytes = byteLimit * 2;
  const denialLimit = Math.max(0, options.denialLimit ?? DEFAULT_RETAINED_DENIALS);
  const denialByteLimit = Math.max(0, options.denialByteLimit ?? DEFAULT_RETAINED_DENIAL_BYTES);
  const now = options.now ?? Date.now;
  let previous: Window | undefined;
  let current: Window | undefined;
  let truncated = false;
  let opening: Promise<void> | undefined;
  let consecutiveOversizedEvictions = 0;
  let skipOpenInboundsRemaining = 0;
  let retainedDenials: Array<ArchivedDenial | undefined> = [];
  let retainedDenialHead = 0;
  let retainedDenialBytes = 0;
  /** Listener registrations still open, by session then subscription id. */
  const open = new Map<string, Map<string, InboundMessage>>();

  function openSubscriptions(): Record<string, InboundMessage[]> {
    const copy: Record<string, InboundMessage[]> = {};
    for (const [session, subs] of open) {
      if (subs.size > 0) copy[session] = [...subs.values()];
    }
    return copy;
  }

  function shiftRetainedDenial(): void {
    if (retainedDenialHead >= retainedDenials.length) return;
    const dropped = retainedDenials[retainedDenialHead];
    retainedDenials[retainedDenialHead] = undefined;
    retainedDenialHead += 1;
    if (dropped !== undefined) retainedDenialBytes -= dropped.bytes;
    if (
      retainedDenialHead > DENIAL_QUEUE_COMPACT_THRESHOLD
      && retainedDenialHead * 2 >= retainedDenials.length
    ) {
      retainedDenials = retainedDenials.slice(retainedDenialHead);
      retainedDenialHead = 0;
    }
  }

  function archiveDroppedDenials(droppedEntries: RecordedEntry[]): void {
    if (denialLimit === 0 || denialByteLimit === 0) return;
    for (const entry of droppedEntries) {
      const archived = archivedDenialEntry(entry);
      if (archived === null) continue;
      const bytes = encodedEntryBytes(archived);
      if (!Number.isFinite(bytes) || bytes > denialByteLimit) continue;
      retainedDenials.push({ entry: archived, bytes });
      retainedDenialBytes += bytes;
      while (
        retainedDenials.length - retainedDenialHead > denialLimit
        || retainedDenialBytes > denialByteLimit
      ) {
        shiftRetainedDenial();
      }
    }
  }

  function isUploadEntry(entry: RecordedEntry): boolean {
    return entry.kind === 'upload-slice' || entry.kind === 'upload';
  }

  function dropPreviousWindow(): void {
    if (previous === undefined) return;
    const dropped = previous;
    previous = undefined;
    truncated = true;
    archiveDroppedDenials(dropped.entries);
    let retainedEntries: RecordedEntry[] = [];
    if (current !== undefined) {
      retainedEntries = current.entries;
    }
    options.onDrop?.(dropped.entries, retainedEntries);
  }

  function evictAllWindows(recordOversizedBackoff: boolean): void {
    const hadOpenWindow = current !== undefined;
    const droppedEntries: RecordedEntry[] = [];
    if (previous !== undefined) {
      for (const item of previous.entries) droppedEntries.push(item);
      previous = undefined;
    }
    if (current !== undefined) {
      for (const item of current.entries) droppedEntries.push(item);
      current = undefined;
    }
    truncated = true;
    if (droppedEntries.length > 0) {
      archiveDroppedDenials(droppedEntries);
      options.onDrop?.(droppedEntries, []);
    }
    if (recordOversizedBackoff && hadOpenWindow) {
      consecutiveOversizedEvictions += 1;
      if (consecutiveOversizedEvictions >= 2) {
        const power = Math.min(5, consecutiveOversizedEvictions - 1);
        skipOpenInboundsRemaining = Math.min(MAX_EVICTION_SKIP_INBOUNDS, 2 ** power);
      }
    }
  }

  /** Read a starting state and make it the current window. Concurrent callers share one read. */
  function openWindow(): Promise<void> {
    opening ??= (async () => {
      try {
        const subscriptions = openSubscriptions();
        const base = { ...(await options.capture()), subscriptions };
        const retained = current;
        if (retained !== undefined) {
          dropPreviousWindow();
          previous = retained;
        }
        current = { base, entries: [], bytes: 0 };
      } finally {
        opening = undefined;
      }
    })();
    return opening;
  }

  function track(session: string, frame: InboundMessage): void {
    if (frame.t === 'sub') {
      let subs = open.get(session);
      if (!subs) {
        subs = new Map();
        open.set(session, subs);
      }
      subs.set(frame.subId, frame);
    } else if (frame.t === 'unsub') {
      open.get(session)?.delete(frame.subId);
    } else if (frame.t === 'disconnect') {
      open.delete(session);
    }
  }

  function append(entry: RecordedEntry, bytes: number): void {
    if (current === undefined) {
      archiveDroppedDenials([entry]);
      if (isUploadEntry(entry)) {
        options.onDrop?.([entry], []);
      }
      return;
    }
    if (!Number.isFinite(bytes) || current.bytes + bytes > maxRetainedBytes) {
      evictAllWindows(true);
      archiveDroppedDenials([entry]);
      if (isUploadEntry(entry)) {
        options.onDrop?.([entry], []);
      }
      return;
    }
    current.entries.push(entry);
    current.bytes += bytes;
    if (previous !== undefined && previous.bytes + current.bytes > maxRetainedBytes) {
      dropPreviousWindow();
    }
  }

  return {
    async inbound(session, frame) {
      if (!isRecordedInbound(frame)) return;
      const cleanFrame = recordedFrame(frame);
      const frameBytes = encodedValueBytes(cleanFrame);
      const sessionBytes = encodedValueBytes(session);
      const estimatedBytes = frameBytes + sessionBytes + 52;
      if (!Number.isFinite(estimatedBytes) || estimatedBytes > maxRetainedBytes) {
        evictAllWindows(false);
        track(session, frame);
        return;
      }
      if (current !== undefined) {
        consecutiveOversizedEvictions = 0;
        skipOpenInboundsRemaining = 0;
      } else if (skipOpenInboundsRemaining > 0) {
        skipOpenInboundsRemaining -= 1;
        truncated = true;
        track(session, frame);
        return;
      }
      const needsWindow =
        current === undefined
        || current.entries.length >= limit
        || (current.bytes > 0 && current.bytes + estimatedBytes > byteLimit);
      if (needsWindow) {
        try {
          await openWindow();
        } catch (error) {
          // The host keeps serving; the next frame tries again.
          console.warn(`[pyric] The repro log could not read a starting state: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const at = now();
      const entry: RecordedEntry = { kind: 'in', at, session, frame: cleanFrame };
      const exactBytes = frameBytes + sessionBytes + String(at).length + 39;
      append(entry, exactBytes);
      track(session, frame);
    },
    outbound(session, frame) {
      const isRecorded = frame.t === 'res' || frame.t === 'snap';
      if (!isRecorded) return;
      const entry: RecordedEntry = { kind: 'out', at: now(), session, frame };
      append(entry, encodedEntryBytes(entry));
    },
    note(entry) {
      if (entry.kind === 'client' && entry.event === 'disconnect') {
        open.delete(entry.session);
      }
      append(entry, encodedEntryBytes(entry));
    },
    async log() {
      if (current === undefined) await openWindow();
      const newest = current as Window;
      const oldest = previous ?? newest;
      const entries: RecordedEntry[] = [];
      for (let index = retainedDenialHead; index < retainedDenials.length; index++) {
        const archived = retainedDenials[index];
        if (archived !== undefined) entries.push(archived.entry);
      }
      if (previous !== undefined) {
        for (const entry of previous.entries) entries.push(entry);
      }
      for (const entry of newest.entries) entries.push(entry);
      return { base: oldest.base, entries, truncated };
    },
  };
}
