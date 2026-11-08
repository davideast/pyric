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
 * documents production billed it for. A Realtime Database record also names
 * the instance and the reference's path, read through the module's context
 * hook (`database.ts`). An AI Logic record also names the model and, on
 * success, the token counts production reported, read by the module's result
 * hook (`ai.ts`). A Cloud Storage record also names the bucket and the
 * reference's path (`storage.ts`). A Cloud Messaging record also lists the
 * Installations and FCM registration requests the call made, as API and
 * action names, read by the module's result and rejection hooks
 * (`messaging.ts`). A Firestore record also carries, for the host's local
 * rules only, the data a write sent and the document a `getDoc` returned,
 * read by the module's context and result hooks (`firestore.ts`), and the
 * account its claim values. It never carries another argument's value or
 * result, so no prompt, response text, file content, credential, token or
 * push payload reaches it.
 *
 * A thenable that is not a promise, as RTDB's `push` and Storage's
 * `uploadBytesResumable` return, is another exception when the module marks
 * it: the app gets the SDK's own object, with its `then` and `catch` taken
 * from a promise that follows it.
 *
 * Recording is isolated from the app: building a record, calling the
 * observer and a rejection from an async observer are each caught, so an
 * observer that fails never changes what the app sees.
 *
 * An observer may also journal Firestore and Realtime Database listeners
 * (`journal`), as the page's does, so the runtime chip's Listeners view and
 * Flow see them. The listener wrapper then opens the listener's activity at
 * the subscribe call, reports each delivery immediately before the app's
 * callback runs, and closes the activity when the app unsubscribes, or when
 * RTDB `off()` ends the listener: the app gets a function that closes it and
 * calls the SDK's own unsubscribe (`listener-journal.ts`).
 */
import { closingUnsubscribe, openActivity, type LiveListenerActivity, type LiveListenerJournal } from './listener-journal.js';
import {
  createListenerLifecycle,
  subscribeWithLifecycle,
  wrapEndingUnsubscribe,
} from './observe-listener.js';
import { CALL_TARGET_FIELDS, liveProjectRefusal, type CallTargetField, type LiveClient, type ProjectField } from './refusal.js';
import { attachSessionData, mergeSessionData, type ObservedSessionDelta } from './session-data.js';

export type { LiveListener, LiveListenerActivity, LiveListenerJournal } from './listener-journal.js';

/**
 * What happened to one call or one listener event: the call returned or
 * threw, its promise resolved or rejected, or its listener was handed a
 * value or an error. A Firestore or Realtime Database listener records
 * `attached` when the app subscribed, in place of `returned`, and `detached`
 * once when it ended: the app unsubscribed, called `off()` for it, or the
 * SDK ended it with an error.
 */
export type LiveCallOutcome = 'returned' | 'threw' | 'resolved' | 'rejected' | 'delivered' | 'listener-error' | 'attached' | 'detached';

/**
 * One listener's lifecycle, on its `attached` and `detached` records: the id
 * this realm minted for the subscription, and the realm's keyed hash of the
 * key two listeners on the same document or query share. Never the key,
 * which holds the query's values.
 */
export interface LiveListenerLifecycle {
  readonly id: string;
  readonly key: string;
}

/**
 * What a listener watches, as a module's `listenerOf` hook reads it: the
 * path or group id, and the key two listeners on the same document or query
 * share, which may hold the query's values and never leaves the realm.
 */
export interface ListenerIdentity {
  readonly target: string;
  readonly key: string;
}

export interface LiveCallRecord {
  /** The specifier the app imported, such as `firebase/firestore`. */
  readonly module: string;
  /** The export the app called, such as `getDoc`. An Admin call names its class and method, such as `DocumentReference.get`. */
  readonly name: string;
  readonly outcome: LiveCallOutcome;
  /**
   * `'admin'` on a call a server process made through the Admin SDK, which
   * bypasses Security Rules (`admin/patch.ts`). Absent for the client SDK.
   */
  readonly sdk?: 'admin';
  /** On `threw`, `rejected` and `listener-error`: the error's `code`, such as `permission-denied`, or its name. */
  readonly code?: string;
  /**
   * On `threw`, `rejected` and `listener-error`: production's own message, as
   * the SDK's error held it (`Missing or insufficient permissions.`), at most
   * {@link MAX_MESSAGE_LENGTH} characters, with each email address written
   * `[email]`. Absent when the error had none.
   */
  readonly message?: string;
  /**
   * The project the call went to: `app.options.projectId` of the app its
   * first argument belongs to. Absent when the argument names no app.
   */
  readonly projectId?: string;
  /**
   * On a delivered Firestore snapshot: the documents production billed it
   * for, zero for a snapshot only its metadata changed (`billedDocuments`
   * below). On a resolved call whose result hook counts them, such as the
   * Admin SDK's `Query.get`: the documents it read. Absent on any other
   * record, and when the snapshot could not be read.
   */
  readonly billedDocuments?: number;
  /**
   * On a resolved call: what production billed or moved for it, as the
   * observer's `measure` read it from the resolved value. Counts only.
   * Absent when the observer does not measure, or measured nothing.
   */
  readonly usage?: LiveUsage;
  /**
   * The signed-in account the call ran as when the record was made: the
   * current user of the Auth its first argument's app was handed. Absent
   * when it ran signed out.
   */
  readonly account?: LiveAccount;
  /**
   * On a Realtime Database call: the instance it went to, as the SDK's
   * namespace names it (`my-project-default-rtdb`). Absent on other records.
   */
  readonly instance?: string;
  /**
   * On a Realtime Database call: the reference's path, `/items/a`. On a Cloud
   * Storage call: the reference's `fullPath`, `images/a.png`, absent for the
   * bucket's root. Absent on other records.
   */
  readonly path?: string;
  /** On a Cloud Storage call: the bucket the reference names, `my-project.firebasestorage.app`. Absent on other records. */
  readonly bucket?: string;
  /** On an AI Logic call: the model and, on success, production's token counts. Absent on other records. */
  readonly ai?: LiveAiRecord;
  /**
   * On a Cloud Messaging `getToken` or `deleteToken`: the Installations and
   * FCM registration requests it made, at most four, in the order they
   * started. Absent on other records, and where the realm has no Resource
   * Timing.
   */
  readonly requests?: readonly LiveRequest[];

