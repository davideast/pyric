/**
 * The sandbox's one source of time.
 *
 * Every value the sandbox stamps that claims to be "when this happened" reads
 * this clock: Firestore `serverTimestamp()` and `request.time`, Realtime
 * Database `ServerValue.TIMESTAMP` and rules `now`, Storage `timeCreated` /
 * `updated` and its `request.time`, auth token `iat` / `exp` / `auth_time` and
 * account metadata, listener dispatch stamps, and the event, checkpoint, and
 * persistence stamps that record when a sandbox operation happened. Moving the
 * clock therefore moves every one of those together, which is the whole point:
 * a rule that reads `request.time` and a document that carries a
 * `serverTimestamp()` written in the same operation agree about what time it
 * is.
 *
 * ## The model
 *
 * Three modes, one number each.
 *
 * - `wall` (the default): `now()` is `Date.now()`. Nothing about the sandbox's
 *   behaviour differs from a build with no clock at all.
 * - `fixed`: {@link SandboxClock.set} names an instant and **freezes** the
 *   clock there. `now()` returns that instant until the clock is moved again.
 *   Naming an exact instant is a request for determinism, so time stops.
 * - `offset`: {@link SandboxClock.advance} from `wall` shifts the clock by a
 *   delta and lets it **keep flowing**. Jumping forward a day is a request to
 *   be a day later, not a request to stop, and monotonic progress is what push
 *   ids, listener ordering, and elapsed-time bookkeeping rely on.
 *
 * `advance` is consistent with whichever mode it finds. From `wall` it opens an
 * offset; from `offset` it grows that offset; from `fixed` it moves the frozen
 * instant and stays frozen. {@link SandboxClock.reset} returns to `wall`.
 *
 * ## The host clock can step back; the sandbox clock does not
 *
 * The clock stands in for Firebase's servers, and their clock never steps
 * back. A developer's host clock can (WSL2 steps back about 1.5 s every 30 s),
 * so in `wall` and `offset` mode `now()` never returns less than the last value
 * it returned. A backward step shows up as time standing still until the host
 * catches up. Without this, `request.time > resource.data.updatedAt` could deny
 * a valid write and sequential push ids could sort out of order (#1255).
 *
 * The floor guards against the host, not the caller. Every explicit move
 * (`set`, `advance`, `reset`, `restore`) drops it, so a negative `advance` still
 * moves the clock back, and a caller who pins an instant in the past with
 * `set` gets an instant in the past. That is the caller's decision to make.
 *
 * {@link ClockReading} holds this rule, and every plane that derives an
 * instant from a clock state reads through it: the clock itself, and the
 * page's mirror of a clock hosted in a SharedWorker.
 *
 * Node-safe and browser-safe: it reads `Date.now()` and nothing else.
 */

import { SandboxError } from './types/errors.js';
import type { Sandbox } from './types/service.js';

/**
 * The key a sandbox carries its clock under. Registered globally
 * (`Symbol.for`) rather than minted per module, because a workspace can load
 * this module twice (a package specifier resolving to the built output, a
 * relative path resolving to the source) and a per-module symbol would make
 * {@link getClock} fail to recognize a sandbox built by the other copy.
 */
export const SANDBOX_CLOCK = Symbol.for('pyric.sandbox.clock');

/**
 * Resolve one sandbox's clock. The clock is the sandbox's whole notion of
 * time: every `serverTimestamp()`, `request.time`, token `iat`, and event stamp
 * on that sandbox reads it, so moving it here moves all of them.
 *
 * The clock survives `sandbox.reset()`, which swaps the Firestore environment
 * but not the sandbox: a pinned instant is a property of the session, not of
 * the data in it.
 *
 * Throws if `sandbox` was not produced by `initializeSandbox()`, the same guard
 * `getInternalEnv` applies.
 */
export function getClock(sandbox: Sandbox): SandboxClock {
  const carried = (sandbox as Partial<Record<typeof SANDBOX_CLOCK, SandboxClock>>)[SANDBOX_CLOCK];
  if (carried === undefined) {
    throw new SandboxError(
      'invalid-argument',
      'Sandbox handle was not produced by initializeSandbox(); custom Sandbox implementations are not supported.',
    );
  }
  return carried;
}

/**
 * How the clock is currently deriving `now()`. See the module header for what
 * each mode promises.
 */
