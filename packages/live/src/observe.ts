/**
 * Observation of the app's own Firebase SDK calls. A wrapper calls the real
 * function with the app's arguments and `this`, and returns what it returned:
 * the same value, the same unsubscribe function, the same thrown error. A
 * promise is one exception: the app gets a new promise that settles with
 * the real one's value or reason, so a rejection the app never handles is
 * still reported to the runtime as unhandled. Beside that, the wrapper hands
 * the observer a record of the call and its outcome.
 *
 * A record names the module, the export and the outcome, plus the error code
 * on a failure, the project, the signed-in account the call ran as
 * (`account.ts`, which a site supplies) and, on a Firestore snapshot, the
 * documents production billed it for. It never carries an argument or a
 * result, so no document value, credential or token reaches it.
 *
 * Recording is isolated from the app: building a record, calling the
 * observer and a rejection from an async observer are each caught, so an
 * observer that fails never changes what the app sees.
 *
 * An observer may also journal Firestore listeners (`journal`), as the page's
 * does, so the runtime chip's Listeners view and Flow see them. The listener
 * wrapper then opens the listener's activity at the subscribe call, reports
 * each delivery immediately before the app's callback runs, and closes the
 * activity when the app unsubscribes: the app gets a function that closes it
 * and calls the SDK's own unsubscribe.
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
  /**
   * The project the call went to: `app.options.projectId` of the app its
   * first argument belongs to. Absent when the argument names no app.
   */
  readonly projectId?: string;
  /**
   * On a delivered Firestore snapshot: the documents production billed it
   * for, zero for a snapshot only its metadata changed (`billedDocuments`
   * below). Absent on any other record, and when the snapshot could not be
   * read.
   */
  readonly billedDocuments?: number;
  /**
   * The signed-in account the call ran as when the record was made: the
   * current user of the Auth its first argument's app was handed. Absent
   * when it ran signed out.
   */
  readonly account?: LiveAccount;
}

/** The account a call ran as: the uid and its token's claim names, never the token. */
export interface LiveAccount {
  readonly uid: string;
  readonly claimNames?: readonly string[];
}

/**
 * The hook a plane supplies to receive records. Its return value is ignored.
 * A plane whose listeners the runtime chip shows also supplies `journal`.
 */
export type LiveObserver = ((record: LiveCallRecord) => unknown) & { readonly journal?: LiveListenerJournal };

/** A Firestore listener, as the journal names it: never a value, only where it listens. */
export interface LiveListenerSubject {
  /** The Firestore instance the listener runs on, which names the app it belongs to. */
  readonly firestore: object;
  /** The export the app called, such as `onSnapshot`. */
  readonly method: string;
  /** The document or collection path, or the collection group's id. */
  readonly target: string;
  /** False for a document listener. */
  readonly isQuery: boolean;
  /** The same for two listeners on the same document or query. */
  readonly key: string;
}

/**
 * One listener's activity in the plane's journal: `pyric/sandbox/internal`'s
 * SDK activity, which `@pyric/cli` opens for the page.
 */
export interface LiveListenerActivity {
  /**
   * Reports a delivery of `value`, which production billed for
   * `billedDocuments`, then runs the app's callback and returns what it
   * returned. Anything the callback throws propagates.
   */
  deliver(value: unknown, billedDocuments: number | undefined, run: () => unknown): unknown;
  /** The listener was handed an error. */
  fail(): void;
  /** The app unsubscribed. */
  close(): void;
}

/** Opens one listener's activity. */
export type LiveListenerJournal = (subject: LiveListenerSubject) => LiveListenerActivity;

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
  /** The project of the call this site records, read from its arguments. */
  readonly projectId?: string;
  /** For one listener: counts the documents each delivery was billed for. */
  readonly billing?: BilledDocuments;
  /** The call's first argument, which names the app whose Auth the call runs as. */
  readonly subject?: unknown;
  /** Reads the account a call whose first argument is `subject` runs as. Absent records no account. */
  readonly accountOf?: (subject: unknown) => LiveAccount | undefined;
  /** For one listener the observer journals: its activity. */
  readonly activity?: LiveListenerActivity;
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

/** The billed documents of a delivered value, or undefined when it is no snapshot or reading it threw. */
function billedOf(site: ObservedSite, outcome: LiveCallOutcome, value: unknown): number | undefined {
  const isDelivery = outcome === 'delivered' && site.billing !== undefined;
  if (!isDelivery) return undefined;
  try {
    return site.billing?.(value);
  } catch {
    // A snapshot that throws on read is still recorded; the host counts it once.
    return undefined;
  }
}

