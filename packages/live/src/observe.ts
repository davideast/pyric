/**
 * Observation of the app's own Firebase SDK calls. A wrapper calls the real
 * function with the app's arguments and `this`, and returns what it returned:
 * the same value, the same unsubscribe function, the same thrown error. A
 * promise is the one exception: the app gets a new promise that settles with
 * the real one's value or reason, so a rejection the app never handles is
 * still reported to the runtime as unhandled. Beside that, the wrapper hands
 * the observer a record of the call and its outcome.
 *
 * A record names the module, the export and the outcome, plus the error code
 * on a failure. It never carries an argument or a result, so no document
 * value, credential or token reaches it.
 *
 * Recording is isolated from the app: building a record, calling the
 * observer and a rejection from an async observer are each caught, so an
 * observer that fails never changes what the app sees.
 */

/**
 * What happened to one call or one listener event: the call returned or
 * threw, its promise resolved or rejected, or its listener was handed a
 * value or an error.
 */
export type LiveCallOutcome = 'returned' | 'threw' | 'resolved' | 'rejected' | 'delivered' | 'listener-error';

export interface LiveCallRecord {
  /** The specifier the app imported, such as `firebase/firestore`. */
  readonly module: string;
  /** The export the app called, such as `getDoc`. */
  readonly name: string;
  readonly outcome: LiveCallOutcome;
  /** On `threw`, `rejected` and `listener-error`: the error's `code`, such as `permission-denied`, or its name. */
  readonly code?: string;
}

/** The hook a plane supplies to receive records. Its return value is ignored. */
export type LiveObserver = (record: LiveCallRecord) => unknown;

/** What the SDK itself does with a listener error when the app passed no error callback. */
export type UncaughtListenerError = (error: unknown) => void;

/** Where a wrapped export sits: its module and name, and who receives its records. */
export interface ObservedSite {
  readonly module: string;
  readonly name: string;
  readonly observer: LiveObserver;
  /**
   * For a listener export: what the SDK does with an error when the app gave
   * no error callback, done after the error is recorded. Absent means
   * nothing, as Auth and App Check do.
   */
  readonly uncaughtListenerError?: UncaughtListenerError;
}

type Callback = (this: unknown, ...values: unknown[]) => unknown;

const FAILURE_OUTCOMES: ReadonlySet<LiveCallOutcome> = new Set(['threw', 'rejected', 'listener-error']);

/** The error's string `code`, else its constructor name, else `unknown`. Reading either can throw; the caller catches it. */
function errorCode(error: unknown): string {
  const isObject = typeof error === 'object' && error !== null;
  if (!isObject) return 'unknown';
  const code: unknown = Reflect.get(error, 'code');
  if (typeof code === 'string') return code;
  const name: unknown = Reflect.get(error, 'name');
  if (typeof name === 'string') return name;
  return 'unknown';
}

function buildRecord(site: ObservedSite, outcome: LiveCallOutcome, error: unknown): LiveCallRecord {
  const isFailure = FAILURE_OUTCOMES.has(outcome);
  if (!isFailure) return { module: site.module, name: site.name, outcome };
  return { module: site.module, name: site.name, outcome, code: errorCode(error) };
}

function ignoreRejection(returned: unknown): void {
  const isPromise = returned instanceof Promise;
  if (isPromise) Promise.prototype.then.call(returned, undefined, () => undefined);
}

/** Hands the observer one record. Nothing it does, or fails to do, reaches the caller. */
function report(site: ObservedSite, outcome: LiveCallOutcome, error?: unknown): void {
  try {
    const record = buildRecord(site, outcome, error);
    ignoreRejection(site.observer(record));
  } catch {
    // A recorder failure never changes what the app sees.
  }
}

/**
 * Records a promise's settlement and hands the app the promise that follows
 * it: it resolves with the same value or rejects with the same reason. The
 * app's own handling decides whether a rejection is unhandled, as it would
 * without live mode. Any other result is recorded as returned and passed
 * back unchanged.
 */
function observeSettlement(site: ObservedSite, result: unknown): unknown {
  const isPromise = result instanceof Promise;
  if (!isPromise) {
    report(site, 'returned');
    return result;
  }
  return Promise.prototype.then.call(
    result,
    (value: unknown) => {
      report(site, 'resolved');
      return value;
    },
    (error: unknown) => {
      report(site, 'rejected', error);
      throw error;
    },
  );
}

