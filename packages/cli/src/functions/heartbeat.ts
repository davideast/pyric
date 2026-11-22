/**
 * How the host tells a wedged Functions child from a busy one. The child
 * beats every HEARTBEAT_INTERVAL_MS while its event loop runs. A handler doing
 * synchronous work stops the beats too, and production lets that handler run
 * until its own `timeoutSeconds`, so the host waits that long before it calls
 * the child unresponsive.
 *
 * Silence is measured on the monotonic clock. `performance.now()` does not
 * advance while a laptop sleeps, so the first check after waking sees the
 * gap since the last beat before sleep, not the hours spent asleep.
 */
import { HEARTBEAT_INTERVAL_MS, type FunctionsChildHttpListener } from './child-protocol.js';

/** Ten missed beats: how long a child that serves no function may stay silent. */
export const HEARTBEAT_FLOOR_MS = 10_000;

/** Cloud Functions' default `timeoutSeconds` across HTTP and event-driven triggers. */
const DEFAULT_TRIGGER_TIMEOUT_SECONDS = 60;

/** Maximum `timeoutSeconds` for event-driven functions and 1st-gen HTTP functions. */
const MAX_EVENT_TIMEOUT_SECONDS = 540;

/** Maximum `timeoutSeconds` for 2nd-gen HTTP and callable functions. */
const MAX_HTTP_V2_TIMEOUT_SECONDS = 3_600;

/**
 * The longest silence to allow: the floor, or the longest timeout among the
 * child's HTTP and event-driven triggers plus one beat, whichever is longer.
 * The extra beat covers the gap between the last beat and the invocation start.
 */
export function heartbeatLimitMs(
  http: FunctionsChildHttpListener | undefined,
  floorMs: number,
  eventTimeouts?: readonly (number | null)[],
): number {
  const timeouts: number[] = [];
  for (const fn of http?.functions ?? []) {
    let maxSeconds = MAX_HTTP_V2_TIMEOUT_SECONDS;
    if (fn.platform === 'gcfv1') {
      maxSeconds = MAX_EVENT_TIMEOUT_SECONDS;
    }
    const declared = fn.timeoutSeconds ?? DEFAULT_TRIGGER_TIMEOUT_SECONDS;
    timeouts.push(Math.min(declared, maxSeconds));
  }
  for (const rawTimeout of eventTimeouts ?? []) {
    const declared = rawTimeout ?? DEFAULT_TRIGGER_TIMEOUT_SECONDS;
    timeouts.push(Math.min(declared, MAX_EVENT_TIMEOUT_SECONDS));
  }
  if (timeouts.length === 0) {
    return floorMs;
  }
  const longestInvocationMs = Math.max(...timeouts) * 1_000 + HEARTBEAT_INTERVAL_MS;
  return Math.max(floorMs, longestInvocationMs);
}

export interface HeartbeatWatch {
  beat(): void;
  stop(): void;
}

export interface HeartbeatWatchOptions {
  limitMs: number;
  /** Called once, the first time the silence passes `limitMs`. */
  onSilent(): void;
  /** Whether the host is stopping the child, when silence is expected. */
  isStopping(): boolean;
}

export function watchHeartbeat(options: HeartbeatWatchOptions): HeartbeatWatch {
  let lastBeat = performance.now();
  let reported = false;
  const check = (): void => {
    const isSilent = performance.now() - lastBeat > options.limitMs;
    const shouldReport = isSilent && !reported && !options.isStopping();
    if (!shouldReport) return;
    reported = true;
    options.onSilent();
  };
  const timer = setInterval(check, Math.min(1_000, options.limitMs / 2));
  timer.unref();
  return {
    beat: () => { lastBeat = performance.now(); },
    stop: () => clearInterval(timer),
  };
}