  /**
   * On a Firestore write, RTDB write, or Storage metadata upload/update: the
   * bounded JSON value or object metadata it sent. Sent to the host for its
   * local rules only.
   */
  readonly writeData?: LiveWriteValue;
  /**
   * On a resolved Firestore `getDoc`: the fields of the document it
   * returned, as JSON values. Sent to the host for its local rules only.
   */
  readonly document?: Readonly<Record<string, unknown>>;
  /** On a Firestore list or listener: the shape of its query. Never a value. */
  readonly query?: LiveQuery;
  /** On an `attached` or `detached` record: the listener's id and hashed key. */
  readonly listener?: LiveListenerLifecycle;
  /** On a `delivered` record of a named listener: the subscription id minted at attach. */
  readonly listenerId?: string;
}

/** A bounded JSON value an observed Firestore, RTDB or Storage write carried. */
export type LiveWriteValue =
  | string
  | number
  | boolean
  | null
  | readonly unknown[]
  | Readonly<Record<string, unknown>>;

/** One `where` filter of a query: its field path and operator. Never its value. */
export interface LiveQueryFilter {
  readonly field: string;
  readonly op: '<' | '<=' | '==' | '!=' | '>=' | '>' | 'array-contains' | 'in' | 'not-in' | 'array-contains-any';
}

