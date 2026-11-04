/**
 * Observation of the app's own Firebase SDK calls. A wrapper calls the real
 * function with the app's arguments and `this`, and returns the real result
 * itself: the same promise, the same unsubscribe function, the same thrown
 * error. Beside that, it hands the observer a record of the call and its
 * outcome.
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

/** Where a wrapped export sits: its module and name, and who receives its records. */
export interface ObservedSite {
  readonly module: string;
  readonly name: string;
  readonly observer: LiveObserver;
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
 * Records a promise's settlement on a branch of its own. The app keeps the
 * original promise. The branch is a handler on it, so a rejection the app
 * never handles is recorded but not reported to the runtime as unhandled.
 */
function observeSettlement(site: ObservedSite, result: unknown): void {
  const isPromise = result instanceof Promise;
  if (!isPromise) {
    report(site, 'returned');
    return;
  }
  Promise.prototype.then.call(
    result,
    () => report(site, 'resolved'),
    (error: unknown) => report(site, 'rejected', error),
  );
}

/** Calls the real function as the app called it, records the outcome, and returns or throws exactly what it did. */
function callReal(site: ObservedSite, real: Callback, self: unknown, args: unknown[]): unknown {
  let result: unknown;
  try {
    result = Reflect.apply(real, self, args);
  } catch (error) {
    report(site, 'threw', error);
    throw error;
  }
  observeSettlement(site, result);
  return result;
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

const OBSERVER_METHODS = ['next', 'error', 'complete'] as const;

/** Whether an argument is a partial observer, `{ next, error, complete }`, as the SDK reads one. */
function isPartialObserver(value: unknown): value is Record<string, unknown> {
  const isObject = typeof value === 'object' && value !== null;
  if (!isObject) return false;
  return OBSERVER_METHODS.some((method) => typeof Reflect.get(value, method) === 'function');
}

/** A copy of an observer object whose `next` and `error` record before calling the app's own, bound to the app's object. */
function recordingObserver(site: ObservedSite, observer: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const method of OBSERVER_METHODS) {
    const original = observer[method];
    if (typeof original !== 'function') continue;
    const bound: Callback = (...values) => Reflect.apply(original, observer, values);
    if (method === 'next') copy.next = recordingCallback(site, 'delivered', bound);
    else if (method === 'error') copy.error = recordingCallback(site, 'listener-error', bound);
    else copy.complete = bound;
  }
  return copy;
}

/**
 * The listener arguments, with recording callbacks in place of the app's.
 * Every listener export in the modules wrapped here takes its callbacks in
 * the order next, error, complete, after any target and options arguments,
 * or one observer object in the place of the first.
 */
function recordingArguments(site: ObservedSite, args: unknown[]): unknown[] {
  const callbackOutcomes: LiveCallOutcome[] = ['delivered', 'listener-error'];
  let callbackIndex = 0;
  return args.map((arg) => {
    if (isPartialObserver(arg)) return recordingObserver(site, arg);
    if (typeof arg !== 'function') return arg;
    const outcome = callbackOutcomes[callbackIndex];
    callbackIndex += 1;
    if (outcome === undefined) return arg;
    return recordingCallback(site, outcome, arg as Callback);
  });
}

/** A wrapper for a listener export: `onSnapshot`, `onAuthStateChanged`, `onTokenChanged`. */
export function observedListener(site: ObservedSite, real: Callback): Callback {
  return function observed(this: unknown, ...args: unknown[]): unknown {
    return callReal(site, real, this, recordingArguments(site, args));
  };
}
