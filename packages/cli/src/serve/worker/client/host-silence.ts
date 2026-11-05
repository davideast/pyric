/**
 * How a hosted client decides its host has gone silent (ADR-0019, #2097).
 *
 * The host answers every `ping` at once, so it has gone silent once a ping
 * has waited {@link HOSTED_CLIENT_LIVENESS_TIMEOUT_MS} with no frame of any
 * kind arriving after it. The wait counts from the oldest unanswered ping, not
 * from the last frame heard: after five minutes hidden, Chrome runs a tab's
 * timer chains about once a minute, so two of the client's own heartbeats can
 * run 60 s apart while the host answered each one within milliseconds.
 *
 * A dead page is still the host's to find: it closes a socket that sends
 * nothing for `HOST_PEER_LIVENESS_TIMEOUT_MS`, which this does not change.
 */
import { HOSTED_CLIENT_LIVENESS_TIMEOUT_MS, HOSTED_HEARTBEAT_INTERVAL_MS } from '../../../bridge/protocol.js';

export interface HostSilence {
  /** A frame of any kind arrived from the host. */
  heard(): void;
  /** A ping went out. */
  pinged(now: number): void;
  /** True once a ping has gone unanswered for the liveness window. */
  hasGoneSilent(now: number): boolean;
  /** How long until the next heartbeat: one interval, or sooner when an unanswered ping's window ends first. */
  nextBeatIn(now: number): number;
}

/** A watch for one attached socket, which starts with nothing unanswered. */
export function watchHostSilence(): HostSilence {
  let unansweredSince: number | undefined;

  const unansweredFor = (now: number): number => (unansweredSince === undefined ? 0 : now - unansweredSince);

  return {
    heard: () => {
      unansweredSince = undefined;
    },
    pinged: (now) => {
      unansweredSince ??= now;
    },
    hasGoneSilent: (now) => {
      const isAwaitingAnswer = unansweredSince !== undefined;
      return isAwaitingAnswer && unansweredFor(now) >= HOSTED_CLIENT_LIVENESS_TIMEOUT_MS;
    },
    nextBeatIn: (now) => {
      const isAwaitingAnswer = unansweredSince !== undefined;
      if (!isAwaitingAnswer) return HOSTED_HEARTBEAT_INTERVAL_MS;
      const remainingMs = HOSTED_CLIENT_LIVENESS_TIMEOUT_MS - unansweredFor(now);
      return Math.max(0, Math.min(HOSTED_HEARTBEAT_INTERVAL_MS, remainingMs));
    },
  };
}
