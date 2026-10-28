/**
 * Host-side liveness for one bridge socket (#965).
 *
 * A page frozen in the back-forward cache, a killed tab, or a sleeping laptop
 * keeps its socket open without sending a close frame, so the host never
 * learns it left: its RTDB onDisconnect operations do not run and its
 * listeners stay registered. The watch closes such a socket once the client
 * has sent nothing for {@link HOST_PEER_LIVENESS_TIMEOUT_MS}.
 *
 * Only a client that heartbeats is watched. Every bridge client sends `ping`
 * every `HOSTED_HEARTBEAT_INTERVAL_MS` (ADR-0019). The web hosted client is
 * the only one that attaches with `transport: 'worker-port'`, so its watch
 * starts at that attach: a page frozen before its first ping is still closed.
 * The native clients and the Node remote client send their first `ping` at
 * attach, and any client is watched from its first `ping`. A client that
 * never pings, such as an app built before ADR-0019's heartbeat or the
 * in-page sandbox peer, is idle when quiet, not gone, and is left open. Once
 * the watch starts, any frame counts as traffic.
 *
 * Closing the socket runs the same path as any other close: the bridge tells
 * the host the consumer was interrupted, and the host runs its onDisconnect
 * operations (`Bridge.interruptConsumer`).
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
