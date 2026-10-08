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
 * The starting state is read between frames. A frame another port is still
 * handling while it is read can land on either side of it; replay reports such
 * a frame as a divergence rather than hiding it.
 */
import type { InboundMessage, OutboundMessage } from '../worker/protocol.js';
import type { ReproBase, ReproEntry } from './format.js';

/** Entries one window holds before the recorder reads a new starting state. */
export const DEFAULT_REPRO_WINDOW = 1000;

/** What the host supplies when a window opens; the recorder adds the listeners it tracked. */
export type ReproBaseCapture = () => Promise<Omit<ReproBase, 'subscriptions'>>;

interface Window {
  base: ReproBase;
  entries: ReproEntry[];
}

export interface ReproLog {
  base: ReproBase;
  entries: ReproEntry[];
  truncated: boolean;
}

export interface ReproRecorder {
  /** Record a frame a port sent. Resolves once it is in the log, after any new starting state is read. */
  inbound(session: string, frame: InboundMessage): Promise<void>;
  /** Record a result or listener event the host sent a port. */
  outbound(session: string, frame: OutboundMessage): void;
  /** Record a rules deploy or an out-of-band state change. */
  note(entry: Extract<ReproEntry, { kind: 'rules' | 'external' }>): void;
  /** The log since the oldest starting state kept. Reads a starting state when nothing is recorded yet. */
  log(): Promise<ReproLog>;
}

/** Event-stream and clock frames are Studio telemetry, not application operations. */
function isRecordedInbound(frame: InboundMessage): boolean {
  if (frame.t === 'clock-subscribe') return false;
  const isEventStream = frame.t === 'sub' && frame.target === 'events';
  return !isEventStream;
}

export function createReproRecorder(options: { capture: ReproBaseCapture; limit?: number; now?: () => number }): ReproRecorder {
  const limit = Math.max(1, options.limit ?? DEFAULT_REPRO_WINDOW);
  const now = options.now ?? Date.now;
  let previous: Window | undefined;
  let current: Window | undefined;
  let truncated = false;
  let opening: Promise<void> | undefined;
  /** Listener registrations still open, by session then subscription id. */
  const open = new Map<string, Map<string, InboundMessage>>();

  function openSubscriptions(): Record<string, InboundMessage[]> {
    const copy: Record<string, InboundMessage[]> = {};
    for (const [session, subs] of open) {
      if (subs.size > 0) copy[session] = [...subs.values()];
    }
    return copy;
  }

  /** Read a starting state and make it the current window. Concurrent callers share one read. */
  function openWindow(): Promise<void> {
    opening ??= (async () => {
      try {
        const subscriptions = openSubscriptions();
        const base = { ...(await options.capture()), subscriptions };
        const hadCurrent = current !== undefined;
        if (hadCurrent) {
          const dropsWindow = previous !== undefined;
          if (dropsWindow) truncated = true;
          previous = current;
        }
        current = { base, entries: [] };
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

  function append(entry: ReproEntry): void {
    current?.entries.push(entry);
  }

  return {
    async inbound(session, frame) {
      if (!isRecordedInbound(frame)) return;
      const needsWindow = current === undefined || current.entries.length >= limit;
      if (needsWindow) {
        try {
          await openWindow();
        } catch (error) {
          // The host keeps serving; the next frame tries again.
          console.warn(`[pyric] The repro log could not read a starting state: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      append({ kind: 'in', at: now(), session, frame });
      track(session, frame);
    },
    outbound(session, frame) {
      const isRecorded = frame.t === 'res' || frame.t === 'snap';
      if (isRecorded) append({ kind: 'out', at: now(), session, frame });
    },
    note(entry) {
      append(entry);
    },
    async log() {
      if (current === undefined) await openWindow();
      const newest = current as Window;
      const oldest = previous ?? newest;
      const entries = previous ? [...previous.entries, ...newest.entries] : [...newest.entries];
      return { base: oldest.base, entries, truncated };
    },
  };
}