/** `value` is the delivered value or the error, by outcome. */
function buildRecord(site: ObservedSite, outcome: LiveCallOutcome, value: unknown): LiveCallRecord {
  const isFailure = FAILURE_OUTCOMES.has(outcome);
  const project = site.projectId === undefined ? {} : { projectId: site.projectId };
  const account = site.accountOf?.(site.subject);
  const context = account === undefined ? project : { ...project, account };
  if (isFailure) return { module: site.module, name: site.name, outcome, code: errorCode(value), ...context };
  const billedDocuments = billedOf(site, outcome, value);
  const billed = billedDocuments === undefined ? {} : { billedDocuments };
  return { module: site.module, name: site.name, outcome, ...context, ...billed };
}

function stringAt(value: unknown, path: readonly string[]): string | undefined {
  let current = value;
  for (const key of path) {
    const isObject = (typeof current === 'object' || typeof current === 'function') && current !== null;
    if (!isObject) return undefined;
    current = Reflect.get(current as object, key);
  }
  return typeof current === 'string' && current !== '' ? current : undefined;
}

/**
 * Where the app's own objects keep the project: a reference or query's
 * `firestore.app`, a Firestore or Auth instance's `app`, or the app itself.
 */
const PROJECT_PATHS = [
  ['firestore', 'app', 'options', 'projectId'],
  ['app', 'options', 'projectId'],
  ['options', 'projectId'],
] as const;

/** The project the first argument's app names, read without calling anything of the app's. */
function projectOf(args: readonly unknown[]): string | undefined {
  try {
    for (const path of PROJECT_PATHS) {
      const projectId = stringAt(args[0], path);
      if (projectId !== undefined) return projectId;
    }
  } catch {
    // An argument that throws on read names no project; the call is still recorded.
  }
  return undefined;
}

/** The site with the project its call's arguments name, and the argument that names its account. */
function siteFor(site: ObservedSite, args: readonly unknown[]): ObservedSite {
  const projectId = projectOf(args);
  const subject = { ...site, subject: args[0] };
  return projectId === undefined ? subject : { ...subject, projectId };
}

function ignoreRejection(returned: unknown): void {
  const isPromise = returned instanceof Promise;
  if (isPromise) Promise.prototype.then.call(returned, undefined, () => undefined);
}

