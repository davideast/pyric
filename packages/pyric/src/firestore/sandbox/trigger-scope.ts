/**
 * TriggerScope — the engine's trigger-attribution baton (ADR-0009,
 * decision 3; PR B2).
 *
 * Holds the user-origin op that's currently triggering a listener
 * re-eval, if any. Write paths (`execute` / `batch` / `transaction`) and
 * the scheduled-delivery restore wrap their fan-out in {@link run}, which
 * has the baton's exact **save/restore** semantics: a listener callback
 * may itself issue a write, recursing through execute and setting up its
 * own trigger; the previous value must come back when the nested call
 * returns so the remaining listeners in the outer fan-out still
 * attribute correctly.
 *
 * Listener-origin RequestEvents and snapshot delivery/suppressed events
 * read {@link current} into `triggeredBy`. Deliveries capture the value
 * at **schedule** time, not drain time — by the time the microtask drain
 * runs, the writing stack has unwound and `current()` is back to the
 * microtask loop's state (usually undefined). `undefined` means "no
 * triggering user op": the initial-fire path and deployRules
 * re-evaluation.
 */

/** A user-origin operation attributed as the cause of a listener fire. */
export interface TriggerInfo {
  method: string;
  path: string;
}

export class TriggerScope {
  private currentTrigger: TriggerInfo | undefined;

  /**
   * Set `trigger` as current, run `fn`, and restore the PREVIOUS value in
   * a finally — even when `fn` throws. `undefined` is a valid trigger
   * ("no user op"): the scheduled-delivery restore path replays whatever
   * was captured at schedule time, which may be nothing.
   */
  run<T>(trigger: TriggerInfo | undefined, fn: () => T): T {
    const prev = this.currentTrigger;
    this.currentTrigger = trigger;
    try {
      return fn();
    } finally {
      this.currentTrigger = prev;
    }
  }

  /** The trigger attributed to work running right now, if any. */
  current(): TriggerInfo | undefined {
    return this.currentTrigger;
  }
}