/** Calls the real function as the app called it, records the outcome, and returns or throws what it did. */
function callReal(site: ObservedSite, real: Callback, self: unknown, args: unknown[]): unknown {
  let result: unknown;
  try {
    result = Reflect.apply(real, self, args);
  } catch (error) {
    report(site, 'threw', error);
    throw error;
  }
  return observeSettlement(site, result);
}

/** A wrapper for a one-shot export: reads, writes, sign-in and token calls. */
export function observedCall(site: ObservedSite, real: Callback): Callback {
  return function observed(this: unknown, ...args: unknown[]): unknown {
    return callReal(site, real, this, args);
  };
}

/** Wraps one listener callback: records the event, then calls the app's callback with the same `this` and values. */
function recordingCallback(site: ObservedSite, outcome: LiveCallOutcome, callback: Callback): Callback {
  return function recorded(this: unknown, ...values: unknown[]): unknown {
    report(site, outcome, values[0]);
    return Reflect.apply(callback, this, values);
  };
}

/**
 * The error callback for an app that passed none: it records the error, then
 * does what the SDK does without one. A failure in that step is caught, as
 * a recorder failure is.
 */
function uncaughtErrorCallback(site: ObservedSite): Callback {
  return function recorded(...values: unknown[]): void {
    report(site, 'listener-error', values[0]);
    try {
      site.uncaughtListenerError?.(values[0]);
    } catch {
      // Reproducing the SDK's log never changes what the app sees.
    }
  };
}

/** The callback the wrapper passes in the error slot: the app's own, recorded, or the uncaught one when the app gave none. */
function errorSlot(site: ObservedSite, given: unknown): unknown {
  if (typeof given === 'function') return recordingCallback(site, 'listener-error', given as Callback);
  const isAbsent = given === undefined || given === null;
  if (isAbsent) return uncaughtErrorCallback(site);
  return given;
}

const OBSERVER_METHODS = ['next', 'error', 'complete'] as const;

/** Whether an argument is a partial observer, `{ next, error, complete }`, as the SDK reads one. */
function isPartialObserver(value: unknown): value is Record<string, unknown> {
  const isObject = typeof value === 'object' && value !== null;
  if (!isObject) return false;
  return OBSERVER_METHODS.some((method) => typeof Reflect.get(value, method) === 'function');
}

/** The app's observer method bound to the app's object, or the value itself when it is not a function. */
function boundTo(observer: Record<string, unknown>, original: unknown): unknown {
  if (typeof original !== 'function') return original;
  return (...values: unknown[]) => Reflect.apply(original, observer, values);
}

/**
 * A copy of an observer object whose `next` and `error` record before calling
 * the app's own, bound to the app's object. An observer with no `error` gets
 * the uncaught one.
 */
function recordingObserver(site: ObservedSite, observer: Record<string, unknown>): Record<string, unknown> {
  const next = boundTo(observer, observer.next);
  const complete = boundTo(observer, observer.complete);
  const copy: Record<string, unknown> = {};
  if (typeof next === 'function') copy.next = recordingCallback(site, 'delivered', next as Callback);
  copy.error = errorSlot(site, boundTo(observer, observer.error));
  if (typeof complete === 'function') copy.complete = complete;
  return copy;
}

/** Whether an argument is where the app's callbacks start: a function or an observer object. */
function isFirstCallback(arg: unknown): boolean {
  return typeof arg === 'function' || isPartialObserver(arg);
}

/**
 * The listener arguments, with recording callbacks in place of the app's.
 * Every listener export in the modules wrapped here takes its callbacks in
 * the order next, error, complete, after any target and options arguments,
 * or one observer object in the place of the first. When the app gave no
 * error callback, the error slot gets one that records and then does what
 * the SDK does without one.
 */
function recordingArguments(site: ObservedSite, args: unknown[]): unknown[] {
  const copy = [...args];
  const nextIndex = copy.findIndex(isFirstCallback);
  if (nextIndex === -1) return copy;
  const first = copy[nextIndex];
  if (isPartialObserver(first)) {
    copy[nextIndex] = recordingObserver(site, first);
    return copy;
  }
  copy[nextIndex] = recordingCallback(site, 'delivered', first as Callback);
  copy[nextIndex + 1] = errorSlot(site, copy[nextIndex + 1]);
  return copy;
}

/** A wrapper for a listener export: `onSnapshot`, `onAuthStateChanged`, `onTokenChanged`. */
export function observedListener(site: ObservedSite, real: Callback): Callback {
  return function observed(this: unknown, ...args: unknown[]): unknown {
    return callReal(site, real, this, recordingArguments(site, args));
  };
}
