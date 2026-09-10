/**
 * The page's mirror of the sandbox clock.
 *
 * The clock itself lives in the SharedWorker, alongside the sandbox that owns
 * it. Most of the page reads time through the worker, so it gets the clock's
 * answer for free. Two values do not: a push id and an in-flight upload's
 * `timeCreated` are minted on the page, synchronously, before the op that
 * carries them has been answered. Those two would otherwise read the wall
 * clock and contradict the sandbox they are about to land in.
 *
 * So the state is mirrored rather than fetched. `wirePort` asks the host to
 * stream it; the host answers immediately and again on every move, and
 * {@link sandboxNow} derives the instant from the mirror using the same three
 * modes the clock itself does. A port that has not been answered yet mirrors
 * the wall clock, which is what an unmoved clock reports anyway.
 */
import type { SandboxClockState } from 'pyric/sandbox';

/** The state a clock that has never been moved reports. */
const WALL: SandboxClockState = { mode: 'wall', fixedAt: 0, offsetMs: 0 };

let mirrored: SandboxClockState = WALL;

/** Adopt the state the host just sent. */
export function receiveClockState(state: SandboxClockState): void {
  mirrored = state;
}

/** The state the page currently believes the sandbox clock holds. */
export function mirroredClockState(): SandboxClockState {
  return mirrored;
}

/** The sandbox's current time, in epoch milliseconds, from the mirror. */
export function sandboxNow(): number {
  if (mirrored.mode === 'fixed') return mirrored.fixedAt;
  if (mirrored.mode === 'offset') return Date.now() + mirrored.offsetMs;
  return Date.now();
}