/** One `orderBy` of a query: its field path and direction. */
export interface LiveQueryOrder {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

/**
 * The shape of a Firestore query: its scope, filters and orders, whether it
 * set a limit, and `fingerprint`, 16 lowercase hex characters of a hash of
 * its filter and cursor values keyed per realm (`keyed-hash.ts`). Never a value.
 */
export interface LiveQuery {
  readonly scope: 'collection' | 'collection-group';
  readonly filters?: readonly LiveQueryFilter[];
  readonly orderBy?: readonly LiveQueryOrder[];
  readonly limit?: true;
  readonly fingerprint?: string;
}

/** One request a Cloud Messaging call made: the API, what the request did, and production's HTTP status. Never its URL. */
export interface LiveRequest {
  readonly api: 'installations' | 'registrations';
  readonly action: 'create' | 'generateAuthToken' | 'update' | 'delete';
  /** The response's HTTP status, absent when Resource Timing reported none. */
  readonly status?: number;
}

/** The token counts production reported for an AI Logic call. Numbers only. */
export interface LiveAiUsage {
  readonly promptTokenCount?: number;
  readonly candidatesTokenCount?: number;
  readonly totalTokenCount?: number;
  /** `countTokens` only. */
  readonly totalTokens?: number;
}

/** What an AI Logic record names: the model and token counts, never a prompt, a part or response text. */
export interface LiveAiRecord {
  /** The model resource the SDK normalized, `models/gemini-flash-lite-latest`. */
  readonly model: string;
  /** The `modelVersion` production reported, when the SDK kept it. */
  readonly reportedModel?: string;
  readonly usage?: LiveAiUsage;
  /** On a stream: ms from the call until the method resolved with its first chunk. */
  readonly firstChunkMs?: number;
  /** On an answer with no usable content: the first candidate's finish reason, never `STOP` or `MAX_TOKENS`. */
  readonly finishReason?: string;
  /** On a prompt production refused before generation: `promptFeedback.blockReason`. */
  readonly blockReason?: string;
}

/** What production billed or moved for one call: counts only, never a document, a value or a payload. */
export interface LiveUsage {
  readonly documentReads?: number;
  readonly documentWrites?: number;
  readonly documentDeletes?: number;
  readonly payloadBytes?: number;
  readonly uploadedBytes?: number;
  readonly downloadedBytes?: number;
  readonly unmeasured?: number;
}

/** Measures a resolved call from its value, as the senders' `measureObservedUsage` does. Undefined measures nothing. */
export type LiveMeasure = (module: string, name: string, value: unknown) => LiveUsage | undefined;

/** The account a call ran as: the uid, its token's claim names and their values with emails left out, never the token. */
export interface LiveAccount {
  readonly uid: string;
  readonly claimNames?: readonly string[];
  /** The claims by name, as JSON values. Sent to the host for its local rules only. */
  readonly claims?: Readonly<Record<string, unknown>>;
}

/**
 * The hook a plane supplies to receive records. Its return value is ignored.
 * A plane whose listeners the runtime chip shows also supplies `journal`.
 * A plane that knows the host's project supplies `hostProjectId`, and the
 * client it runs in: every wrapper then refuses a call whose app names
 * another project (`refusedProject`). A plane that measures supplies
 * `measure`: each resolved record then carries the call's `usage`.
 */
export type LiveObserver = ((record: LiveCallRecord) => unknown) & {
  readonly journal?: LiveListenerJournal;
  readonly measure?: LiveMeasure;
  readonly hostProjectId?: string;
  readonly client?: LiveClient;
};

/** What the SDK itself does with a listener error when the app passed no error callback. */
export type UncaughtListenerError = (error: unknown) => void;

/** Marks a call production never answers: it runs as the app called it and makes no record. */
export const UNOBSERVED: unique symbol = Symbol('unobserved');

/** What a module's own objects say about one call: the argument that names its account, its project, instance, bucket and path. */
export interface CallContext {
  readonly subject?: unknown;
  readonly projectId?: string;
  readonly instance?: string;
  readonly path?: string;
  /** On a Cloud Storage call: the bucket its reference names. */
  readonly bucket?: string;
  /** On an AI Logic call: the model it asked for. */
  readonly ai?: LiveAiRecord;
  /** When the call started, in ms since epoch, for a result hook that times it. */
  readonly startedAt?: number;
  /** When the call started on the realm's performance timeline (`performance.now()`), for a hook that reads its Resource Timing entries. */
  readonly timelineStart?: number;
  /** On a Cloud Messaging call: the requests it made, once a hook has read them. */
  readonly requests?: readonly LiveRequest[];
  /** On a Firestore, RTDB or Storage write: the value or metadata it wrote. */
  readonly writeData?: LiveWriteValue;
  /** On a Firestore read: the document it returned, once a hook has read it. */
  readonly document?: Readonly<Record<string, unknown>>;
  /** On a Firestore list or listener: the shape of its query. */
  readonly query?: LiveQuery;
  /** On a resolved read: the documents production billed it for, once a hook has counted them. */
  readonly billedDocuments?: number;
  /** Session-scoped observed Firestore/RTDB payloads attached via WeakMap on resolution. */
  readonly sessionData?: ObservedSessionDelta;
  /** Extracted `addDoc` payload awaiting the resolved `DocumentReference.path`. */
  readonly pendingAddDocFields?: {
    readonly data: Record<string, unknown>;
    readonly deleteFields?: readonly string[];
  };
  /** Extracted RTDB `push` payload awaiting the resolved `DatabaseReference` path. */
  readonly pendingPushValue?: {
    readonly value: unknown;
  };
  /** True when an RTDB `get` or `onValue` ran with query constraints rather than on a bare reference. */
  readonly rtdbFilteredQuery?: boolean;
}

/** What a resolved call's value adds to its record, or `UNOBSERVED` when production never answered it. */
export type ResultReading = Pick<CallContext, 'ai' | 'requests' | 'document' | 'billedDocuments' | 'sessionData'> | typeof UNOBSERVED;

/**
 * What a rejected call's error adds to its record: the requests it made and
 * the code production's answer gives, which replaces the module's `codeOf`.
 * `UNOBSERVED` when the SDK failed before any request, so production never
 * answered.
 */
export type RejectionReading = (Pick<CallContext, 'requests'> & { readonly code?: string }) | typeof UNOBSERVED;

/** Reads one call's context from its export name, arguments and `this`, or marks it unobserved. */
export type CallContextOf = (name: string, args: readonly unknown[], self: unknown) => CallContext | typeof UNOBSERVED;

export type Callback = (this: unknown, ...values: unknown[]) => unknown;

/**
 * What a module whose objects differ from Firestore's and Auth's supplies to
 * every wrapper it has. Each is absent for the modules that need none.
 */
export interface ObservedHooks {
  /** Replaces reading the project and account from the first argument. */
  readonly context?: CallContextOf;
  /** Replaces reading a failure's code from the error's `code` or name. */
  readonly codeOf?: (error: unknown) => string;
  /** Replaces reading production's message from the error's `message`. */
  readonly messageOf?: (error: unknown) => string | undefined;
  /** Puts a listener's arguments where the recording callbacks expect them: callback, then error callback. */
  readonly listenerArguments?: (args: unknown[]) => unknown[];
  /**
   * The recording callback for one app callback: one `make` builds, or one
   * already handed the SDK for the same listener, so the SDK can match the
   * app's callback later, as `off()` does.
   */
  readonly listenerCallback?: (name: string, args: readonly unknown[], appCallback: Callback, make: () => Callback) => Callback;
  /**
   * What a listener export's arguments watch. A module that has it gets
   * `attached` and `detached` records for each subscription; undefined for
   * a subscription it cannot name keeps the plain `returned` record.
   */
  readonly listenerOf?: (name: string, args: readonly unknown[]) => ListenerIdentity | undefined;
  /**
   * Told of each subscription that attached, with the function that detaches
   * it, so an export that ends listeners without their unsubscribe, as
   * RTDB's `off()` does, can detach them. Returns what forgets it again.
   */
  readonly listenerAttached?: (name: string, args: readonly unknown[], detach: () => void) => (() => void) | undefined;
  /**
   * Whether a listener subscription detaches itself inside the SDK right after
   * its first delivery, as RTDB's `{ onlyOnce: true }` does without calling
   * `off()` or the returned unsubscribe.
   */
  readonly listenerOnlyOnce?: (args: readonly unknown[]) => boolean;
  /**
   * Reads a one-shot call's resolved value before the app gets it: what it
   * adds to the record, or `UNOBSERVED` to make none. A promise of the
   * reading defers the record until it settles; its rejection is recorded as
   * the call's error, as a stream whose response fails is.
   */
  readonly resultOf?: (site: ObservedSite, value: unknown) => ResultReading | Promise<ResultReading>;
  /**
   * Reads a one-shot call's rejection before the record is made: what it
   * adds, or `UNOBSERVED` to make none. A promise of the reading defers the
   * record until it settles. The app gets the SDK's rejection either way.
   */
  readonly rejectionOf?: (site: ObservedSite, error: unknown) => RejectionReading | Promise<RejectionReading>;
  /**
   * Reads a listener delivery's value to extract bounded session-observed
   * Firestore/RTDB data for the live host's in-memory session store.
   */
  readonly deliveryOf?: (site: ObservedSite, value: unknown) => ObservedSessionDelta | undefined;
  /**
   * Whether a synchronous throw is the SDK's own check, made before any
   * request, as every Storage export's is (a root reference, a bad argument,
   * Node's `getBlob`). Such a throw reaches the app and makes no record.
   */
  readonly throwsLocally?: boolean;
}

/** Where a wrapped export sits: its module and name, and who receives its records. */
export interface ObservedSite extends ObservedHooks {
  readonly module: string;
  readonly name: string;
  readonly observer: LiveObserver;
  /** `'admin'` for a site the Admin rows patched; every record it makes carries it. */
  readonly sdk?: 'admin';
  /** For a resolved read: the documents its result hook counted. */
  readonly billedDocuments?: number;
  /**
   * For a listener export: what the SDK does with an error when the app gave
   * no error callback, done after the error is recorded. Absent means
   * nothing, as Auth and App Check do.
   */
  readonly uncaughtListenerError?: UncaughtListenerError;
  /** The project of the call this site records, read from its arguments. */
  readonly projectId?: string;
  /** For a resolved call: its usage, as the observer measured it. */
  readonly usage?: LiveUsage;
  /** For one listener: counts the documents each delivery was billed for. */
  readonly billing?: BilledDocuments;
  /** The call's first argument, which names the app whose Auth the call runs as. */
  readonly subject?: unknown;
  /** Reads the account a call whose first argument is `subject` runs as. Absent records no account. */
  readonly accountOf?: (subject: unknown) => LiveAccount | undefined;
  /** The SDK's initialized apps (`getApps()` of `firebase/app`), so a factory called with no app finds the default one. */
  readonly apps?: () => readonly unknown[];
  /** For one listener the observer journals: its activity. */
  readonly activity?: LiveListenerActivity;
  /** For one listener with a lifecycle: its id and hashed key. */
  readonly listener?: LiveListenerLifecycle;
  /** For one listener with a lifecycle: records its `detached`, once. */
  readonly endListener?: () => void;
  /** For one listener with a lifecycle: records `attached` once before any synchronous callback fires. */
  readonly ensureAttached?: () => void;
  /** True when the SDK detaches this subscription automatically after its first delivery. */
  readonly detachesOnDelivery?: boolean;
  /** The instance, bucket and path of the call this site records, read by the module's context hook. */
  readonly instance?: string;
  readonly bucket?: string;
  readonly path?: string;
  /** The AI Logic model of the call this site records, and its token counts once read. */
  readonly ai?: LiveAiRecord;
  /** When the call this site records started, in ms since epoch. */
  readonly startedAt?: number;
  /** When the call this site records started, on the realm's performance timeline. */
  readonly timelineStart?: number;
  /** The Cloud Messaging requests the call this site records made. */
  readonly requests?: readonly LiveRequest[];
  /** The value or metadata the write this site records sent. */
  readonly writeData?: LiveWriteValue;
  /** The document the Firestore read this site records returned. */
  readonly document?: Readonly<Record<string, unknown>>;
  /** The shape of the query the Firestore list or listener this site records ran. */
  readonly query?: LiveQuery;
  /** Session-scoped observed Firestore/RTDB payloads attached via WeakMap on resolution. */
  readonly sessionData?: ObservedSessionDelta;
  /** Extracted `addDoc` payload awaiting the resolved `DocumentReference.path`. */
  readonly pendingAddDocFields?: {
    readonly data: Record<string, unknown>;
    readonly deleteFields?: readonly string[];
  };
  /** Extracted RTDB `push` payload awaiting the resolved `DatabaseReference` path. */
  readonly pendingPushValue?: {
    readonly value: unknown;
  };
  /** True when an RTDB `get` or `onValue` ran with query constraints rather than on a bare reference. */
  readonly rtdbFilteredQuery?: boolean;
  /**
   * Whether the export returns a thenable that is not a promise, whose
   * settlement is production's answer, as `push` returns its reference.
   */
  readonly followsThenable?: boolean;
  /**
   * For a followed thenable: whether the SDK handles its own promise's
   * rejection, as Storage's UploadTask does (`this._promise.then(null, () =>
   * {})`), so an app that only listens with `task.on(...)` never sees an
   * unhandled rejection. The followed promise then gets the same no-op handler.
   */
  readonly swallowsRejection?: boolean;
}

/** The longest message a record carries, as long as a host takes. */
export const MAX_MESSAGE_LENGTH = 500;
/**
 * Each email address in a message, which may sit between the segments of a
 * path. The host's reader applies the same pattern (`redactEmails` in
 * `pyric/sandbox/internal`); this file runs in the page, which imports no
 * runtime code from `pyric` or `@pyric/cli`, so it keeps its own copy.
 */
const EMAIL_ANYWHERE = /[^\s@"'/]+@[^\s@"'/]+\.[^\s@"'/]+/g;

const FAILURE_OUTCOMES: ReadonlySet<LiveCallOutcome> = new Set(['threw', 'rejected', 'listener-error']);
const LIFECYCLE_OUTCOMES: ReadonlySet<LiveCallOutcome> = new Set(['attached', 'detached']);

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

/** The error's own string `message`, or undefined. Reading it can throw; the caller catches it. */
function errorMessage(error: unknown): string | undefined {
  const isObject = typeof error === 'object' && error !== null;
  if (!isObject) return undefined;
  const message: unknown = Reflect.get(error, 'message');
  return typeof message === 'string' ? message : undefined;
}

/**
 * The `messageOf` of a module whose errors may quote a credential, as
 * Messaging's quote an FCM token: its records carry no message.
 */
export function noMessage(): undefined {
  return undefined;
}

/**
 * The record's `message` field: what `messageOf` read, each email address
 * written `[email]`, cut to {@link MAX_MESSAGE_LENGTH}. Nothing when there is
 * no message or reading it threw.
 */
function messageField(site: ObservedSite, error: unknown): { message?: string } {
  try {
    const read = (site.messageOf ?? errorMessage)(error)?.trim();
    if (read === undefined || read === '') return {};
    return { message: read.replace(EMAIL_ANYWHERE, '[email]').slice(0, MAX_MESSAGE_LENGTH) };
  } catch {
    return {};
  }
}

/**
 * The billed documents of a delivered value, or undefined when it is no
 * snapshot or reading it threw. On a resolved call, the count its result
 * hook read, if any.
 */
function billedOf(site: ObservedSite, outcome: LiveCallOutcome, value: unknown): number | undefined {
  if (outcome === 'resolved') return site.billedDocuments;
  const isDelivery = outcome === 'delivered' && site.billing !== undefined;
  if (!isDelivery) return undefined;
  try {
    return site.billing?.(value);
  } catch {
    // A snapshot that throws on read is still recorded; the host counts it once.
    return undefined;
  }
}

/** The site's instance, bucket, path, AI Logic model, Messaging requests and Firestore values and query shape, as a record carries them. */
function placeOf(site: ObservedSite): Pick<LiveCallRecord, 'instance' | 'bucket' | 'path' | 'ai' | 'requests' | 'writeData' | 'document' | 'query'> {
  const instance = site.instance === undefined ? {} : { instance: site.instance };
  const bucket = site.bucket === undefined ? instance : { ...instance, bucket: site.bucket };
  const place = site.path === undefined ? bucket : { ...bucket, path: site.path };
  const ai = site.ai === undefined ? place : { ...place, ai: site.ai };
  const requests = site.requests === undefined ? ai : { ...ai, requests: site.requests };
  const written = site.writeData === undefined ? requests : { ...requests, writeData: site.writeData };
  const returned = site.document === undefined ? written : { ...written, document: site.document };
  return site.query === undefined ? returned : { ...returned, query: site.query };
}

/** `value` is the delivered value or the error, by outcome. */
function buildRecord(site: ObservedSite, outcome: LiveCallOutcome, value: unknown): LiveCallRecord {
  const isFailure = FAILURE_OUTCOMES.has(outcome);
  const named = site.sdk === undefined ? {} : { sdk: site.sdk };
  const project = site.projectId === undefined ? named : { ...named, projectId: site.projectId };
  const account = site.accountOf?.(site.subject);
  const context = { ...(account === undefined ? project : { ...project, account }), ...placeOf(site) };
  const codeOf = site.codeOf ?? errorCode;
  if (isFailure) return { module: site.module, name: site.name, outcome, code: codeOf(value), ...messageField(site, value), ...context };
  const billedDocuments = billedOf(site, outcome, value);
  const billed = billedDocuments === undefined ? {} : { billedDocuments };
  const usage = outcome === 'resolved' && site.usage !== undefined ? { usage: site.usage } : {};
  const isLifecycle = LIFECYCLE_OUTCOMES.has(outcome) && site.listener !== undefined;
  const listener = isLifecycle ? { listener: site.listener } : {};
  const listenerId = outcome === 'delivered' && site.listener !== undefined ? { listenerId: site.listener.id } : {};
  return { module: site.module, name: site.name, outcome, ...context, ...billed, ...usage, ...listener, ...listenerId };
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
 * Where the app's own objects keep its config: a reference or query's
 * `firestore.app`, a Firestore, Auth, Messaging or App Check instance's
 * `app`, or the app itself.
 */
const OPTIONS_PATHS = [
  ['firestore', 'app', 'options'],
  ['app', 'options'],
  ['options'],
] as const;

/** The string the first config on `subject` holds at `field`, read without calling anything of the app's. */
function configString(subject: unknown, field: string): string | undefined {
  for (const path of OPTIONS_PATHS) {
    const value = stringAt(subject, [...path, field]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** The project the first argument's app names, read without calling anything of the app's. */
export function projectOf(args: readonly unknown[]): string | undefined {
  try {
    return configString(args[0], 'projectId');
  } catch {
    // An argument that throws on read names no project; the call is still recorded.
    return undefined;
  }
}

/** The config fields beside the projectId that the check judges. */
type ConfigField = Exclude<ProjectField, 'projectId' | CallTargetField>;

/** A project id's form: lowercase letters, digits and hyphens. */
const PROJECT = '([a-z0-9-]+)';

/** A default RTDB instance's host: `<project>-default-rtdb.firebaseio.com`, or a region's `firebasedatabase.app`. */
const DEFAULT_DATABASE_HOST = new RegExp(`^${PROJECT}-default-rtdb\\.(?:firebaseio\\.com|[a-z0-9-]+\\.firebasedatabase\\.app)$`);

/** A default bucket: `<project>.appspot.com` or `<project>.firebasestorage.app`, with or without `gs://`. */
const DEFAULT_BUCKET = new RegExp(`^(?:gs://)?${PROJECT}\\.(?:appspot\\.com|firebasestorage\\.app)/?$`);

/** A default auth domain: the default Hosting site, `<project>.firebaseapp.com` or `<project>.web.app`. */
const DEFAULT_AUTH_DOMAIN = new RegExp(`^${PROJECT}\\.(?:firebaseapp\\.com|web\\.app)$`);

function databaseHost(databaseURL: string): string | undefined {
  try {
    return new URL(databaseURL).hostname.toLowerCase();
  } catch {
    // A value that is no URL names no instance.
    return undefined;
  }
}

/** An auth domain as a host: without a `:port` or a trailing dot, so `b.firebaseapp.com.:443` is judged as `b.firebaseapp.com`. */
function authHost(authDomain: string): string {
  return authDomain.replace(/:\d*$/, '').replace(/\.$/, '');
}

function projectMatched(pattern: RegExp, value: string | undefined): string | undefined {
  return value === undefined ? undefined : pattern.exec(value.toLowerCase())?.[1];
}

/**
 * How each config field beside the projectId encodes a project: only its
 * default forms do. A custom auth domain, a bucket or RTDB instance with a
 * name of its own, and the emulator encode none, so they cannot be judged.
 */
const CONFIG_PROJECTS: Readonly<Record<ConfigField, (value: string) => string | undefined>> = {
  databaseURL: (value) => projectMatched(DEFAULT_DATABASE_HOST, databaseHost(value)),
  storageBucket: (value) => projectMatched(DEFAULT_BUCKET, value),
  authDomain: (value) => projectMatched(DEFAULT_AUTH_DOMAIN, authHost(value)),
};

const CONFIG_FIELDS = Object.keys(CONFIG_PROJECTS) as ConfigField[];

/** A default RTDB instance, as the SDK's namespace names it: `<project>-default-rtdb`. */
const DEFAULT_INSTANCE = new RegExp(`^${PROJECT}-default-rtdb$`);

/**
 * How the instance or bucket a call reaches encodes a project: only its
 * default forms do. `getDatabase(app, url)`, `getStorage(app, 'gs://...')`
 * and `ref(storage, 'gs://...')` reach one the config does not name. A named
 * instance, a legacy default instance (`<project>.firebaseio.com`, whose
 * namespace looks like a named one), a bucket with a name of its own, and
 * one the SDK reference did not name encode none, so they cannot be judged.
 */
const TARGET_PROJECTS: Readonly<Record<CallTargetField, (value: string) => string | undefined>> = {
  instance: (value) => projectMatched(DEFAULT_INSTANCE, value),
  bucket: (value) => projectMatched(DEFAULT_BUCKET, value),
};

/** One project the app's config names, and the field that names it. */
interface NamedProject {
  readonly field: ProjectField;
  readonly projectId: string;
}

/** The projects the app's databaseURL, storageBucket and authDomain encode, read without calling anything of the app's. */
function configProjects(subject: unknown): NamedProject[] {
  const projects: NamedProject[] = [];
  try {
    for (const field of CONFIG_FIELDS) {
      const value = configString(subject, field);
      const projectId = value === undefined ? undefined : CONFIG_PROJECTS[field](value);
      if (projectId !== undefined) projects.push({ field, projectId });
    }
  } catch {
    // A config that throws on read names no project; the call is judged by what was read.
  }
  return projects;
}

/** The context a module's hook reads, or an empty one when the hook throws: the call is still recorded. */
function hookContext(site: ObservedSite, context: CallContextOf, args: readonly unknown[], self: unknown): CallContext | typeof UNOBSERVED {
  try {
    return context(site.name, args, self);
  } catch {
    return {};
  }
}

/**
 * The site with the project its call's arguments name, and the argument that
 * names its account, or null for a call the module's context hook marks
 * unobserved. A module with a context hook reads all of them from it.
 */
function siteFor(site: ObservedSite, args: readonly unknown[], self: unknown): ObservedSite | null {
  if (site.context === undefined) {
    const projectId = projectOf(args);
    const subject = { ...site, subject: args[0] };
    return projectId === undefined ? subject : { ...subject, projectId };
  }
  const context = hookContext(site, site.context, args, self);
  if (context === UNOBSERVED) return null;
  return { ...site, ...context };
}

/** `firebase/app`'s exports make no request, so a call to another project's app there is never refused. */
const REQUESTLESS_MODULES: ReadonlySet<string> = new Set(['firebase/app']);

/**
 * Every project the call's app names: its projectId, then each project its
 * databaseURL, storageBucket or authDomain encodes. RTDB, Storage and Auth
 * run without a projectId, and those fields can point an app at another
 * project than its projectId, so every field that can be judged is.
 */
function appProjectsOf(callSite: ObservedSite): NamedProject[] {
  const configured = configProjects(callSite.subject);
  const projectId = callSite.projectId;
  return projectId === undefined ? configured : [{ field: 'projectId', projectId }, ...configured];
}

/** The projects the instance and bucket the call reaches encode, as its module's context hook read them. */
function targetProjectsOf(callSite: ObservedSite): NamedProject[] {
  const projects: NamedProject[] = [];
  for (const field of CALL_TARGET_FIELDS) {
    const value = callSite[field];
    const projectId = value === undefined ? undefined : TARGET_PROJECTS[field](value);
    if (projectId !== undefined) projects.push({ field, projectId });
  }
  return projects;
}

/**
 * The refusal of a call whose app, or the instance or bucket it reaches,
 * names another project than the host's, or null when it may run: the
 * observer names no host project, the module makes no request, or every
 * project the app's config and the call's target name, as far as they can
 * be read, is the host's.
 */
function refusedProject(callSite: ObservedSite): Error | null {
  const { hostProjectId, client } = callSite.observer;
  const isUnchecked = hostProjectId === undefined || REQUESTLESS_MODULES.has(callSite.module);
  if (isUnchecked) return null;
  const named = [...appProjectsOf(callSite), ...targetProjectsOf(callSite)];
  const other = named.find((project) => project.projectId !== hostProjectId);
  if (other === undefined) return null;
  return liveProjectRefusal(callSite.name, { field: other.field, appProjectId: other.projectId, hostProjectId }, client);
}

/**
 * The refusal of a factory call that has not run, or null when it may run:
 * judged as a call is, by every project `app`'s config names and then by
 * the instance or bucket its arguments name. `getDatabase` is one: the SDK
 * opens its connection at `ref()`, before any call a wrapper judges, and
 * sends the account's ID token and the App Check token on it.
 */
export function refusedFactory(
  site: Omit<ObservedSite, 'name'>,
  name: string,
  app: unknown,
  target: Pick<ObservedSite, CallTargetField>,
): Error | null {
  const projectId = projectOf([app]);
  const named = projectId === undefined ? {} : { projectId };
  return refusedProject({ module: site.module, observer: site.observer, name, subject: app, ...named, ...target });
}

function ignoreRejection(returned: unknown): void {
  const isPromise = returned instanceof Promise;
  if (isPromise) Promise.prototype.then.call(returned, undefined, () => undefined);
}

/** What the module's result hook reads from a resolved value: an empty reading when it has none, or when it throws. */
function readResult(site: ObservedSite, value: unknown): ResultReading | Promise<ResultReading> {
  const resultOf = site.resultOf;
  if (resultOf === undefined) return {};
  try {
    return resultOf(site, value);
  } catch {
    // A value the hook cannot read is still recorded, without what it would add.
    return {};
  }
}

/** Records one reading of a resolved call, or nothing when production never answered it. */
function reportReading(site: ObservedSite, reading: ResultReading): void {
  if (reading === UNOBSERVED) return;
  const mergedSession = mergeSessionData(site.sessionData, reading.sessionData);
  report({ ...site, ...reading, sessionData: mergedSession }, 'resolved');
}

/** The observer's measure of a resolved value: a fresh copy, or nothing when it does not measure or its measure throws. */
function measuredUsage(site: ObservedSite, value: unknown): Pick<ObservedSite, 'usage'> {
  try {
    const usage = site.observer.measure?.(site.module, site.name, value);
    return usage === undefined ? {} : { usage: { ...usage } };
  } catch {
    // A value the measure cannot read is still recorded, without usage.
    return {};
  }
}

/** Records a resolved call with what its value adds: now, or when a deferred reading settles. */
function reportResolved(resolvedSite: ObservedSite, value: unknown): void {
  const site = { ...resolvedSite, ...measuredUsage(resolvedSite, value) };
  const reading = readResult(site, value);
  const isDeferred = reading instanceof Promise;
  if (!isDeferred) return reportReading(site, reading);
  Promise.prototype.then.call(
    reading,
    (later: ResultReading) => reportReading(site, later),
    (error: unknown) => {
      report(site, 'rejected', error);
    },
  );
}

/** What the module's rejection hook reads from an error: an empty reading when it has none, or when it throws. */
function readRejection(site: ObservedSite, error: unknown): RejectionReading | Promise<RejectionReading> {
  const rejectionOf = site.rejectionOf;
  if (rejectionOf === undefined) return {};
  try {
    return rejectionOf(site, error);
  } catch {
    // An error the hook cannot read is still recorded, with the module's code.
    return {};
  }
}

/** Records one reading of a rejected call, or nothing when production never answered it. */
function reportRejection(site: ObservedSite, error: unknown, reading: RejectionReading): void {
  if (reading === UNOBSERVED) return;
  const { code, ...added } = reading;
  const read = code === undefined ? {} : { codeOf: () => code };
  report({ ...site, ...added, ...read }, 'rejected', error);
}

/** Records a rejected call with what its error adds: now, or when a deferred reading settles. */
function reportRejected(site: ObservedSite, error: unknown): void {
  const reading = readRejection(site, error);
  const isDeferred = reading instanceof Promise;
  if (!isDeferred) return reportRejection(site, error, reading);
  Promise.prototype.then.call(
    reading,
    (later: RejectionReading) => reportRejection(site, error, later),
    () => {
      report(site, 'rejected', error);
    },
  );
}

/** Hands the observer one record, and returns it. Nothing the observer does, or fails to do, reaches the caller. */
function report(site: ObservedSite, outcome: LiveCallOutcome, value?: unknown): LiveCallRecord | undefined {
  try {
    const record = buildRecord(site, outcome, value);
    if (site.sdk !== 'admin') {
      if (outcome === 'resolved') {
        attachSessionData(record, site.sessionData);
      } else if (outcome === 'delivered' && site.deliveryOf !== undefined) {
        try {
          attachSessionData(record, site.deliveryOf(site, value));
        } catch {
          // A delivery hook failure never drops the record.
        }
      }
    }
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
  const isFollowed = !isPromise && site.followsThenable === true && thenOf(result) !== undefined;
  if (isFollowed) return followThenable(site, result as object);
  if (!isPromise) {
    report(site, 'returned');
    return result;
  }
  return Promise.prototype.then.call(
    result,
    (value: unknown) => {
      reportResolved(site, value);
      return value;
    },
    (error: unknown) => {
      reportRejected(site, error);
      throw error;
    },
  );
}

/** A thenable's own `then`, or undefined for any other value. */
function thenOf(value: unknown): Callback | undefined {
  const isObject = (typeof value === 'object' || typeof value === 'function') && value !== null;
  if (!isObject) return undefined;
  const then: unknown = Reflect.get(value, 'then');
  return typeof then === 'function' ? (then as Callback) : undefined;
}

/**
 * Records a thenable's settlement and hands the app the same object, its
 * `then` and `catch` replaced with those of a promise that follows it, the
 * way the SDK built them from its own promise. The SDK's promise is then
 * handled here, and the app's handling of the object decides whether a
 * rejection is unhandled. An object that refuses the new methods comes back
 * unchanged, and its settlement is still recorded. When the SDK handles its
 * own promise's rejection (`swallowsRejection`), the followed promise is
 * handled too, so the app sees no rejection the SDK would not have raised.
 */
function followThenable(site: ObservedSite, result: object): unknown {
  const then = thenOf(result)!;
  const followed = new Promise<unknown>((resolve, reject) => {
    Reflect.apply(then, result, [resolve, reject]);
  });
  const settled = observeSettlement({ ...site, followsThenable: false }, followed) as Promise<unknown>;
  const settledThen = Promise.prototype.then;
  const isReplaced = Reflect.set(result, 'then', settledThen.bind(settled)) && Reflect.set(result, 'catch', settledThen.bind(settled, undefined));
  const isSwallowed = !isReplaced || site.swallowsRejection === true;
  if (isSwallowed) ignoreRejection(settled);
  return result;
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

/**
 * The state an Admin SDK document snapshot shows: its `exists` getter, and
 * data that is never compared. Its `data()` can run the app's converter, and
 * the Admin SDK raises no snapshot for a metadata change only, so every
 * delivery counts as changed. Undefined for any other value.
 */
function adminDocumentState(value: unknown): DocumentState | undefined {
  const isObject = typeof value === 'object' && value !== null;
  const shown: unknown = isObject ? Reflect.get(value, 'exists') : undefined;
  const isAdminDocument = typeof shown === 'boolean' && methodOf(value, 'data') !== undefined;
  return isAdminDocument ? { exists: shown, data: UNCOMPARABLE } : undefined;
}

/** What a document snapshot shows, or undefined for any other value. */
function documentState(value: unknown): DocumentState | undefined {
  const exists = methodOf(value, 'exists');
  const data = methodOf(value, 'data');
  const isDocument = exists !== undefined && data !== undefined;
  if (!isDocument) return adminDocumentState(value);
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
    if (site.throwsLocally !== true) report(site, 'threw', error);
    throw error;
  }
  return observeSettlement(site, result);
}

/** A wrapper for a one-shot export: reads, writes, sign-in and token calls. */
export function observedCall(site: ObservedSite, real: Callback): Callback {
  return function observed(this: unknown, ...args: unknown[]): unknown {
    const callSite = siteFor(site, args, this);
    if (callSite === null) return Reflect.apply(real, this, args);
    const refusal = refusedProject(callSite);
    if (refusal !== null) throw refusal;
    return callReal(callSite, real, this, args);
  };
}

/**
 * Records that the SDK ended the listener: it is handed one error and then
 * stops, so the app's later unsubscribe records nothing more.
 */
function endListener(site: ObservedSite): void {
  try {
    site.endListener?.();
  } catch {
    // Recording never changes what the app sees.
  }
}

/** Tells the journal the listener closed. A journal failure never reaches the app. */
function closeActivity(site: ObservedSite): void {
  try {
    site.activity?.close();
  } catch {
    // The journal is a diagnostic; the SDK still ended the listener.
  }
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
    site.ensureAttached?.();
    const record = report(site, outcome, values[0]);
    const callApp = (): unknown => Reflect.apply(callback, this, values);
    const isDelivery = outcome === 'delivered';
    if (isDelivery) {
      if (site.detachesOnDelivery === true) {
        queueMicrotask(() => {
          endListener(site);
          closeActivity(site);
        });
      }
      return deliverThrough(site, values[0], record?.billedDocuments, callApp);
    }
    journalFailure(site);
    endListener(site);
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
    endListener(site);
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
  copy[nextIndex] = deliveryCallback(site, args, first as Callback);
  copy[nextIndex + 1] = errorSlot(site, copy[nextIndex + 1]);
  return copy;
}

/** The recording callback for the app's delivery callback: the module's own choice, when it has a hook, else a new one. */
function deliveryCallback(site: ObservedSite, args: readonly unknown[], appCallback: Callback): Callback {
  const make = () => recordingCallback(site, 'delivered', appCallback);
  const choose = site.listenerCallback;
  if (choose === undefined) return make();
  try {
    return choose(site.name, args, appCallback, make);
  } catch {
    return make();
  }
}

/** The listener's arguments as the module's hook places them, or as the app passed them. */
function listenerArguments(site: ObservedSite, args: unknown[]): unknown[] {
  const place = site.listenerArguments;
  if (place === undefined) return args;
  try {
    return place(args);
  } catch {
    return args;
  }
}

/**
 * A wrapper for a listener export: `onSnapshot`, `onAuthStateChanged`,
 * `onTokenChanged`, `onValue`. A listener the module's `listenerOf` hook
 * names records `attached` at subscribe, in place of `returned`, and
 * `detached` once when it ends.
 */
export function observedListener(site: ObservedSite, real: Callback): Callback {
  const lifecycleHooks = { report, closeActivity, endListener };
  return function observed(this: unknown, ...args: unknown[]): unknown {
    const callSite = siteFor(site, args, this);
    if (callSite === null) return Reflect.apply(real, this, args);
    const refusal = refusedProject(callSite);
    if (refusal !== null) throw refusal;
    const activity = openActivity(site.observer, site.name, args);
    const lifecycle = createListenerLifecycle(callSite, args, lifecycleHooks);
    const listenerSite: ObservedSite = { ...callSite, billing: billedDocuments(), activity, ...lifecycle?.fields };
    const listening = recordingArguments(listenerSite, listenerArguments(site, args));
    let unsubscribe: unknown;
    try {
      unsubscribe = lifecycle === undefined
        ? callReal(callSite, real, this, listening)
        : subscribeWithLifecycle(listenerSite, lifecycle, { real, self: this, args: listening, appArgs: args }, report);
    } catch (error) {
      journalFailure(listenerSite);
      throw error;
    }
    const ending = lifecycle === undefined ? unsubscribe : wrapEndingUnsubscribe(listenerSite, unsubscribe, endListener);
    return activity === undefined ? ending : closingUnsubscribe(activity, ending);
  };
}