/** Hands the observer one record, and returns it. Nothing the observer does, or fails to do, reaches the caller. */
function report(site: ObservedSite, outcome: LiveCallOutcome, value?: unknown): LiveCallRecord | undefined {
  try {
    const record = buildRecord(site, outcome, value);
    ignoreRejection(site.observer(record));
    return record;
  } catch {
    // A recorder failure never changes what the app sees.
    return undefined;
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

/**
 * The documents production billed one Firestore listener delivery for.
 * Production bills a listener per document added, changed or removed in its
 * result set, and at least one read for its first result, even an empty one.
 * It bills nothing for a snapshot the SDK raises only because the metadata
 * changed, which a listener with `includeMetadataChanges` receives when a
 * pending write is acknowledged or the result stops coming from the cache.
 *
 * A query snapshot names its changes: `docChanges()` leaves out the ones
 * that touched only metadata. A document snapshot does not, so its data is
 * compared with the listener's previous delivery. A document snapshot read
 * through a converter is counted as changed rather than call the app's
 * converter; so is any value the comparison cannot be sure of.
 *
 * Nothing here calls the app's own code, and a throw is caught where the
 * record is built.
 */

/** Counts one listener's deliveries: the billed documents of each, or undefined for a value that is not a snapshot. */
type BilledDocuments = (value: unknown) => number | undefined;

/** The state of a document as one delivery showed it: whether it existed, and its data. */
interface DocumentState {
  readonly exists: boolean;
  readonly data: unknown;
}

/** Marks a document snapshot whose data cannot be compared, so the next delivery counts as changed. */
const UNCOMPARABLE: unique symbol = Symbol('uncomparable');

function methodOf(value: unknown, name: string): ((...args: unknown[]) => unknown) | undefined {
  const isObject = typeof value === 'object' && value !== null;
  if (!isObject) return undefined;
  const method: unknown = Reflect.get(value, name);
  return typeof method === 'function' ? (method as (...args: unknown[]) => unknown) : undefined;
}

/** The number of document changes in a query snapshot, or undefined for any other value. */
function queryChanges(value: unknown): number | undefined {
  const docChanges = methodOf(value, 'docChanges');
  if (docChanges === undefined) return undefined;
  const changes: unknown = Reflect.apply(docChanges, value, []);
  return Array.isArray(changes) ? changes.length : undefined;
}

/** What a document snapshot shows, or undefined for any other value. */
function documentState(value: unknown): DocumentState | undefined {
  const exists = methodOf(value, 'exists');
  const data = methodOf(value, 'data');
  const isDocument = exists !== undefined && data !== undefined;
  if (!isDocument) return undefined;
  const converter: unknown = Reflect.get(value as object, '_converter');
  const hasConverter = converter !== undefined && converter !== null;
  const shown = Reflect.apply(exists, value, []) === true;
  if (hasConverter) return { exists: shown, data: UNCOMPARABLE };
  return { exists: shown, data: Reflect.apply(data, value, []) };
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameArrays(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((item, index) => sameValue(item, right[index]));
}

function sameObjects(left: object, right: object): boolean {
  const keys = Object.keys(left);
  const hasSameKeys = keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key));
  return hasSameKeys && keys.every((key) => sameValue(Reflect.get(left, key), Reflect.get(right, key)));
}

/** A Firestore value class's own equality: Timestamp, GeoPoint, Bytes, VectorValue. */
function sameByIsEqual(left: object, right: object): boolean {
  const isEqual = methodOf(left, 'isEqual');
  const isSameClass = Object.getPrototypeOf(left) === Object.getPrototypeOf(right);
  return isEqual !== undefined && isSameClass && Reflect.apply(isEqual, left, [right]) === true;
}

/** Whether two document values are equal; false whenever that cannot be shown. */
function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  const areObjects = typeof left === 'object' && left !== null && typeof right === 'object' && right !== null;
  if (!areObjects) return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && sameArrays(left, right);
  const arePlain = isPlainObject(left) && isPlainObject(right);
  if (arePlain) return sameObjects(left, right);
  return sameByIsEqual(left, right);
}

function sameState(previous: DocumentState | undefined, next: DocumentState): boolean {
  const isComparable = previous !== undefined && previous.data !== UNCOMPARABLE && next.data !== UNCOMPARABLE;
  return isComparable && previous.exists === next.exists && sameValue(previous.data, next.data);
}

/** A fresh count for one listener. */
function billedDocuments(): BilledDocuments {
  let isFirst = true;
  let previous: DocumentState | undefined;
  const firstAtLeastOne = (count: number): number => {
    const billed = isFirst ? Math.max(count, 1) : count;
    isFirst = false;
    return billed;
  };
  return (value) => {
    const changes = queryChanges(value);
    if (changes !== undefined) return firstAtLeastOne(changes);
    const state = documentState(value);
    if (state === undefined) return undefined;
    const isMetadataOnly = sameState(previous, state);
    previous = state;
    return firstAtLeastOne(isMetadataOnly ? 0 : 1);
  };
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
    return callReal(siteFor(site, args), real, this, args);
  };
}

/** Tells the journal the listener failed. A journal failure never reaches the app. */
function journalFailure(site: ObservedSite): void {
  try {
    site.activity?.fail();
  } catch {
    // The journal is a diagnostic; the app's error callback still runs.
  }
}

/**
 * Runs the app's callback for one delivery through the listener's activity,
 * so the journal reports it immediately before the callback. The callback
 * runs exactly once: directly when the listener has no activity, or when the
 * journal fails before running it.
 */
function deliverThrough(site: ObservedSite, value: unknown, billedDocuments: number | undefined, run: () => unknown): unknown {
  const activity = site.activity;
  if (activity === undefined) return run();
  let ran = false;
  const once = (): unknown => {
    ran = true;
    return run();
  };
  try {
    const returned = activity.deliver(value, billedDocuments, once);
    return ran ? returned : run();
  } catch (error) {
    if (ran) throw error;
    return run();
  }
}

