/**
 * Host-side liveness for one bridge socket (#965).
 *
 * A page frozen in the back-forward cache, a killed tab, or a sleeping laptop
 * keeps its socket open without sending a close frame, so the host never
 * learns it left: its RTDB onDisconnect operations do not run and its
 * listeners stay registered. The watch closes such a socket once the client
 * has sent nothing for {@link HOST_PEER_LIVENESS_TIMEOUT_MS}.
 *
 * Only a client that heartbeats is watched. The web hosted client sends
 * `ping` every `HOSTED_HEARTBEAT_INTERVAL_MS` and is the only client that
 * attaches with `transport: 'worker-port'`, so the watch starts at that
 * attach: a page frozen before its first ping is still closed. Any other
 * client is watched from its first `ping`. The native clients, the Node
 * remote client, and the in-page sandbox peer send no application ping
 * (ADR-0019), so a quiet one is idle, not gone, and is left open. Once the
 * watch starts, any frame counts as traffic.
 */
import { HOST_PEER_LIVENESS_TIMEOUT_MS } from '../protocol.js';

export interface PeerLiveness {
  /** Record a frame from the client. */
  heard(): void;
  /** Record a frame from a client that heartbeats, and start the watch if it has not started. */
  start(): void;
  /** Stop watching; called when the socket closes. */
  stop(): void;
}

/** Call `onSilent` once a heartbeating client has sent nothing for `timeoutMs`. */
export function watchPeerLiveness(
  onSilent: () => void,
  timeoutMs: number = HOST_PEER_LIVENESS_TIMEOUT_MS,
): PeerLiveness {
  let lastHeardAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function schedule(delayMs: number): void {
    timer = setTimeout(check, delayMs);
    timer.unref?.();
  }

  function check(): void {
    const silentForMs = Date.now() - lastHeardAt;
    const hasGoneSilent = silentForMs >= timeoutMs;
    if (hasGoneSilent) {
      stop();
      onSilent();
      return;
    }
    schedule(timeoutMs - silentForMs);
  }

  function heard(): void {
    lastHeardAt = Date.now();
  }

  function start(): void {
    heard();
    const isWatching = timer !== undefined;
    const cannotStart = stopped || isWatching;
    if (cannotStart) return;
    schedule(timeoutMs);
  }

  function stop(): void {
    stopped = true;
    clearTimeout(timer);
    timer = undefined;
  }

  return { heard, start, stop };
}
