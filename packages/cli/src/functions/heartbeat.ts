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

/** Ten missed beats: how long a child that serves no HTTP function may stay silent. */
export const HEARTBEAT_FLOOR_MS = 10_000;

/** Cloud Functions' default `timeoutSeconds` for an HTTP function, in v1 and v2. */
const DEFAULT_HTTP_TIMEOUT_SECONDS = 60;

/** The largest `timeoutSeconds` an HTTP function may declare. */
const MAX_HTTP_TIMEOUT_SECONDS = 3_600;

/**
 * The longest silence to allow: the floor, or the longest timeout among the
 * served HTTP functions plus one beat, whichever is longer. The extra beat
 * covers the gap between the last beat and the request's start.
 */
export function heartbeatLimitMs(http: FunctionsChildHttpListener | undefined, floorMs: number): number {
  const timeouts = (http?.functions ?? []).map((fn) =>
    Math.min(fn.timeoutSeconds ?? DEFAULT_HTTP_TIMEOUT_SECONDS, MAX_HTTP_TIMEOUT_SECONDS));
  const servesHttp = timeouts.length > 0;
  if (!servesHttp) return floorMs;
  const longestRequestMs = Math.max(...timeouts) * 1_000 + HEARTBEAT_INTERVAL_MS;
  return Math.max(floorMs, longestRequestMs);
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