export type SandboxClockMode = 'wall' | 'fixed' | 'offset';

/**
 * A clock's whole state as one plain value. Captured into a checkpoint or a
 * branch's full state so a restore or a fork carries the virtual time it was
 * taken under, and safe to serialize as JSON.
 */
export interface SandboxClockState {
  mode: SandboxClockMode;
  /** The frozen instant, in epoch milliseconds. Only meaningful when `mode` is `fixed`. */
  fixedAt: number;
  /** Milliseconds added to the wall clock. Only meaningful when `mode` is `offset`. */
  offsetMs: number;
}

/** The state a clock that has never been moved reports. */
export function wallClockState(): SandboxClockState {
  return { mode: 'wall', fixedAt: 0, offsetMs: 0 };
}

function assertFiniteMilliseconds(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be a finite number of milliseconds; received ${String(value)}.`);
  }
}

/**
 * Derives `now()` from a clock state, holding the last wall or offset reading
 * when the host clock steps back. See the module header for why.
 *
 * Shared by {@link SandboxClock} and by any plane that mirrors a clock it
 * cannot call synchronously, so both apply the same rule to the same state.
 */
export class ClockReading {
  private current: SandboxClockState = wallClockState();
  private floor = Number.NEGATIVE_INFINITY;

  /** The state this reading derives from. */
  get state(): SandboxClockState {
    return { ...this.current };
  }

  /** Adopt a new state. An explicit move, so the held reading is dropped. */
  adopt(state: SandboxClockState): void {
    this.current = { ...state };
    this.floor = Number.NEGATIVE_INFINITY;
  }

  /** The current instant, in epoch milliseconds. */
  now(): number {
    if (this.current.mode === 'fixed') {
      return this.current.fixedAt;
    }
    const offsetMs = this.current.mode === 'offset' ? this.current.offsetMs : 0;
    this.floor = Math.max(this.floor, Date.now() + offsetMs);
    return this.floor;
  }
}

/**
 * One sandbox's clock. Owned by the sandbox and shared by every service on it,
 * so `set` / `advance` / `reset` move all of them at once.
 */
export class SandboxClock {
  private readonly reading = new ClockReading();
  private readonly listeners = new Set<(state: SandboxClockState) => void>();

  /**
   * Watch for a move. A sandbox hosted behind a transport (the SharedWorker
   * host, say) has readers in another realm that cannot call `now()`
   * synchronously, so they mirror this state instead and need to be told when
   * it changes. Returns the function that stops watching.
   */
  onChange(listener: (state: SandboxClockState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private move(state: SandboxClockState): void {
    this.reading.adopt(state);
    const announced = this.capture();
    for (const listener of [...this.listeners]) {
      listener(announced);
    }
  }

  /** Which of the three modes the clock is in. */
  get mode(): SandboxClockMode {
    return this.reading.state.mode;
  }

  /** The sandbox's current time, in epoch milliseconds. */
  now(): number {
    return this.reading.now();
  }

  /** The sandbox's current time as a `Date`. */
  date(): Date {
    return new Date(this.now());
  }

  /**
   * Pin the clock to `epochMs` and freeze it there. Every subsequent `now()`
   * returns exactly `epochMs` until the clock is advanced, set again, or reset.
   */
  set(epochMs: number): void {
    assertFiniteMilliseconds(epochMs, 'A clock instant');
    this.move({ mode: 'fixed', fixedAt: epochMs, offsetMs: 0 });
  }

  /**
   * Move the clock forward (or, with a negative delta, back) by `ms`. A frozen
   * clock stays frozen at the new instant; a wall or offset clock keeps
   * flowing, shifted.
   */
  advance(ms: number): void {
    assertFiniteMilliseconds(ms, 'A clock advance');
    const current = this.reading.state;
    if (current.mode === 'fixed') {
      this.move({ ...current, fixedAt: current.fixedAt + ms });
      return;
    }
    this.move({ mode: 'offset', fixedAt: 0, offsetMs: current.offsetMs + ms });
  }

  /** Return to the wall clock, discarding any pin or offset. */
  reset(): void {
    this.move(wallClockState());
  }

  /** This clock's whole state, as a value a checkpoint or branch can hold. */
  capture(): SandboxClockState {
    return this.reading.state;
  }

  /** Adopt a captured state wholesale. */
  restore(state: SandboxClockState): void {
    this.move(state);
  }
}