/** Wraps one listener callback: records the event, then calls the app's callback with the same `this` and values. */
function recordingCallback(site: ObservedSite, outcome: LiveCallOutcome, callback: Callback): Callback {
  return function recorded(this: unknown, ...values: unknown[]): unknown {
    const record = report(site, outcome, values[0]);
    const callApp = (): unknown => Reflect.apply(callback, this, values);
    const isDelivery = outcome === 'delivered';
    if (isDelivery) return deliverThrough(site, values[0], record?.billedDocuments, callApp);
    journalFailure(site);
    return callApp();
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
    journalFailure(site);
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

/** The constraints of a query, as the SDK keeps them in its `_query`. */
const QUERY_CONSTRAINTS = ['filters', 'explicitOrderBy', 'limit', 'limitType', 'startAt', 'endAt'] as const;

/** A query's collection path or group id, and its key, read from the SDK's `_query`. */
function queryPath(subject: object): Pick<LiveListenerSubject, 'target' | 'key'> | undefined {
  const query: unknown = Reflect.get(subject, '_query');
  const isObject = typeof query === 'object' && query !== null;
  if (!isObject) return undefined;
  const group: unknown = Reflect.get(query, 'collectionGroup');
  const path: unknown = Reflect.get(query, 'path');
  const canonical = methodOf(path, 'canonicalString');
  const collection: unknown = canonical === undefined ? undefined : Reflect.apply(canonical, path, []);
  const target = typeof group === 'string' ? group : collection;
  if (typeof target !== 'string') return undefined;
  const constraints = QUERY_CONSTRAINTS.map((name) => Reflect.get(query, name));
  try {
    return { target, key: JSON.stringify(['query', target, constraints]) };
  } catch {
    // Constraints that do not serialize key the query by its collection alone.
    return { target, key: JSON.stringify(['query', target]) };
  }
}

/** A reference's path, or a query's, read without calling anything of the app's. */
function firestorePath(subject: object, type: unknown): Pick<LiveListenerSubject, 'target' | 'key'> | undefined {
  const isReference = type === 'document' || type === 'collection';
  if (!isReference) return type === 'query' ? queryPath(subject) : undefined;
  const path: unknown = Reflect.get(subject, 'path');
  return typeof path === 'string' ? { target: path, key: JSON.stringify([type, path]) } : undefined;
}

/** The Firestore listener an export's first argument names, or undefined for any other subject. */
function listenerSubject(method: string, subject: unknown): LiveListenerSubject | undefined {
  const isObject = typeof subject === 'object' && subject !== null;
  if (!isObject) return undefined;
  const firestore: unknown = Reflect.get(subject, 'firestore');
  const hasFirestore = typeof firestore === 'object' && firestore !== null;
  if (!hasFirestore) return undefined;
  const type: unknown = Reflect.get(subject, 'type');
  const path = firestorePath(subject, type);
  if (path === undefined) return undefined;
  return { firestore, method, isQuery: type !== 'document', ...path };
}

/** The listener's activity in the observer's journal, or undefined when it has none or opening it failed. */
function openActivity(site: ObservedSite, args: readonly unknown[]): LiveListenerActivity | undefined {
  try {
    const journal = site.observer.journal;
    if (typeof journal !== 'function') return undefined;
    const subject = listenerSubject(site.name, args[0]);
    return subject === undefined ? undefined : journal(subject);
  } catch {
    // A listener the journal cannot open is still the SDK's own.
    return undefined;
  }
}

/** The SDK's unsubscribe, closing the listener's activity first. Any other result is passed back unchanged. */
function closingUnsubscribe(activity: LiveListenerActivity, unsubscribe: unknown): unknown {
  if (typeof unsubscribe !== 'function') return unsubscribe;
  return function unsubscribed(this: unknown, ...values: unknown[]): unknown {
    try {
      activity.close();
    } catch {
      // The journal is a diagnostic; the SDK still unsubscribes.
    }
    return Reflect.apply(unsubscribe as Callback, this, values);
  };
}

/** A wrapper for a listener export: `onSnapshot`, `onAuthStateChanged`, `onTokenChanged`. */
export function observedListener(site: ObservedSite, real: Callback): Callback {
  return function observed(this: unknown, ...args: unknown[]): unknown {
    const callSite = siteFor(site, args);
    const activity = openActivity(site, args);
    const listenerSite = { ...callSite, billing: billedDocuments(), activity };
    const listening = recordingArguments(listenerSite, args);
    if (activity === undefined) return callReal(callSite, real, this, listening);
    let unsubscribe: unknown;
    try {
      unsubscribe = callReal(callSite, real, this, listening);
    } catch (error) {
      journalFailure(listenerSite);
      throw error;
    }
    return closingUnsubscribe(activity, unsubscribe);
  };
}
