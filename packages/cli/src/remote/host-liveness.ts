/**
 * Client-side heartbeat for the Node remote client (ADR-0019, #973).
 *
 * The client pings once at attach, which starts the host's own watch, then
 * every {@link HOSTED_HEARTBEAT_INTERVAL_MS} while attached. Before each ping
 * it checks how long the host has been silent: once no frame of any kind has
 * arrived for {@link HOST_SILENCE_TIMEOUT_MS}, the socket is treated as
 * dropped and `onSilent` runs once instead of pinging a socket the host has
 * already closed. The watch belongs to one socket and never outlives it.
 *
 * Every timer is unref'd, so an idle attached client never keeps a finished
 * script alive.
 */
import { HOSTED_HEARTBEAT_INTERVAL_MS, type BridgeMessage } from '../bridge/protocol.js';

/**
 * Silence that counts as a drop: three heartbeats, as the web client uses.
 * ADR-0019's heartbeat amendment names this value; the shared constant in
 * `bridge/protocol.ts` replaces this one once both land.
 */
export const HOST_SILENCE_TIMEOUT_MS = 45_000;

interface HeartbeatTiming {
  intervalMs: number;
  timeoutMs: number;
}

const DEFAULT_TIMING: HeartbeatTiming = { intervalMs: HOSTED_HEARTBEAT_INTERVAL_MS, timeoutMs: HOST_SILENCE_TIMEOUT_MS };
let timing = DEFAULT_TIMING;

/**
 * Shorten the heartbeat for a test; `undefined` restores it. The 15 and 45
 * seconds are fixed by ADR-0019; this is not a user setting and no public
 * entry point exports it.
 */
export function setHeartbeatForTesting(next: HeartbeatTiming | undefined): void {
  timing = next ?? DEFAULT_TIMING;
}

export interface HostLivenessOptions {
  /** Send one frame on the watched socket; a throw counts as a drop. */
  send(message: BridgeMessage): void;
  /** Called once, with the silence window, when the host has gone silent or the ping cannot be sent. */
  onSilent(timeoutMs: number): void;
}

export interface HostLiveness {
  /** Record a frame from the host. */
  heard(): void;
  /** Stop the watch; called when the socket closes. Idempotent. */
  stop(): void;
}

/** Ping now and on every interval; call `onSilent` once the host stops answering. */
export function watchHostLiveness(options: HostLivenessOptions): HostLiveness {
  const { intervalMs, timeoutMs } = timing;
  let lastHeardAt = Date.now();
  let pings = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function stop(): void {
    stopped = true;
    clearTimeout(timer);
    timer = undefined;
  }

  function drop(): void {
    stop();
    options.onSilent(timeoutMs);
  }

  function ping(): void {
    pings += 1;
    try {
      options.send({ type: 'ping', id: `heartbeat-${pings}` });
    } catch {
      drop();
      return;
    }
    schedule();
  }

  function schedule(): void {
    if (stopped) return;
    const remainingMs = timeoutMs - (Date.now() - lastHeardAt);
    timer = setTimeout(beat, Math.max(0, Math.min(intervalMs, remainingMs)));
    timer.unref?.();
  }

  function beat(): void {
    const hasGoneSilent = Date.now() - lastHeardAt >= timeoutMs;
    if (hasGoneSilent) {
      drop();
      return;
    }
    ping();
  }

  ping();
  return {
    heard: () => {
      lastHeardAt = Date.now();
    },
    stop,
  };
}
